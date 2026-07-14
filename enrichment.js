// enrichment.js — perimeter geometry helpers + DNR info panel
// ---------------------------------------------------------------------------
// Historically this module also fetched and fuzzy-matched DNR records into
// live Overpass results at request time (issue #33's AI Research Agent). As
// of Phase 2 of the data re-architecture (issue #36), that merge now happens
// once at build time (tools/build_spots_data.py, issue #35) and is baked
// directly into data/spots/{ABBR}.json, so the live match/merge/loader code
// was removed here — see git history if it's ever needed again.
//
// What remains:
//   - Perimeter geometry helpers + statesInPerimeter(): determine which US
//     states a drive-time search circle touches (via
//     data/us-states-borders.geojson). Reused by spots-loader.js (Phase 2) to
//     scope which pre-built data/spots/{ABBR}.json files to fetch.
//   - renderDNRPanel(): renders the Amenities-tab DNR info panel from a
//     loc.dnr object — now populated by the pre-built merge instead of a live
//     match, but in the same shape, so this keeps working unchanged.
//
// Loaded via <script src="enrichment.js"> BEFORE spots-loader.js/app.js.

const STATE_BORDERS_URL = './data/us-states-borders.geojson';

// In-memory session cache (per PRD §4.6 caching notes)
let _bordersCache  = null;   // parsed GeoJSON FeatureCollection

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
// DNR Info panel (Amenities tab) — returns '' when the loc has no DNR data.
// ---------------------------------------------------------------------------
function renderDNRPanel(loc) {
  if (!loc || !loc.dnr) return '';
  const d = loc.dnr;
  // Same "unknown ≠ absent" principle as the Amenities tab (issue #37): a
  // curated DNR record's amenity flag defaults to false when the source
  // simply didn't record it, not because it's confirmed missing — so an
  // unset flag reads as "not listed," never a hard ✕.
  const flag = (on, label) => `
    <div class="flex items-center gap-2">
      <span class="${on ? 'text-emerald-600' : 'text-gray-300'}">${on ? '✓' : '·'}</span>
      <span class="text-[11px] font-bold ${on ? 'text-gray-700' : 'text-gray-400'}">${label}${on ? '' : ' (not listed)'}</span>
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
