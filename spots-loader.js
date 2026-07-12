// spots-loader.js — Phase 2 runtime: pre-built, perimeter-scoped spot loading
// (issue #36, epic #39; design: docs/MIGRATION_PLAN.md §8).
//
// Replaces the live per-search Overpass call with pre-built, monthly-refreshed
// per-state files (data/spots/{ABBR}.json, produced by tools/build_spots_data.py
// in Phase 1 / issue #35). On each search we determine which states the
// drive-time perimeter touches (reusing enrichment.js's statesInPerimeter),
// load only those states' merged files, and cache them in IndexedDB (6hr TTL —
// these files run into the MBs, too large for localStorage).
//
// If no perimeter state has a pre-built file yet, we fall back to the live
// Overpass query (fetchFishingSpotsNearby, app.js) so a not-yet-built region
// still returns something. Loaded via <script> AFTER enrichment.js and BEFORE
// app.js so app.js's init() can call loadSpotsNearby().

const SPOTS_DIR             = './data/spots';
const SPOTS_DB_NAME         = 'letsGoFishingCache';
const SPOTS_DB_VERSION      = 1;
const SPOTS_STORE           = 'stateSpots';
const SPOTS_CACHE_TTL_MS    = 21600 * 1000; // 6 hours, mirrors app.js's CACHE_TTL

let _spotsManifestCache = null;
let _spotsDbPromise      = null;

// ---------------------------------------------------------------------------
// IndexedDB cache (state abbr -> { abbr, spots, timestamp })
// ---------------------------------------------------------------------------
function _openSpotsDB() {
  if (_spotsDbPromise) return _spotsDbPromise;
  _spotsDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(SPOTS_DB_NAME, SPOTS_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SPOTS_STORE)) db.createObjectStore(SPOTS_STORE, { keyPath: 'abbr' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _spotsDbPromise;
}

async function _getCachedStateSpots(abbr) {
  try {
    const db = await _openSpotsDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(SPOTS_STORE, 'readonly').objectStore(SPOTS_STORE).get(abbr);
      req.onsuccess = () => {
        const rec = req.result;
        if (!rec || (Date.now() - rec.timestamp) > SPOTS_CACHE_TTL_MS) { resolve(null); return; }
        resolve(rec.spots);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // IndexedDB unavailable (private browsing, etc.) — just skip caching
  }
}

async function _setCachedStateSpots(abbr, spots) {
  try {
    const db = await _openSpotsDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SPOTS_STORE, 'readwrite');
      tx.objectStore(SPOTS_STORE).put({ abbr, spots, timestamp: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch { /* IndexedDB unavailable; nothing to do */ }
}

// ---------------------------------------------------------------------------
// Manifest + per-state fetch
// ---------------------------------------------------------------------------
async function _loadSpotsManifest() {
  if (_spotsManifestCache !== null) return _spotsManifestCache;
  try {
    const res = await fetch(`${SPOTS_DIR}/index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    _spotsManifestCache = { states: Array.isArray(json.states) ? json.states : [] };
  } catch (err) {
    console.warn('[Spots] manifest unavailable:', err.message);
    _spotsManifestCache = { states: [] };
  }
  return _spotsManifestCache;
}

async function _loadStateSpots(abbr) {
  const cached = await _getCachedStateSpots(abbr);
  if (cached) return cached;
  try {
    const res = await fetch(`${SPOTS_DIR}/${abbr}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = Array.isArray(json.spots) ? json.spots : [];
    const normalized = raw.map(normalizeSpotRecord).filter(Boolean);
    _setCachedStateSpots(abbr, normalized); // fire-and-forget
    return normalized;
  } catch (err) {
    console.warn(`[Spots] ${abbr} data unavailable:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalize a merged data/spots/{ABBR}.json record into the loc shape the
// rest of the app (scorer.js, app.js rendering) already expects. Self-
// contained (no dependency on app.js's own inference helpers) so this module
// keeps working regardless of script load order.
// ---------------------------------------------------------------------------
function _fallbackSpecies(lat) {
  if (lat > 44) return ['Walleye', 'Northern Pike', 'Perch', 'Bass'];
  if (lat > 39) return ['Largemouth Bass', 'Crappie', 'Bluegill', 'Catfish'];
  if (lat > 34) return ['Largemouth Bass', 'Bluegill', 'Catfish', 'Crappie'];
  return ['Bass', 'Bluegill', 'Catfish', 'Bream'];
}

function _parkingFeeLabel(rec) {
  if (rec.amenities && rec.amenities.parkingFee === true) return 'Fee Required';
  if (rec.fee === 'no') return 'Free';
  return 'Check Locally';
}

function normalizeSpotRecord(rec) {
  if (!rec || !rec.coordinates || typeof rec.coordinates.lat !== 'number' || typeof rec.coordinates.lng !== 'number') return null;
  const a = rec.amenities || {};
  return {
    id: rec.id,
    name: rec.name || 'Fishing Access',
    coordinates: rec.coordinates,
    accessibility: rec.accessibility || 'Clear Bank',
    amenities: {
      restrooms: !!a.restrooms,
      playground: !!a.playground,
      // picnicTables not modeled by the build pipeline yet (deferred, see
      // MIGRATION_PLAN.md §6 / issue #35); shadedArea approximated from shelter.
      picnicTables: false,
      shadedArea: !!a.shelter
    },
    targetSpecies: (Array.isArray(rec.targetSpecies) && rec.targetSpecies.length)
      ? rec.targetSpecies
      : _fallbackSpecies(rec.coordinates.lat),
    fees: { parking: _parkingFeeLabel(rec), fishing: 'License May Be Required' },
    region: rec.region || 'Nearby',
    source: rec.source || 'osm',
    dnr: rec.dnr || null
  };
}

// ---------------------------------------------------------------------------
// Entry point used by app.js in place of the old live fetchFishingSpotsNearby.
// Falls back to live Overpass only if NO perimeter state has a pre-built file
// yet (a not-yet-covered region) — see MIGRATION_PLAN.md §8.
// ---------------------------------------------------------------------------
async function loadSpotsNearby(lat, lng, radiusMiles) {
  try {
    const perimeterStates = await statesInPerimeter(lat, lng, radiusMiles);
    const manifest = await _loadSpotsManifest();
    const covered = perimeterStates.filter(s => manifest.states.indexOf(s) >= 0);
    if (!covered.length) {
      console.warn('[Spots] no pre-built data for this area yet; falling back to live Overpass');
      return await _liveOverpassFallback(lat, lng);
    }
    const perState = await Promise.all(covered.map(_loadStateSpots));
    return perState.reduce((acc, spots) => acc.concat(spots || []), []);
  } catch (err) {
    console.warn('[Spots] pre-built load failed, falling back to live Overpass:', err.message);
    return await _liveOverpassFallback(lat, lng);
  }
}

// Tag live-fallback results distinctly from pre-built ones (both use
// source: 'osm' from normalizeOverpassResults) so the UI's "Live" badge only
// ever appears on spots actually fetched live this search.
async function _liveOverpassFallback(lat, lng) {
  const spots = await fetchFishingSpotsNearby(lat, lng, true);
  return spots.map(s => (s.source === 'osm' ? { ...s, source: 'osm-live' } : s));
}
