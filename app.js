// app.js — Main application logic
// LOCATION RESOLUTION RULES (strictly enforced):
//   1. If the user types a specific place (address, city, landmark, POI),
//      geocode it via Nominatim with addressdetails so we get the canonical
//      centroid that Google Maps would use, then use ONLY those coords.
//   2. GPS / Geolocation is used ONLY when locationInput is blank OR
//      the user explicitly types "current" or "current location".
//   3. Atlanta fallback is last-resort only — never used if the user
//      typed something or if GPS succeeds.
//   4. All distance calculations and Overpass queries use the resolved
//      origin coords exclusively — no mixing of GPS + typed values.
//
// DATA FRESHNESS GUARANTEE:
//   Every explicit "Find Spots" click busts both the weather and spots caches
//   for the resolved coordinates, so all detail-view data always reflects
//   the current location and the freshest available API data.

const CACHE_TTL = 21600; // 6 hours in seconds
const ATLANTA_FALLBACK = { lat: 33.749, lng: -84.388 };
const OVERPASS_RADIUS_M = 120000;

// In-memory cache for the fallback spots JSON (loaded once at startup)
let _fallbackSpotsCache = null;

// ---------------------------------------------------------------------------
// Fallback spots — loaded from data/locations.json (issue #8)
// ---------------------------------------------------------------------------
async function loadFallbackSpots() {
  if (_fallbackSpotsCache !== null) return _fallbackSpotsCache;
  try {
    const res = await fetch('./data/locations.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    _fallbackSpotsCache = Array.isArray(json.spots) ? json.spots : [];
    console.log(`[loadFallbackSpots] loaded ${_fallbackSpotsCache.length} curated spots`);
  } catch (err) {
    console.warn('[loadFallbackSpots] failed to load data/locations.json:', err.message);
    _fallbackSpotsCache = [];
  }
  return _fallbackSpotsCache;
}

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------
function isCurrentLocationRequest(input) {
  if (!input || input.trim() === '') return true;
  const v = input.trim().toLowerCase();
  return v === 'current' || v === 'current location';
}

async function getGpsLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject('Geolocation not supported');
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => reject('Location denied')
    );
  });
}

