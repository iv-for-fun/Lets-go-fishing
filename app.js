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
  },
  pro: {
    default:           { rod: "5'6\" medium-light spinning combo",  line: '8lb mono',   rig: '1/8oz rooster tail or Senko worm', bait: 'soft plastic worms near structure' },
    'Bluegill':        { rod: "5' ultralight spinning",             line: '4lb fluoro', rig: '1/32oz jig head',                  bait: 'small tube or twister tail' },
    'Bream':           { rod: "5' ultralight spinning",             line: '4lb fluoro', rig: '1/32oz jig head',                  bait: 'small tube or cricket on a hook' },
    'Crappie':         { rod: "6' light spinning",                  line: '6lb fluoro', rig: '1/16oz marabou jig',               bait: 'crappie tube or small minnow' },
    'Catfish':         { rod: "6'6\" medium-heavy spinning",        line: '17lb mono',  rig: 'Slip sinker rig, #1 circle hook',  bait: 'stink bait or cut shad' },
    'Bass':            { rod: "6' medium spinning",                 line: '10lb fluoro', rig: '3/16oz Texas-rig',                bait: '4" plastic worm or Senko' },
    'Largemouth Bass': { rod: "6'6\" medium baitcaster or spinning",line: '12lb fluoro', rig: '1/4oz jig or Texas-rig',          bait: 'creature bait or swim jig near cover' },
    'Walleye':         { rod: "6' medium spinning",                 line: '8lb fluoro', rig: '1/4oz jig head',                   bait: '3" paddle tail swimbait or live crawler' },
    'Northern Pike':   { rod: "6'6\" medium-heavy spinning",        line: '20lb braid + wire leader', rig: 'Inline spinner or swim bait', bait: '5" swimbait or large spoon' },
    'Perch':           { rod: "5' light spinning",                  line: '6lb mono',  rig: '1/16oz jig or drop shot',           bait: 'small minnow or perch eye' },
    'Striped Bass':    { rod: "7' medium-heavy spinning",           line: '20lb braid', rig: 'Bucktail jig or live-liner rig',   bait: 'live bunker or large swimshad' },
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
  };
  return tips[species] || (isDock
    ? `The dock pilings are usually stacked with panfish around 10am. Perfect while you set up lunch!`
    : `The shady bank edges hold the most fish in the morning. Work slowly and let the bait settle.`);
}

