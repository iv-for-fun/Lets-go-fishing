// enrichment.js — Spot enrichment pipeline (AI Research Agent, issue #33)
// ---------------------------------------------------------------------------
// Currently implemented: Georgia DNR-style state enrichment with perimeter-
// scoped loading. On each search we determine which US states the drive-time
// search circle actually touches (via data/us-states-borders.geojson), then
// fetch ONLY those states' DNR files (data/dnr/{ABBR}.json) and coalesce them.
// A 50-state dataset therefore never loads in full — only what's near the user.
//
// Everything here is defensively guarded: a missing borders file, missing
// manifest, missing state file, or a malformed record must never throw into
// the search pipeline. app.js also calls every entry point behind a
// `typeof fn === 'function'` guard, so the whole module is optional.
//
// Loaded via <script src="enrichment.js"> BEFORE app.js.

const DNR_DIR          = './data/dnr';
const STATE_BORDERS_URL = './data/us-states-borders.geojson';

// In-memory session caches (per PRD §4.6 caching notes)
let _bordersCache  = null;   // parsed GeoJSON FeatureCollection
let _manifestCache = null;   // { states: ["GA", ...] }
const _dnrStateCache = {};   // abbr -> normalized records array

// ---------------------------------------------------------------------------
// Geometry helpers (self-contained so enrichment.js doesn't depend on app.js
// load order for parsing).
// ---------------------------------------------------------------------------
function _dnrHaversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bounding box [minLng, minLat, maxLng, maxLat] for a Polygon/MultiPolygon.
function _geometryBBox(geometry) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const scan = ring => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  };
  if (geometry.type === 'Polygon') geometry.coordinates.forEach(scan);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(poly => poly.forEach(scan));
  return [minLng, minLat, maxLng, maxLat];
}

// Shortest distance (miles) from a point to a lat/lng bounding box. 0 if inside.
function _distanceToBBoxMiles(lat, lng, bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const clampedLng = Math.max(minLng, Math.min(lng, maxLng));
  const clampedLat = Math.max(minLat, Math.min(lat, maxLat));
  return _dnrHaversineMiles(lat, lng, clampedLat, clampedLng);
}

// Ray-casting point-in-polygon over a Polygon/MultiPolygon's outer rings.
function _pointInGeometry(lat, lng, geometry) {
  const inRing = ring => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  if (geometry.type === 'Polygon') return inRing(geometry.coordinates[0] || []);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(poly => inRing(poly[0] || []));
  return false;
}

// Min distance (miles) from a point to any EDGE of a Polygon/MultiPolygon.
// Uses point-to-segment distance in a local equirectangular projection (lng
// scaled by cos(lat)), accurate to ~1% at these ranges. Point-to-segment (not
// point-to-vertex) is required so a point near the middle of a long simplified
// border segment isn't wrongly reported as far away.
const _MI_PER_DEG = 69.0;

function _pointSegMiles(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function _minEdgeDistanceMiles(lat, lng, geometry) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  const px = lng * cosLat * _MI_PER_DEG, py = lat * _MI_PER_DEG;
  let min = Infinity;
  const scanRing = ring => {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = ring[i][0] * cosLat * _MI_PER_DEG,     ay = ring[i][1] * _MI_PER_DEG;
      const bx = ring[i + 1][0] * cosLat * _MI_PER_DEG, by = ring[i + 1][1] * _MI_PER_DEG;
      const d = _pointSegMiles(px, py, ax, ay, bx, by);
      if (d < min) min = d;
    }
  };
  if (geometry.type === 'Polygon') geometry.coordinates.forEach(scanRing);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(poly => poly.forEach(scanRing));
  return min;
}