async function geocodeTypedLocation(locationString) {
  try {
    const url = `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(locationString.trim())}` +
      `&format=json&limit=1&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LetsGoFishingApp/1.0 (kid-friendly fishing finder)' }
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.length === 0) throw new Error(`No results for: ${locationString}`);
    const place = data[0];
    return { lat: parseFloat(place.lat), lng: parseFloat(place.lon), displayName: place.display_name || locationString };
  } catch (err) {
    console.warn('[geocodeTypedLocation] failed:', err.message);
    return null;
  }
}

function haversineDistance(coord1, coord2) {
  const R = 3958.8;
  const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
  const dLng = (coord2.lng - coord1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
function coordKey(lat, lng) { return `${lat.toFixed(3)}_${lng.toFixed(3)}`; }

function getCached(key) {
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;
    const { data, timestamp } = JSON.parse(item);
    if ((Date.now() / 1000) - timestamp > CACHE_TTL) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}

function setCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() / 1000 })); } catch { }
}

function bustCacheForCoords(lat, lng) {
  const key = coordKey(lat, lng);
  try { localStorage.removeItem(`weather_${key}`); localStorage.removeItem(`spots_${key}`); } catch { }
}

// ---------------------------------------------------------------------------
// Saved Spots — localStorage-backed
// ---------------------------------------------------------------------------
function getSavedSpots() {
  try { return JSON.parse(localStorage.getItem('savedSpots') || '[]'); } catch { return []; }
}

function isSpotSaved(id) {
  return getSavedSpots().some(s => s.id === id);
}

function saveSpot(loc) {
  const spots = getSavedSpots();
  if (!spots.find(s => s.id === loc.id)) {
    spots.push(loc);
    localStorage.setItem('savedSpots', JSON.stringify(spots));
  }
  refreshSaveButtonState(loc.id);
}

function unsaveSpot(id) {
  const spots = getSavedSpots().filter(s => s.id !== id);
  localStorage.setItem('savedSpots', JSON.stringify(spots));
  refreshSaveButtonState(id);
  // If saved view is active, re-render it
  const savedView = document.getElementById('savedView');
  if (savedView && savedView.style.display !== 'none') renderSavedSpots();
}

function toggleSave(locId, event) {
  if (event) event.stopPropagation();
  const loc = allResults.find(l => l.id === locId) || getSavedSpots().find(l => l.id === locId);
  if (!loc) return;
  if (isSpotSaved(locId)) { unsaveSpot(locId); } else { saveSpot(loc); }
}

function refreshSaveButtonState(locId) {
  document.querySelectorAll(`[data-save-id="${locId}"]`).forEach(btn => {
    const saved = isSpotSaved(locId);
    btn.innerHTML = saved
      ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M5 5a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 19V5z"/></svg>'
      : '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>';
    btn.title = saved ? 'Remove from saved' : 'Save this spot';
    btn.className = saved
      ? 'p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-green-600 hover:text-green-800 transition-colors'
      : 'p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-green-600 transition-colors';
  });
}

function renderSavedSpots() {
  const container = document.getElementById('savedContainer');
  if (!container) return;
  const spots = getSavedSpots();
  if (spots.length === 0) {
    container.innerHTML = `
      <div class="text-center py-16 text-gray-400">
        <div class="text-4xl mb-3">🔖</div>
        <p class="font-bold text-sm">No saved spots yet.</p>
        <p class="text-xs mt-1">Tap the bookmark icon on any spot to save it.</p>
      </div>`;
    return;
  }
  container.innerHTML = spots.map(loc => `
    <div class="bg-white rounded-xl shadow-sm border p-4 flex gap-3 items-center">
      <div onclick="showDetailView('${loc.id}')" class="w-14 h-14 bg-gray-100 rounded-lg flex items-center justify-center text-2xl cursor-pointer flex-shrink-0">
        ${loc.accessibility === 'Dock' ? '🛶' : '🏖️'}
      </div>
      <div class="flex-1 min-w-0" onclick="showDetailView('${loc.id}')" style="cursor:pointer">
        <h3 class="font-bold text-gray-800 text-sm leading-tight truncate">${loc.name}</h3>
        <p class="text-[11px] text-gray-500 mt-0.5">${loc.region}</p>
        <div class="flex gap-1 mt-1.5">
          ${(loc.targetSpecies || []).slice(0, 2).map(s => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-bold uppercase">${s}</span>`).join('')}
        </div>
      </div>
      <button data-save-id="${loc.id}" onclick="toggleSave('${loc.id}', event)"
        class="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-green-600 hover:text-green-800 transition-colors"
        title="Remove from saved">
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M5 5a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 19V5z"/></svg>
      </button>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Weather fetch
// ---------------------------------------------------------------------------
async function fetchWeather(lat, lng, forceRefresh = false) {
  const hasKey = typeof CONFIG !== 'undefined' &&
    CONFIG.OPENWEATHER_API_KEY && CONFIG.OPENWEATHER_API_KEY.length > 10;
  if (!hasKey) return { tempF: 68, pressureHpa: 1016, usingFallback: true };

  const cacheKey = `weather_${coordKey(lat, lng)}`;
  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${lat}&lon=${lng}&appid=${CONFIG.OPENWEATHER_API_KEY}&units=imperial`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OWM error: ${res.status}`);
    const json = await res.json();
    const data = {
      tempF: json.main.temp,
      pressureHpa: json.main.pressure,
      description: json.weather?.[0]?.description || '',
      windMph: json.wind?.speed || 0,
      humidity: json.main.humidity || 0
    };
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.warn('Weather fetch failed, using fallback:', err);
    return { tempF: 68, pressureHpa: 1016, usingFallback: true };
  }
}

// ---------------------------------------------------------------------------
// Overpass API
// ---------------------------------------------------------------------------
async function fetchFishingSpotsNearby(lat, lng, forceRefresh = false) {
  const cacheKey = `spots_${coordKey(lat, lng)}`;
  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const query = `
[out:json][timeout:25];
(
  node["leisure"="fishing"](around:${OVERPASS_RADIUS_M},${lat},${lng});
  node["sport"="fishing"](around:${OVERPASS_RADIUS_M},${lat},${lng});
  node["amenity"="fishing"](around:${OVERPASS_RADIUS_M},${lat},${lng});
  way["leisure"="fishing"](around:${OVERPASS_RADIUS_M},${lat},${lng});
  way["sport"="fishing"](around:${OVERPASS_RADIUS_M},${lat},${lng});
  node["natural"="water"]["fishing"](around:${OVERPASS_RADIUS_M},${lat},${lng});
  way["natural"="water"]["name"](around:${OVERPASS_RADIUS_M},${lat},${lng});
  relation["leisure"="park"]["name"](around:${OVERPASS_RADIUS_M},${lat},${lng});
);
out center 60;
`;

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query)
    });
    if (!res.ok) throw new Error(`Overpass error: ${res.status}`);
    const json = await res.json();
    const spots = normalizeOverpassResults(json.elements);
    if (spots.length > 0) setCache(cacheKey, spots);
    return spots;
  } catch (err) {
    console.warn('Overpass fetch failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalize OSM elements
// ---------------------------------------------------------------------------
function normalizeOverpassResults(elements) {
  const seen = new Set();
  const results = [];
  for (const el of elements) {
    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;
    if (!elLat || !elLng) continue;
    const tags = el.tags || {};
    const name = tags.name || tags['name:en'] || null;
    if (!name) continue;
    const nameKey = name.toLowerCase().trim();
    if (seen.has(nameKey)) continue;
    seen.add(nameKey);

    let accessibility = 'Clear Bank';
    if (tags.man_made === 'pier' || tags.man_made === 'jetty') accessibility = 'Dock';
    else if (tags.leisure === 'fishing' && tags.fishing === 'dock') accessibility = 'Dock';

    const amenities = {
      restrooms: !!(tags.toilets || tags['toilets:disposal'] || tags.amenity === 'toilets'),
      playground: !!(tags.playground || tags.leisure === 'playground'),
      picnicTables: !!(tags.leisure === 'picnic_table' || tags.amenity === 'picnic_site' || tags.picnic_table === 'yes'),
      shadedArea: !!(tags.natural === 'wood' || tags.natural === 'tree_row' || tags.landuse === 'forest')
    };

    const fishTag = tags.fish || tags.species || '';
    const targetSpecies = fishTag
      ? fishTag.split(';').map(s => s.trim()).filter(Boolean)
      : inferSpecies(elLat);

    const fees = {
      parking: tags.fee ? `$${tags.fee}` : (tags['fee:parking'] || 'Check Locally'),
      fishing: tags['fishing:license'] || 'License May Be Required'
    };

    const region = [tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ') || inferRegionLabel(elLat);

    results.push({
      id: `osm-${el.type}-${el.id}`,
      name, coordinates: { lat: elLat, lng: elLng },
      accessibility, amenities, targetSpecies, fees, region, source: 'osm'
    });
  }
  return results;
}

function inferSpecies(lat) {
  if (lat > 44) return ['Walleye', 'Northern Pike', 'Perch', 'Bass'];
  if (lat > 39) return ['Largemouth Bass', 'Crappie', 'Bluegill', 'Catfish'];
  if (lat > 34) return ['Largemouth Bass', 'Bluegill', 'Catfish', 'Crappie'];
  return ['Bass', 'Bluegill', 'Catfish', 'Bream'];
}

function inferRegionLabel(lat) {
  if (lat > 45) return 'Northern Region';
  if (lat > 40) return 'Midwest / Mid-Atlantic';
  if (lat > 35) return 'Southeast';
  if (lat > 30) return 'Deep South';
  return 'Gulf Coast / South';
}

// ---------------------------------------------------------------------------
// Gear guide
// ---------------------------------------------------------------------------
const GEAR_DB = {
  beginner: {
    default:           { rod: '4ft Zebco spin-cast (Dock Demon)',    line: '6lb mono',  rig: 'Small bobber, #8 gold hook',        bait: 'red wigglers or corn' },
    'Bluegill':        { rod: '4ft Zebco spin-cast (Dock Demon)',    line: '6lb mono',  rig: 'Small bobber, #8 gold hook',        bait: 'red worms or crickets' },
    'Bream':           { rod: '4ft Zebco spin-cast (Dock Demon)',    line: '6lb mono',  rig: 'Small bobber, #8 gold hook',        bait: 'red worms or crickets' },
    'Crappie':         { rod: '4ft Zebco spin-cast',                 line: '6lb mono',  rig: 'Small bobber, #6 hook, split shot', bait: 'small minnow or jig (1/32oz)' },
    'Catfish':         { rod: '5ft medium spin-cast',                line: '10lb mono', rig: 'Bottom rig, #4 circle hook',        bait: 'chicken liver or nightcrawlers' },
    'Bass':            { rod: '4.5ft light spin-cast',               line: '8lb mono',  rig: 'Wacky rig or small spinner',        bait: 'plastic worm or curly tail grub' },
    'Largemouth Bass': { rod: '4.5ft light spin-cast',               line: '8lb mono',  rig: 'Wacky rig or small inline spinner', bait: 'plastic worm or live shiner' },
    'Walleye':         { rod: '5ft medium spin-cast',                line: '8lb mono',  rig: 'Slip bobber, #4 hook',              bait: 'nightcrawler on a plain hook' },
    'Northern Pike':   { rod: '5ft medium-heavy spin-cast',          line: '14lb mono', rig: 'Wire leader, #2 treble hook',       bait: 'large shiner or flashy spoon' },
    'Perch':           { rod: '4ft light spin-cast',                 line: '6lb mono',  rig: 'Small bobber, #8 hook',             bait: 'small minnow or waxworm' },
    'Striped Bass':    { rod: '5ft medium spin-cast',                line: '12lb mono', rig: 'Float rig, #2 hook',                bait: 'live shad or cut bait' },
    'Snook':           { rod: '5ft medium spin-cast',                line: '12lb mono', rig: 'Float rig, #1/0 hook',              bait: 'live shrimp or pilchard' },
    'Redfish':         { rod: '5ft medium spin-cast',                line: '15lb mono', rig: 'Carolina rig, #2/0 circle hook',    bait: 'cut mullet or live shrimp' },
    'Sheepshead':      { rod: '4ft light spin-cast',                 line: '8lb mono',  rig: 'Popping cork, #2 hook',             bait: 'fiddler crab or barnacles' },
    'Flounder':        { rod: '5ft medium spin-cast',                line: '10lb mono', rig: 'Jig head, 1/4oz',                   bait: 'live minnow or gulp shrimp' },
  },
  pro: {
    default:           { rod: "5'6\" medium-light spinning combo",  line: '8lb mono',   rig: '1/8oz rooster tail or Senko worm', bait: 'soft plastic worms near structure' },
    'Bluegill':        { rod: "5' ultralight spinning",             line: '4lb fluoro', rig: '1/32oz jig head',                  bait: 'small tube or twister tail' },
    'Bream':           { rod: "5' ultralight spinning",             line: '4lb fluoro', rig: '1/32oz jig head',                  bait: 'small tube or cricket on a hook' },
    'Crappie':         { rod: "6' light spinning",                  line: '6lb fluoro', rig: '1/16oz marabou jig',               bait: 'crappie tube or small minnow' },
    'Catfish':         { rod: "6'6\" medium-heavy spinning",        line: '17lb mono',  rig: 'Slip sinker rig, #1 circle hook',  bait: 'stink bait or cut shad' },
    'Bass':            { rod: "6' medium spinning",                 line: '10lb fluoro', rig: '3/16oz Texas-rig',                bait: '4\" plastic worm or Senko' },
    'Largemouth Bass': { rod: "6'6\" medium baitcaster or spinning",line: '12lb fluoro', rig: '1/4oz jig or Texas-rig',          bait: 'creature bait or swim jig near cover' },
    'Walleye':         { rod: "6' medium spinning",                 line: '8lb fluoro', rig: '1/4oz jig head',                   bait: '3\" paddle tail swimbait or live crawler' },
    'Northern Pike':   { rod: "6'6\" medium-heavy spinning",        line: '20lb braid + wire leader', rig: 'Inline spinner or swim bait', bait: '5\" swimbait or large spoon' },
    'Perch':           { rod: "5' light spinning",                  line: '6lb mono',  rig: '1/16oz jig or drop shot',           bait: 'small minnow or perch eye' },
    'Striped Bass':    { rod: "7' medium-heavy spinning",           line: '20lb braid', rig: 'Bucktail jig or live-liner rig',   bait: 'live bunker or large swimshad' },
    'Snook':           { rod: "7' medium spinning",                 line: '20lb braid', rig: 'Weedless jig or live-liner',       bait: 'live pilchard or large swimbait' },
    'Redfish':         { rod: "7' medium-heavy spinning",           line: '20lb braid', rig: '1/4oz weedless gold spoon',        bait: 'live crab or cut mullet near grass' },
    'Sheepshead':      { rod: "6' medium spinning",                 line: '12lb fluoro', rig: 'Jig head 1/8oz or drop shot',     bait: 'fiddler crab tight to structure' },
    'Flounder':        { rod: "6'6\" medium spinning",              line: '15lb braid', rig: '1/4oz jig or Carolina rig',        bait: 'live finger mullet or Gulp 4\" shrimp' },
  }
};

function getGearRecommendation(targetSpecies, isBeginnerAge) {
  const db = isBeginnerAge ? GEAR_DB.beginner : GEAR_DB.pro;
  for (const sp of targetSpecies) { if (db[sp]) return db[sp]; }
  return db.default;
}

function renderGearGuide(loc) {
  const beginnerGear = getGearRecommendation(loc.targetSpecies, true);
  const proGear      = getGearRecommendation(loc.targetSpecies, false);
  return `
    <div class="space-y-4">
      <p class="text-[11px] text-gray-400 font-semibold uppercase tracking-widest mb-1">Gear matched to: ${loc.targetSpecies.slice(0,3).join(', ')}</p>
      <div class="bg-orange-50 border border-orange-100 rounded-xl p-4">
        <h5 class="text-orange-800 font-bold text-sm mb-2 flex items-center gap-2"><span>🎣</span> Beginner Setup (Ages 3–7)</h5>
        <ul class="text-xs text-orange-700 space-y-1 leading-relaxed">
          <li><span class="font-bold">Rod:</span> ${beginnerGear.rod}</li>
          <li><span class="font-bold">Line:</span> ${beginnerGear.line}</li>
          <li><span class="font-bold">Rig:</span> ${beginnerGear.rig}</li>
          <li><span class="font-bold">Bait:</span> ${beginnerGear.bait}</li>
        </ul>
      </div>
      <div class="bg-green-50 border border-green-100 rounded-xl p-4">
        <h5 class="text-green-800 font-bold text-sm mb-2 flex items-center gap-2"><span>🏅</span> Junior Pro (Ages 8+)</h5>
        <ul class="text-xs text-green-700 space-y-1 leading-relaxed">
          <li><span class="font-bold">Rod:</span> ${proGear.rod}</li>
          <li><span class="font-bold">Line:</span> ${proGear.line}</li>
          <li><span class="font-bold">Rig:</span> ${proGear.rig}</li>
          <li><span class="font-bold">Bait:</span> ${proGear.bait}</li>
        </ul>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Pro Tip
// ---------------------------------------------------------------------------
function getProTip(loc) {
  const species = loc.targetSpecies[0] || 'panfish';
  const isDock  = loc.accessibility === 'Dock';
  const tips = {
    'Bluegill':        isDock ? `Drop a cricket right under the dock's shadow — Bluegill stack there all morning.` : `Work the shady bank edges with a bobber and worm early in the morning.`,
    'Bream':           `Bream love the shade. Cast near overhanging branches and let the bait settle naturally.`,
    'Crappie':         isDock ? `Vertical jig along the dock pilings — Crappie suspend at 4–8ft around structure.` : `Cast parallel to any fallen logs or brush piles. Crappie love ambush cover.`,
    'Catfish':         `Set a bottom bait near the deepest hole you can find and let it sit. Catfish do the work for you.`,
    'Bass':            isDock ? `Flip a plastic worm right to the dock pilings — Bass use structure as ambush points.` : `Walk the bank slowly and cast to any shady pockets or visible cover.`,
    'Largemouth Bass': isDock ? `Flip a creature bait tight to dock pilings on the shady side.` : `Target any visible cover (stumps, laydowns, grass edges) with a slow-rolled worm.`,
    'Walleye':         `Walleye are most active at dawn and dusk. Work a jig slowly along the bottom near drop-offs.`,
    'Northern Pike':   `Pike are aggressive — cast a flashy spoon or large swimbait and retrieve quickly. Watch for follows!`,
    'Perch':           `School perch together — once you catch one, drop back to the same spot. They travel in groups.`,
    'Striped Bass':    `Look for birds working the water surface — they follow the same baitfish Stripers are chasing below.`,
    'Snook':           `Snook hide in mangrove shadows. Cast parallel to the shoreline and work the bait back slowly.`,
    'Redfish':         `Look for tailing Redfish in the shallows at low tide. Cast ahead of them and let the bait sit.`,
    'Sheepshead':      `Sheepshead are bait stealers — use the lightest weight possible and set the hook fast.`,
    'Flounder':        `Flounder lie flat on the bottom. Drag a jig slowly across sandy patches near structure.`,
  };
  return tips[species] || (isDock
    ? `The dock pilings are usually stacked with panfish around 10am. Perfect while you set up lunch!`
    : `The shady bank edges hold the most fish in the morning. Work slowly and let the bait settle.`);
}

// ---------------------------------------------------------------------------
// Quick-glance tag helpers (PRD §3 — issue #5)
// Tag logic (Option B — clean separation, no redundancy):
//   🔥 High Activity  → score >= 70
//   🚻 Restrooms      → amenities.restrooms === true
//   🎣 Easy Casting   → accessibility === 'Clear Bank'
//   🛥️ Dock Access    → accessibility === 'Dock'
//   🛝 Playground     → amenities.playground === true
// ---------------------------------------------------------------------------
function getQuickGlanceTags(loc) {
  const tags = [];
  if (loc.score >= 70)
    tags.push(tagPill('🔥 High Activity', 'bg-green-100 text-green-700'));
  if (loc.amenities && loc.amenities.restrooms)
    tags.push(tagPill('🚻 Restrooms', 'bg-blue-100 text-blue-700'));
  if (loc.accessibility === 'Clear Bank')
    tags.push(tagPill('🎣 Easy Casting', 'bg-orange-100 text-orange-700'));
  if (loc.accessibility === 'Dock')
    tags.push(tagPill('🛥️ Dock Access', 'bg-teal-100 text-teal-700'));
  if (loc.amenities && loc.amenities.playground)
    tags.push(tagPill('🛝 Playground', 'bg-purple-100 text-purple-700'));
  return tags.join('');
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------
function renderCards(results) {
  const container = document.getElementById('cardContainer');
  if (results.length === 0) {
    container.innerHTML = `<div class="text-center py-20 text-gray-400 text-sm">No spots found within your drive time. Try increasing the Max Drive or checking your location.</div>`;
    return;
  }
  container.innerHTML = results.map(loc => {
    const saved = isSpotSaved(loc.id);
    const bookmarkIcon = saved
      ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M5 5a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 19V5z"/></svg>'
      : '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>';
    const quickTags = getQuickGlanceTags(loc);
    return `
      <div class="bg-white rounded-xl shadow-sm border p-4 flex gap-3 items-center cursor-pointer active:scale-[0.98] transition-all" onclick="showDetailView('${loc.id}')">
        <div class="w-14 h-14 bg-gray-100 rounded-lg flex items-center justify-center text-2xl flex-shrink-0">
          ${loc.accessibility === 'Dock' ? '🛶' : '🏖️'}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex justify-between items-start mb-1 gap-2">
            <h3 class="font-bold text-gray-800 leading-tight text-sm truncate">${loc.name}</h3>
            ${scoreBadge(loc.score)}
          </div>
          <div class="flex gap-2 items-center text-[11px] text-gray-500 font-medium">
            <span>📍 ${loc.distMiles} mi</span><span>•</span>
            <span>🚗 ~${Math.round(loc.estDriveHours * 60)} min</span>
            ${loc.weather && !loc.weather.usingFallback ? `<span>• ${Math.round(loc.weather.tempF)}°F</span>` : ''}
            ${loc.source === 'osm' ? '<span class="text-green-600">• Live</span>' : ''}
          </div>
          <div class="flex flex-wrap gap-1 mt-1.5">
            ${loc.targetSpecies.slice(0,2).map(s => tagPill(s)).join('')}
            ${loc.targetSpecies.length > 2 ? tagPill(`+${loc.targetSpecies.length - 2}`) : ''}
          </div>
          ${quickTags ? `<div class="flex flex-wrap gap-1 mt-1">${quickTags}</div>` : ''}
        </div>
        <button data-save-id="${loc.id}" onclick="toggleSave('${loc.id}', event)"
          class="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center flex-shrink-0 ${saved ? 'text-green-600 hover:text-green-800' : 'text-gray-400 hover:text-green-600'} transition-colors"
          title="${saved ? 'Remove from saved' : 'Save this spot'}">
          ${bookmarkIcon}
        </button>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Detail view — renderDetailContent exposed globally so index.html can call it
// ---------------------------------------------------------------------------
function renderDetailContent(loc) {
  const moonPhase = getCurrentMoonPhase();
  const moonIcon  = getMoonIcon(moonPhase);
  const saved     = isSpotSaved(loc.id);

  const tempDisplay     = (loc.weather && !loc.weather.usingFallback) ? `${Math.round(loc.weather.tempF)}°F` : '--°F';
  const windDisplay     = (loc.weather && loc.weather.windMph != null && !loc.weather.usingFallback) ? `${Math.round(loc.weather.windMph)} mph` : '-- mph';
  const weatherNote     = (loc.weather && loc.weather.usingFallback)
    ? '<p class="text-[10px] text-yellow-600 mt-1">⚠️ Estimated weather — add OpenWeather key for live data</p>'
    : '';

  document.getElementById('detailContent').innerHTML = `
    <div class="px-4 pb-6 space-y-4">

      <!-- Header -->
      <div class="flex justify-between items-start pt-2">
        <div class="flex-1 min-w-0">
          <h2 class="font-black text-gray-900 text-lg leading-tight">${loc.name}</h2>
          <p class="text-xs text-gray-500 mt-0.5">${loc.region} · ${loc.distMiles} mi · ~${Math.round(loc.estDriveHours * 60)} min drive</p>
        </div>
        <div class="flex items-center gap-2 ml-2">
          ${scoreBadge(loc.score)}
          <button data-save-id="${loc.id}" onclick="toggleSave('${loc.id}', event)"
            class="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center ${saved ? 'text-green-600' : 'text-gray-400'} hover:text-green-600 transition-colors"
            title="${saved ? 'Remove from saved' : 'Save this spot'}">
            ${saved
              ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M5 5a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 19V5z"/></svg>'
              : '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>'
            }
          </button>
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-200 gap-0 -mx-4 px-4 overflow-x-auto">
        ${['overview','gear','amenities','forecast'].map((t,i) => `
          <button onclick="switchDetailTab('${t}')" id="tab-btn-${t}"
            class="tab-btn flex-shrink-0 px-4 py-2.5 text-xs font-bold border-b-2 transition-colors whitespace-nowrap
              ${i===0 ? 'border-green-700 text-green-700' : 'border-transparent text-gray-400'}">
            ${t === 'overview' ? '📍 Overview' : t === 'gear' ? '🎣 Fish & Gear' : t === 'amenities' ? '🏕️ Amenities' : '📅 Forecast'}
          </button>`).join('')}
      </div>

      <!-- Overview Tab -->
      <div id="tab-overview" class="tab-panel space-y-4">
        <!-- Weather row -->
        <div class="grid grid-cols-3 gap-3">
          <div class="bg-blue-50 rounded-xl p-3 text-center">
            <div class="text-lg font-black text-blue-800">${tempDisplay}</div>
            <div class="text-[10px] text-blue-500 font-bold uppercase">Temp</div>
          </div>
          <div class="bg-gray-50 rounded-xl p-3 text-center">
            <div class="text-lg font-black text-gray-700">${windDisplay}</div>
            <div class="text-[10px] text-gray-400 font-bold uppercase">Wind</div>
          </div>
          <div class="bg-indigo-50 rounded-xl p-3 text-center">
            <div class="text-lg font-black text-indigo-800">${moonIcon}</div>
            <div class="text-[10px] text-indigo-400 font-bold uppercase">Moon</div>
          </div>
        </div>
        ${weatherNote}

        <!-- iNat Community Sightings panel — populated asynchronously -->
        <div id="inat-panel-${loc.id}" class="bg-teal-50 border border-teal-100 rounded-xl p-4">
          <div class="text-[10px] uppercase font-black text-teal-500 mb-2">🌿 Community Fish Sightings</div>
          <div class="text-xs text-teal-600 italic">Loading nearby observations...</div>
        </div>

        <!-- Species -->
        <div>
          <p class="text-[10px] uppercase font-black text-gray-400 mb-2">Target Species</p>
          <div class="flex flex-wrap gap-2">
            ${loc.targetSpecies.map(s => `<span class="px-3 py-1 bg-green-100 text-green-800 rounded-full text-xs font-bold">${s}</span>`).join('')}
          </div>
        </div>

        <!-- Directions -->
        <a href="https://www.google.com/maps/dir/?api=1&destination=${loc.coordinates.lat},${loc.coordinates.lng}"
          target="_blank"
          class="block w-full bg-green-700 text-white text-center py-4 rounded-xl font-black shadow-lg shadow-green-700/20 active:scale-95 transition-all">
          Get Directions
        </a>
      </div>

      <!-- Gear Tab -->
      <div id="tab-gear" class="tab-panel hidden">
        ${renderGearGuide(loc)}
        <div class="mt-4 bg-yellow-50 border border-yellow-100 rounded-xl p-4">
          <h5 class="text-yellow-800 font-bold text-sm mb-1">💡 Pro Tip</h5>
          <p class="text-xs text-yellow-800 italic leading-relaxed font-medium">"${getProTip(loc)}"</p>
        </div>
      </div>

      <!-- Amenities Tab -->
      <div id="tab-amenities" class="tab-panel hidden space-y-4">
        <div class="grid grid-cols-2 gap-3">
          ${amenityRow('🚻', 'Restrooms', loc.amenities.restrooms)}
          ${amenityRow('🛝', 'Playground', loc.amenities.playground)}
          ${amenityRow('🍽️', 'Picnic Area', loc.amenities.picnicTables)}
          ${amenityRow('🌳', 'Shaded Area', loc.amenities.shadedArea)}
        </div>
        <div class="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
          <div class="flex justify-between"><span class="text-gray-500 text-xs">Parking Fee</span><span class="font-bold text-xs">${loc.fees.parking}</span></div>
          <div class="flex justify-between"><span class="text-gray-500 text-xs">Fishing License</span><span class="font-bold text-xs">${loc.fees.fishing}</span></div>
          <div class="flex justify-between"><span class="text-gray-500 text-xs">Access Type</span><span class="font-bold text-xs">${loc.accessibility}</span></div>
        </div>
        ${renderDNRPanel(loc)}
      </div>

      <!-- Forecast Tab -->
      <div id="tab-forecast" class="tab-panel hidden">
        <p class="text-[10px] uppercase font-black text-gray-400 mb-3">30-Day Fish Activity Forecast</p>
        <div class="grid grid-cols-7 gap-1" id="forecastGrid-${loc.id}"></div>
        <div class="mt-3 flex gap-3 text-[10px] text-gray-500">
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span> Excellent (70+)</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-yellow-400 inline-block"></span> Good (45–69)</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-red-400 inline-block"></span> Poor (&lt;45)</span>
        </div>
      </div>

    </div>`;

  // Initialize forecast grid
  renderForecastGrid(loc);

  // Trigger iNaturalist enrichment asynchronously after DOM is painted
  setTimeout(function() { loadAndRenderINatPanel(loc); }, 0);
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------
let allResults = [];

async function init() {
  showLoading(true);

  // --- resolve user coordinates ---
  const locationInput = (document.getElementById('locationInput')?.value || '').trim();
  let userCoords = null;

  if (isCurrentLocationRequest(locationInput)) {
    try { userCoords = await getGpsLocation(); }
    catch (e) {
      console.warn('[init] GPS denied/unavailable:', e);
      userCoords = null;
    }
  } else {
    userCoords = await geocodeTypedLocation(locationInput);
  }

  if (!userCoords) {
    userCoords = ATLANTA_FALLBACK;
    showBanner('📍 Using Atlanta as your location. Enter a city above for better results.', 'yellow');
  } else if (isCurrentLocationRequest(locationInput)) {
    showBanner('📍 Using your current GPS location.', 'green');
  } else {
    showBanner(`📍 Showing spots near: ${userCoords.displayName || locationInput}`, 'green');
  }

  // Bust cache for fresh data on each explicit search
  bustCacheForCoords(userCoords.lat, userCoords.lng);

  const maxDriveHours = parseFloat(document.getElementById('driveTime')?.value || '1');
  const childAge      = parseInt(document.getElementById('childAge')?.value || '6', 10);

  const weather   = await fetchWeather(userCoords.lat, userCoords.lng, true);
  const moonPhase = getCurrentMoonPhase();

  // Fetch OSM spots
  let osmSpots = await fetchFishingSpotsNearby(userCoords.lat, userCoords.lng, true);
  if (osmSpots.length === 0) {
    osmSpots = await loadFallbackSpots();
    if (osmSpots.length > 0) showBanner('📂 Showing curated spots — live data unavailable.', 'yellow');
  }

  // Filter and score
  allResults = osmSpots
    .map(loc => {
      const dist = haversineDistance(userCoords, loc.coordinates);
      const estHours = dist / 45;
      return { ...loc, distMiles: Math.round(dist), estDriveHours: estHours, weather };
    })
    .filter(loc => {
      if (loc.estDriveHours > maxDriveHours) return false;
      if (childAge < 6 && loc.accessibility === 'Obstructed Bank') return false;
      return true;
    })
    .map(loc => {
      const score = calcSuccessScore(loc, weather, moonPhase, childAge);
      return { ...loc, score };
    })
    .sort((a, b) => a.distMiles - b.distMiles);

  // ── DNR Enrichment: merge GA DNR access points into results ──
  try {
    var dnrSpots = await enrichFromDNR(userCoords.lat, userCoords.lng, OVERPASS_RADIUS_M);
    if (dnrSpots.length > 0) {
      allResults = allResults.map(function(loc) {
        var match = matchDNRRecord(loc, dnrSpots);
        return match ? mergeDNRIntoLoc(loc, match) : loc;
      });
      // Add DNR access points not matched to any existing result
      var matchedNames = {};
      allResults.forEach(function(l) { matchedNames[l.name.toLowerCase()] = true; });
      var dnrOnly = dnrSpots.filter(function(d) {
        if (!d.coordinates.lat || !d.coordinates.lng) return false;
        if (matchedNames[d.name.toLowerCase()]) return false;
        var distMi = haversineDistance(userCoords, d.coordinates);
        return (distMi / 45) <= maxDriveHours;
      }).map(function(d) {
        var distMi = haversineDistance(userCoords, d.coordinates);
        var fw = { tempF: 68, pressureHpa: 1016, usingFallback: true };
        var loc = {
          id: d.dnrId, name: d.name, coordinates: d.coordinates,
          accessibility: d.accessibility,
          targetSpecies: d.confirmedSpecies.length > 0 ? d.confirmedSpecies : inferSpecies(d.coordinates.lat),
          amenities: {
            restrooms: d.amenities.restrooms, restroomsADA: d.amenities.restroomsADA,
            picnicTables: d.amenities.picnicArea,
            parking: d.amenities.parking, parkingADA: d.amenities.parkingADA,
            dockADA: d.amenities.dockADA, camping: d.amenities.camping,
            baitShop: d.amenities.baitShop, equipmentRental: d.amenities.equipmentRental,
            loanPole: d.amenities.loanPole, kidsProgram: d.amenities.kidsProgram,
            playground: false, shadedArea: false,
          },
          fees: d.fees,
          region: d.county ? d.county + ' County, GA' : 'Georgia',
          source: 'dnr', distMiles: Math.round(distMi), estDriveHours: distMi / 45,
          weather: fw,
          dnr: {
            waterbody: d.waterbody, county: d.county, acres: d.acres,
            status: d.status, operator: d.operator, phone: d.phone,
            rampType: d.rampType, numLanes: d.numLanes,
            motorRestrictions: d.fishing.motorRestrictions, yearRound: d.fishing.yearRound,
            bankFishing: d.fishing.bankFishing, pier: d.fishing.pier,
            moreInfo: d.moreInfo, infoLink: d.infoLink,
          },
        };
        var score = calcSuccessScore(loc, fw, moonPhase, childAge);
        return Object.assign({}, loc, { score: score });
      });
      allResults = allResults.concat(dnrOnly).sort(function(a, b) { return a.distMiles - b.distMiles; });
      console.log('[DNR] merged; added ' + dnrOnly.length + ' DNR-only spots');
    }
  } catch (err) {
    console.warn('[DNR] enrichment failed:', err.message);
  }

  showLoading(false);
  renderCards(allResults);
}

document.getElementById('searchBtn').addEventListener('click', init);