// ---------------------------------------------------------------------------
// Static fallback spots
// ---------------------------------------------------------------------------
const STATIC_FALLBACK_SPOTS = [
  { id: 'lake-allatoona-001', name: 'Lake Allatoona — McKaskey Creek', coordinates: { lat: 34.1473, lng: -84.7229 }, accessibility: 'Dock', amenities: { restrooms: true, playground: true, picnicTables: true, shadedArea: true }, targetSpecies: ['Largemouth Bass', 'Crappie', 'Bluegill'], fees: { parking: '$5/day', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static' },
  { id: 'stone-mountain-lake-001', name: 'Stone Mountain Park — Fishing Area', coordinates: { lat: 33.8081, lng: -84.1452 }, accessibility: 'Clear Bank', amenities: { restrooms: true, playground: true, picnicTables: true, shadedArea: true }, targetSpecies: ['Bass', 'Bluegill', 'Catfish'], fees: { parking: '$20/vehicle', fishing: 'Free with park entry' }, region: 'Atlanta, GA', source: 'static' },
  { id: 'sweetwater-creek-001', name: 'Sweetwater Creek State Park', coordinates: { lat: 33.7490, lng: -84.6271 }, accessibility: 'Clear Bank', amenities: { restrooms: true, playground: false, picnicTables: true, shadedArea: true }, targetSpecies: ['Bass', 'Bream', 'Catfish'], fees: { parking: '$5/day', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static' },
  { id: 'lake-lanier-001', name: 'Lake Lanier — Sawnee Campground Dock', coordinates: { lat: 34.1732, lng: -84.0168 }, accessibility: 'Dock', amenities: { restrooms: true, playground: false, picnicTables: true, shadedArea: true }, targetSpecies: ['Striped Bass', 'Largemouth Bass', 'Crappie'], fees: { parking: '$5/day', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static' },
  { id: 'kennesaw-mountain-pond-001', name: 'Kennesaw Mountain — Visitors Pond', coordinates: { lat: 33.9748, lng: -84.5766 }, accessibility: 'Clear Bank', amenities: { restrooms: true, playground: true, picnicTables: true, shadedArea: true }, targetSpecies: ['Bluegill', 'Bass', 'Catfish'], fees: { parking: 'Free', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static' }
];

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showLoading(show) {
  const el = document.getElementById('loadingState');
  if (el) el.style.display = show ? 'block' : 'none';
}

function showError(msg) {
  document.getElementById('cardContainer').innerHTML = `
    <div class="text-center mt-8 p-4">
      <p class="text-red-500 font-semibold">⚠️ Something went wrong</p>
      <p class="text-gray-500 text-sm mt-1">${msg}</p>
      <button onclick="init()" class="mt-3 bg-green-700 text-white px-4 py-2 rounded text-sm">Try Again</button>
    </div>`;
}

function showGpsBanner(show) { const el = document.getElementById('gpsBanner'); if (el) el.style.display = show ? 'block' : 'none'; }
function showWeatherBanner(show) { const el = document.getElementById('weatherBanner'); if (el) el.style.display = show ? 'block' : 'none'; }

function showLocationBanner(displayName, usingGps) {
  let el = document.getElementById('locationResolutionBanner');
  if (!el) { el = document.createElement('div'); el.id = 'locationResolutionBanner'; document.querySelector('header').after(el); }
  el.className = 'px-4 py-2 text-[11px] font-medium border-b bg-indigo-50 border-indigo-200 text-indigo-800';
  el.textContent = usingGps ? `📍 Using your current GPS location.` : `📍 Showing spots near: ${displayName}`;
  el.style.display = 'block';
}

function showDataSourceBanner(source) {
  let el = document.getElementById('dataSourceBanner');
  if (!el) { el = document.createElement('div'); el.id = 'dataSourceBanner'; (document.getElementById('locationResolutionBanner') || document.querySelector('header')).after(el); }
  if (source === 'osm') { el.className = 'px-4 py-2 text-[11px] font-medium border-b bg-green-50 border-green-200 text-green-800'; el.textContent = '🗺️ Showing live fishing spots near your location from OpenStreetMap.'; }
  else { el.className = 'px-4 py-2 text-[11px] font-medium border-b bg-yellow-50 border-yellow-200 text-yellow-800'; el.textContent = '📋 Showing curated Atlanta-area spots — live data unavailable for this location.'; }
  el.style.display = 'block';
}

function getCurrentMoonPhase() {
  const refNew = new Date('2000-01-06T18:14:00Z');
  return ((Date.now() - refNew) / (1000 * 60 * 60 * 24) % 29.53) / 29.53;
}

// ---------------------------------------------------------------------------
// Quick-glance tag helpers (PRD §3: "High Activity", "Restrooms", "Easy Casting")
// ---------------------------------------------------------------------------
function getQuickGlanceTags(loc) {
  const tags = [];
  if (loc.score >= 70)
    tags.push(tagPill('🔥 High Activity', 'bg-green-100 text-green-700'));
  if (loc.amenities && loc.amenities.restrooms)
    tags.push(tagPill('🚻 Restrooms', 'bg-blue-100 text-blue-700'));
  if (loc.accessibility === 'Dock' || loc.accessibility === 'Clear Bank')
    tags.push(tagPill('🎣 Easy Casting', 'bg-orange-100 text-orange-700'));
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
    ? '<p class="text-[10px] text-yellow-600 mt-1">⚠️ Estimated weather — add API key for live data</p>'
    : `<p class="text-[10px] text-gray-400 mt-1">${loc.weather.description || ''}</p>`;

  const bookmarkIcon = saved
    ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M5 5a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 19V5z"/></svg>'
    : '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>';

  document.getElementById('detailContent').innerHTML = `
    <div class="bg-white rounded-2xl shadow-sm border overflow-hidden mb-6">
      <div class="bg-green-700 p-6 text-white">
        <div class="flex justify-between items-start mb-4">
          <h2 class="text-xl font-black leading-tight flex-1 mr-3">${loc.name}</h2>
          <div class="flex items-center gap-2">
            <button data-save-id="${loc.id}" onclick="toggleSave('${loc.id}', event)"
              class="bg-white/20 p-2 rounded-xl min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-white/30 transition-colors"
              title="${saved ? 'Remove from saved' : 'Save this spot'}">
              ${bookmarkIcon}
            </button>
            <div class="bg-white/20 backdrop-blur-md p-3 rounded-xl text-center min-w-[60px]">
              <div class="text-[10px] uppercase font-black opacity-80">Score</div>
              <div class="text-xl font-black">${loc.score}</div>
            </div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${tagPill(loc.accessibility, 'bg-white/20 text-white')}
          ${tagPill(loc.region, 'bg-white/20 text-white')}
          ${loc.source === 'osm' ? tagPill('Live Data', 'bg-white/20 text-white') : ''}
        </div>
      </div>

      <div class="flex border-b bg-gray-50">
        <button id="btn-overview"  onclick="switchTab('overview','${loc.id}')"  class="tab-btn tab-active flex-1">Overview</button>
        <button id="btn-fish"      onclick="switchTab('fish','${loc.id}')"      class="tab-btn tab-inactive flex-1">Fish &amp; Gear</button>
        <button id="btn-amenities" onclick="switchTab('amenities','${loc.id}')" class="tab-btn tab-inactive flex-1">Amenities</button>
        <button id="btn-forecast"  onclick="switchTab('forecast','${loc.id}')"  class="tab-btn tab-inactive flex-1">Forecast</button>
      </div>

      <div class="p-5">
        <div id="tab-overview">
          <div class="grid grid-cols-3 gap-3 mb-6">
            <div class="bg-blue-50 p-3 rounded-xl border border-blue-100">
              <div class="text-[10px] uppercase font-black text-blue-400 mb-1">Temp</div>
              <div class="text-lg font-black text-blue-900">${tempDisplay}</div>
              ${weatherNote}
            </div>
            <div class="bg-teal-50 p-3 rounded-xl border border-teal-100">
              <div class="text-[10px] uppercase font-black text-teal-400 mb-1">Wind</div>
              <div class="text-lg font-black text-teal-900">${windDisplay}</div>
            </div>
            <div class="bg-purple-50 p-3 rounded-xl border border-purple-100">
              <div class="text-[10px] uppercase font-black text-purple-400 mb-1">Moon</div>
              <div class="text-lg font-black text-purple-900">${moonIcon}</div>
            </div>
          </div>
          <h4 class="text-xs font-black uppercase tracking-widest text-gray-400 mb-3">Top Species Here</h4>
          <div class="flex flex-wrap gap-2 mb-6">
            ${loc.targetSpecies.map(s => `
              <div class="flex items-center gap-2 bg-gray-100 px-3 py-2 rounded-lg border">
                <span class="text-lg">🐟</span>
                <span class="text-sm font-bold text-gray-700">${s}</span>
              </div>`).join('')}
          </div>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${loc.coordinates.lat},${loc.coordinates.lng}"
            target="_blank"
            class="block w-full bg-green-700 text-white text-center py-4 rounded-xl font-black shadow-lg shadow-green-700/20 active:scale-95 transition-all">
            Get Directions
          </a>
        </div>

        <div id="tab-fish" style="display:none;">${renderGearGuide(loc)}</div>

        <div id="tab-amenities" style="display:none;">
          <div class="grid grid-cols-2 gap-4">
            ${[{ key:'restrooms',icon:'🚻',label:'Restrooms'},{key:'playground',icon:'🛝',label:'Playground'},{key:'picnicTables',icon:'🧺',label:'Picnic Area'},{key:'shadedArea',icon:'🌳',label:'Shade'}].map(a => `
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full flex items-center justify-center ${loc.amenities[a.key] ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-300'}">${a.icon}</div>
                <div class="text-xs font-bold ${loc.amenities[a.key] ? 'text-gray-700' : 'text-gray-400'}">${a.label}</div>
              </div>`).join('')}
          </div>
          <div class="mt-8 pt-6 border-t space-y-3">
            <div class="flex justify-between text-xs"><span class="text-gray-500 font-bold uppercase">Parking Fee</span><span class="font-black text-gray-700">${loc.fees.parking}</span></div>
            <div class="flex justify-between text-xs"><span class="text-gray-500 font-bold uppercase">Fishing License</span><span class="font-black text-gray-700">${loc.fees.fishing}</span></div>
            <div class="flex justify-between text-xs"><span class="text-gray-500 font-bold uppercase">Access Type</span><span class="font-black text-gray-700">${loc.accessibility}</span></div>
          </div>
        </div>

        <div id="tab-forecast" style="display:none;">
          <div id="forecastGrid" class="grid grid-cols-7 gap-1"></div>
          <div class="mt-4 flex gap-4 justify-center">
            <div class="flex items-center gap-1 text-[10px] font-bold"><div class="w-2 h-2 rounded bg-green-400"></div> Excellent</div>
            <div class="flex items-center gap-1 text-[10px] font-bold"><div class="w-2 h-2 rounded bg-yellow-300"></div> Good</div>
            <div class="flex items-center gap-1 text-[10px] font-bold"><div class="w-2 h-2 rounded bg-red-400"></div> Poor</div>
          </div>
        </div>
      </div>

      <div class="mx-5 mb-5 bg-yellow-50 border-2 border-dashed border-yellow-200 rounded-xl p-4">
        <div class="text-[10px] uppercase font-black text-yellow-600 mb-1">Parent Pro-Tip</div>
        <p class="text-xs text-yellow-800 italic leading-relaxed font-medium">"${getProTip(loc)}"</p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------
async function init() {
  showLoading(true);
  showGpsBanner(false);
  showWeatherBanner(false);
  document.getElementById('cardContainer').innerHTML = '';

  const rawInput = document.getElementById('locationInput').value;
  const useGps   = isCurrentLocationRequest(rawInput);
  let userCoords = null, displayName = '', usingGps = false;

  if (useGps) {
    try { userCoords = await getGpsLocation(); displayName = 'your GPS location'; usingGps = true; }
    catch { userCoords = ATLANTA_FALLBACK; displayName = 'Atlanta, GA (fallback)'; showGpsBanner(true); }
  } else {
    const geocoded = await geocodeTypedLocation(rawInput);
    if (geocoded) { userCoords = { lat: geocoded.lat, lng: geocoded.lng }; displayName = geocoded.displayName; }
    else { showLoading(false); showError(`Could not find "${rawInput}". Try a different city, address, or landmark.`); return; }
  }

  showLocationBanner(displayName, usingGps);
  bustCacheForCoords(userCoords.lat, userCoords.lng);

  let originWeather;
  try { originWeather = await fetchWeather(userCoords.lat, userCoords.lng, true); }
  catch { originWeather = { tempF: 68, pressureHpa: 1016, usingFallback: true }; }
  showWeatherBanner(!!originWeather.usingFallback);

  const moonPhase = getCurrentMoonPhase();
  let locations   = await fetchFishingSpotsNearby(userCoords.lat, userCoords.lng, true);
  const usingLive = locations.length > 0;
  if (!usingLive) locations = STATIC_FALLBACK_SPOTS;
  showDataSourceBanner(usingLive ? 'osm' : 'static');

  const childAge      = parseInt(document.getElementById('childAge').value)  || 6;
  const maxDriveHours = parseFloat(document.getElementById('driveTime').value) || 1.5;

  const candidates = locations
    .map(loc => { const distMiles = haversineDistance(userCoords, loc.coordinates); return { ...loc, distMiles: Math.round(distMiles), estDriveHours: distMiles / 45 }; })
    .filter(loc => { if (childAge < 6 && loc.accessibility === 'Obstructed Bank') return false; return loc.estDriveHours <= maxDriveHours; })
    .sort((a, b) => a.distMiles - b.distMiles);

  const spotWeathers = await Promise.all(candidates.map(loc => fetchWeather(loc.coordinates.lat, loc.coordinates.lng, true).catch(() => originWeather)));

  allResults = candidates.map((loc, i) => {
    const spotWeather = spotWeathers[i] || originWeather;
    const score = calcSuccessScore(loc, spotWeather, moonPhase, childAge);
    return { ...loc, weather: spotWeather, score };
  });

  showLoading(false);
  renderCards(allResults);
}

document.getElementById('searchBtn').addEventListener('click', init);