// ---------------------------------------------------------------------------
// Perimeter → states
// ---------------------------------------------------------------------------
async function _loadStateBorders() {
  if (_bordersCache !== null) return _bordersCache;
  try {
    const res = await fetch(STATE_BORDERS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    _bordersCache = Array.isArray(json.features) ? json : { features: [] };
  } catch (err) {
    console.warn('[DNR] state borders unavailable:', err.message);
    _bordersCache = { features: [] };
  }
  return _bordersCache;
}

// Sync core: which state abbrs' polygons fall within `radiusMiles` of the point.
// Uses a distance-to-bounding-box test — cheap, and slightly over-inclusive
// (safe: better to load one extra adjacent state than to miss one).
function _statesInPerimeter(borders, lat, lng, radiusMiles) {
  const out = [];
  for (const f of (borders.features || [])) {
    const abbr = f.properties && f.properties.abbr;
    if (!abbr || !f.geometry) continue;
    // Cheap bbox reject first; then confirm with real geometry so a state whose
    // bounding box merely straddles the point (but whose land is far away) is
    // not falsely included.
    if (_distanceToBBoxMiles(lat, lng, _geometryBBox(f.geometry)) > radiusMiles) continue;
    if (_pointInGeometry(lat, lng, f.geometry) || _minEdgeDistanceMiles(lat, lng, f.geometry) <= radiusMiles) out.push(abbr);
  }
  return out;
}

// Async convenience wrapper.
async function statesInPerimeter(lat, lng, radiusMiles) {
  const borders = await _loadStateBorders();
  return _statesInPerimeter(borders, lat, lng, radiusMiles);
}

// ---------------------------------------------------------------------------
// DNR data loading (manifest-driven so we never fire 404s for states with no
// data file).
// ---------------------------------------------------------------------------
async function _loadDNRManifest() {
  if (_manifestCache !== null) return _manifestCache;
  try {
    const res = await fetch(`${DNR_DIR}/index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    _manifestCache = { states: Array.isArray(json.states) ? json.states : [] };
  } catch (err) {
    console.warn('[DNR] manifest unavailable:', err.message);
    _manifestCache = { states: [] };
  }
  return _manifestCache;
}

async function _loadDNRForState(abbr) {
  if (_dnrStateCache[abbr]) return _dnrStateCache[abbr];
  try {
    const res = await fetch(`${DNR_DIR}/${abbr}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = Array.isArray(json.records) ? json.records : [];
    _dnrStateCache[abbr] = raw.map(r => normalizeDNRRecord(r, abbr)).filter(Boolean);
  } catch (err) {
    console.warn(`[DNR] ${abbr} data unavailable:`, err.message);
    _dnrStateCache[abbr] = [];
  }
  return _dnrStateCache[abbr];
}

// Normalize a raw DNR record into the standard shape, filling defaults so
// downstream code can rely on every field existing.
function normalizeDNRRecord(r, stateAbbr) {
  if (!r || !r.coordinates || typeof r.coordinates.lat !== 'number' || typeof r.coordinates.lng !== 'number') return null;
  const a = r.amenities || {};
  return {
    dnrId: r.dnrId || `${stateAbbr}-${(r.name || 'spot').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: r.name || 'DNR Public Access',
    state: stateAbbr,
    waterbody: r.waterbody || r.name || '',
    county: r.county || '',
    acres: r.acres || null,
    status: r.status || 'Public',
    operator: r.operator || '',
    phone: r.phone || '',
    coordinates: { lat: r.coordinates.lat, lng: r.coordinates.lng },
    accessibility: r.accessibility || 'Clear Bank',
    rampType: r.rampType || '',
    numLanes: r.numLanes || null,
    amenities: {
      restrooms: !!a.restrooms, restroomsADA: !!a.restroomsADA,
      parking: !!a.parking, parkingADA: !!a.parkingADA, dockADA: !!a.dockADA,
      camping: !!a.camping, baitShop: !!a.baitShop, equipmentRental: !!a.equipmentRental,
      loanPole: !!a.loanPole, kidsProgram: !!a.kidsProgram, picnicArea: !!a.picnicArea
    },
    confirmedSpecies: Array.isArray(r.confirmedSpecies) ? r.confirmedSpecies : [],
    fees: r.fees || { parking: 'Check Locally', fishing: 'License May Be Required' },
    fishing: {
      motorRestrictions: (r.fishing && r.fishing.motorRestrictions) || 'None listed',
      yearRound: !(r.fishing && r.fishing.yearRound === false),
      bankFishing: !(r.fishing && r.fishing.bankFishing === false),
      pier: !!(r.fishing && r.fishing.pier)
    },
    moreInfo: r.moreInfo || '',
    infoLink: r.infoLink || ''
  };
}

// ---------------------------------------------------------------------------
// Entry point: coalesce DNR records for every state within the drive-time
// perimeter. Returns a flat array of normalized records (possibly empty).
// ---------------------------------------------------------------------------
async function enrichFromDNR(lat, lng, radiusMiles) {
  try {
    const states = await statesInPerimeter(lat, lng, radiusMiles);
    if (!states.length) return [];
    const manifest = await _loadDNRManifest();
    const wanted = states.filter(s => manifest.states.indexOf(s) >= 0);
    if (!wanted.length) return [];
    const perState = await Promise.all(wanted.map(_loadDNRForState));
    return perState.reduce((acc, recs) => acc.concat(recs || []), []);
  } catch (err) {
    console.warn('[DNR] enrichFromDNR failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Matching / merging DNR records into Overpass results
// ---------------------------------------------------------------------------
const _DNR_STOP_WORDS = { lake: 1, park: 1, area: 1, pfa: 1, wma: 1, public: 1, fishing: 1, the: 1, at: 1, of: 1, state: 1, county: 1, creek: 1, pond: 1 };

function _nameTokens(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t && !_DNR_STOP_WORDS[t]);
}

// Jaccard similarity on significant tokens.
function _nameSimilarity(a, b) {
  const ta = _nameTokens(a), tb = _nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let inter = 0;
  for (const t of new Set(ta)) if (setB.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union ? inter / union : 0;
}

// Best DNR record for an Overpass loc: within ~3 km AND name-similar.
function matchDNRRecord(loc, dnrRecords) {
  if (!loc || !loc.coordinates || !Array.isArray(dnrRecords)) return null;
  let best = null, bestSim = 0;
  for (const d of dnrRecords) {
    if (!d.coordinates) continue;
    if (_dnrHaversineMiles(loc.coordinates.lat, loc.coordinates.lng, d.coordinates.lat, d.coordinates.lng) > 1.864) continue; // ~3 km
    const sim = _nameSimilarity(loc.name, d.name);
    if (sim >= 0.5 && sim > bestSim) { best = d; bestSim = sim; }
  }
  return best;
}

// Merge a matched DNR record into an existing Overpass loc.
function mergeDNRIntoLoc(loc, d) {
  const species = Array.isArray(loc.targetSpecies) ? loc.targetSpecies.slice() : [];
  (d.confirmedSpecies || []).forEach(s => { if (species.indexOf(s) < 0) species.push(s); });
  const amenities = Object.assign({}, loc.amenities, {
    restrooms: (loc.amenities && loc.amenities.restrooms) || d.amenities.restrooms,
    picnicTables: (loc.amenities && loc.amenities.picnicTables) || d.amenities.picnicArea
  });
  return Object.assign({}, loc, { targetSpecies: species, amenities: amenities, fees: d.fees || loc.fees, dnr: d });
}

// Convert a standalone DNR record into a loc object the rest of the app renders.
// Caller (app.js) adds distMiles/estDriveHours/weather/score.
function dnrRecordToLoc(d) {
  return {
    id: d.dnrId,
    name: d.name,
    coordinates: d.coordinates,
    accessibility: d.accessibility || 'Clear Bank',
    amenities: {
      restrooms: !!d.amenities.restrooms,
      playground: false,
      picnicTables: !!d.amenities.picnicArea,
      shadedArea: false
    },
    targetSpecies: (d.confirmedSpecies && d.confirmedSpecies.length) ? d.confirmedSpecies.slice() : ['Bass', 'Bluegill', 'Catfish'],
    fees: d.fees || { parking: 'Check Locally', fishing: 'License May Be Required' },
    region: d.county ? `${d.county} County, ${d.state}` : (d.state || 'DNR'),
    source: 'dnr',
    dnr: d
  };
}

// ---------------------------------------------------------------------------
// DNR Info panel (Amenities tab) — returns '' when the loc has no DNR data.
// ---------------------------------------------------------------------------
function renderDNRPanel(loc) {
  if (!loc || !loc.dnr) return '';
  const d = loc.dnr;
  const flag = (on, label) => `
    <div class="flex items-center gap-2">
      <span class="${on ? 'text-green-600' : 'text-gray-300'}">${on ? '✓' : '✕'}</span>
      <span class="text-[11px] font-bold ${on ? 'text-gray-700' : 'text-gray-400'}">${label}</span>
    </div>`;
  const stats = [
    d.waterbody && `${d.waterbody}`,
    d.acres && `${d.acres.toLocaleString()} acres`,
    d.county && `${d.county} County`,
    d.rampType && `${d.rampType} ramp${d.numLanes ? ` · ${d.numLanes} lanes` : ''}`
  ].filter(Boolean).join(' · ');

  return `
    <div class="mt-6 bg-emerald-50 border border-emerald-100 rounded-xl p-4">
      <div class="flex items-center justify-between mb-2">
        <div class="text-[10px] uppercase font-black text-emerald-700">🏛️ ${d.state} DNR Official Info</div>
        ${d.status ? `<span class="text-[10px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded">${d.status}</span>` : ''}
      </div>
      ${stats ? `<p class="text-[11px] text-emerald-800 font-medium mb-3">${stats}</p>` : ''}
      <div class="grid grid-cols-2 gap-y-1.5 gap-x-3 mb-3">
        ${flag(d.amenities.restroomsADA, 'ADA Restrooms')}
        ${flag(d.amenities.parkingADA, 'ADA Parking')}
        ${flag(d.amenities.dockADA, 'ADA Dock/Pier')}
        ${flag(d.amenities.loanPole, 'Loaner Poles')}
        ${flag(d.amenities.kidsProgram, 'Kids Programs')}
        ${flag(d.amenities.camping, 'Camping')}
      </div>
      ${d.fishing && d.fishing.motorRestrictions ? `<p class="text-[10px] text-emerald-700 mb-1"><span class="font-bold">Motor:</span> ${d.fishing.motorRestrictions}</p>` : ''}
      ${d.confirmedSpecies && d.confirmedSpecies.length ? `<p class="text-[10px] text-emerald-700 mb-2"><span class="font-bold">Confirmed species:</span> ${d.confirmedSpecies.join(', ')}</p>` : ''}
      ${d.phone ? `<p class="text-[10px] text-emerald-700">📞 ${d.phone}</p>` : ''}
      ${d.infoLink ? `<a href="${d.infoLink}" target="_blank" rel="noopener" class="inline-block mt-2 text-[11px] font-bold text-emerald-700 underline">Official DNR page →</a>` : ''}
    </div>`;
}
