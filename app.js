// app.js — Main application logic
// LOCATION RESOLUTION RULES (strictly enforced):
//   1. If the user types a specific place (address, city, landmark, POI),
//      geocode it via Nominatim with addressdetails so we get the canonical
//      centroid that Google Maps would use, then use ONLY those coords.
//   2. GPS / Geolocation is used ONLY when locationInput is blank OR
//      the user explicitly types "current" or "current location".
//   3. Atlanta fallback is last-resort only — never used if the user
//      typed something or if GPS succeeds.
//   4. All distance calculations use the resolved origin coords exclusively
//      — no mixing of GPS + typed values.
//
// DATA FRESHNESS GUARANTEE:
//   Every explicit "Find Spots" click busts the weather cache for the
//   resolved coordinates, so weather/moon/pressure always reflect the
//   freshest available API data. Spot data itself (data/spots/{ABBR}.json,
//   Phase 2 / issue #36) is pre-built monthly, not per-request, so it's
//   intentionally cached across searches (IndexedDB, 6hr TTL) rather than
//   busted on every click — only the live-Overpass fallback path (for an
//   area with no pre-built file yet) uses the per-click-busted spots cache.

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
        ${catchReleaseBadge(loc, 'mt-1')}
        ${statusNoticeBanner(loc, 'mt-1')}
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
// Weather fetch — Open-Meteo (free, no API key required)
// ---------------------------------------------------------------------------
async function fetchWeather(lat, lng, forceRefresh = false) {
  const cacheKey = `weather_${coordKey(lat, lng)}`;
  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,pressure_msl,wind_speed_10m,weather_code` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
    const json = await res.json();
    const current = json.current || {};
    const weatherCode = current.weather_code ?? current.weathercode;
    const data = {
      tempF: current.temperature_2m,
      pressureHpa: current.pressure_msl,
      description: (typeof describeWeatherCode === 'function') ? describeWeatherCode(weatherCode) : '',
      windMph: current.wind_speed_10m ?? current.windspeed_10m ?? 0
    };
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.warn('Weather fetch failed, using fallback:', err);
    return { tempF: 68, pressureHpa: 1016, usingFallback: true };
  }
}

// ---------------------------------------------------------------------------
// Overpass API — live fallback only (Phase 2, issue #36). The primary spot
// source is now the pre-built data/spots/{ABBR}.json files loaded by
// loadSpotsNearby() in spots-loader.js; this is called only when no perimeter
// state has a pre-built file yet.
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

    // Same field shape as the pre-built data/spots/{ABBR}.json records
    // (tools/build_spots_data.py) so card/detail rendering doesn't need
    // source-specific branches. This live path has no amenity-proximity join
    // (issue #36 scope), so on-site amenities are read straight off the
    // spot's own tags only — a coarser signal than the build-time join, but
    // still "unknown ≠ absent" (false here just means not tagged on this element).
    const legalStatus = tags.fishing === 'catch_and_release' ? 'catch_and_release'
      : (tags.fishing === 'yes' || tags.fishing === 'permissive') ? 'public' : null;

    const amenities = {
      restrooms: !!(tags.toilets || tags['toilets:disposal'] || tags.amenity === 'toilets'),
      restroomsADA: tags['toilets:wheelchair'] === 'yes',
      changingTable: tags.changing_table === 'yes',
      drinkingWater: tags.amenity === 'drinking_water',
      playground: !!(tags.playground || tags.leisure === 'playground'),
      parking: tags.amenity === 'parking',
      parkingFee: tags.amenity === 'parking' && tags.fee === 'yes',
      shelter: tags.amenity === 'shelter'
    };

    const fishTag = tags.fish || tags.species || '';
    const targetSpecies = fishTag
      ? fishTag.split(';').map(s => s.trim()).filter(Boolean)
      : inferSpecies(elLat);

    const region = [tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ') || inferRegionLabel(elLat);

    results.push({
      id: `osm-${el.type}-${el.id}`,
      name, coordinates: { lat: elLat, lng: elLng },
      legalStatus, hours: tags.opening_hours || null,
      accessibility,
      fee: tags.fee === 'yes' ? 'yes' : (tags.fee === 'no' ? 'no' : null),
      operator: tags.operator || null,
      website: tags.website || tags.url || null,
      wheelchairAccessible: tags.wheelchair === 'yes',
      amenities, targetSpecies, nearbyBait: [], nearbyFood: [], region, source: 'osm',
      statusNotice: null // live-fallback ids don't match data/spot-notices.json's build-time id scheme
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
// Seasonal fish-behavior clause — layered onto getProTip() below. Pure
// client-side lookup, no external data; keyed off the same species strings
// getProTip already uses so there's no separate taxonomy to maintain.
// ---------------------------------------------------------------------------
const SEASONAL_TIPS = {
  'Bluegill':         { spring: `Spawning beds put Bluegill in skinny water right now — perfect for little casters.`, summer: `Midday sun pushes them deep; fish the shade early or late.`, fall: `Cooling water has them feeding heavily before winter — a great fall pick.`, winter: `Slow down — Bluegill hold tight to deep structure in cold water.` },
  'Bream':            { spring: `Bream move shallow to spawn around the full moon — prime time.`, summer: `Look for shade; Bream avoid the hottest midday sun.`, fall: `Still feeding actively as the water cools.`, winter: `Bream are sluggish now — fish slow and deep.` },
  'Crappie':          { spring: `Crappie push shallow to spawn — dock pilings and brush get crowded.`, summer: `They suspend deeper around structure once it warms up.`, fall: `A second shallow push as water cools — good numbers again.`, winter: `Crappie school tight and deep; vertical jigging is the move.` },
  'Catfish':          { spring: `Catfish feed heavily as water warms — good action after spawn.`, summer: `Most active after dark or early morning in the heat.`, fall: `Feeding up before winter — a strong bite window.`, winter: `Slower bite; fish deep holes patiently.` },
  'Bass':              { spring: `Bass move shallow to spawn — target the banks.`, summer: `Early morning and dusk beat the midday heat.`, fall: `Bass feed aggressively chasing baitfish before winter.`, winter: `Slow presentations near deep structure work best.` },
  'Largemouth Bass':  { spring: `Spawning season has Largemouth shallow and aggressive near cover.`, summer: `Fish shady cover early or late to beat the heat.`, fall: `A strong feeding window as they bulk up for winter.`, winter: `Slow it down and fish deep near structure.` },
  'Walleye':          { spring: `Walleye push shallow right after ice-out/spawn — good bank access.`, summer: `Stick to dawn/dusk low light.`, fall: `Feeding heavily — one of the best times to target them.`, winter: `Slow jigging near drop-offs still produces.` },
  'Northern Pike':    { spring: `Pike are shallow and aggressive right after spawn.`, summer: `They retreat to cooler, deeper water in the heat.`, fall: `Pike feed heavily before winter — a great time to target them.`, winter: `Slow presentations near structure work under the cold.` },
  'Perch':            { spring: `Perch school shallow to spawn.`, summer: `They move a bit deeper once it warms up.`, fall: `Great time to target schooling Perch.`, winter: `Perch stay active even in cold water — a solid winter pick.` },
  'Striped Bass':     { spring: `Stripers push upriver chasing baitfish during spawn runs.`, summer: `Look for them early/late chasing surface baitfish.`, fall: `Aggressive feeding as baitfish move — great topwater season.`, winter: `Stripers go deep; slow presentations near structure.` },
};

function getSeasonalClause(species, date) {
  const month = (date || new Date()).getMonth(); // 0=Jan..11=Dec
  const season = (month <= 1 || month === 11) ? 'winter'
    : month <= 4 ? 'spring'
    : month <= 7 ? 'summer'
    : 'fall';
  const bucket = SEASONAL_TIPS[species];
  return bucket ? (bucket[season] || '') : '';
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
  const base = tips[species] || (isDock
    ? `The dock pilings are usually stacked with panfish around 10am. Perfect while you set up lunch!`
    : `The shady bank edges hold the most fish in the morning. Work slowly and let the bait settle.`);
  const seasonal = getSeasonalClause(species);
  return seasonal ? `${base} ${seasonal}` : base;
}

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

function showDataSourceBanner(show) {
  let el = document.getElementById('dataSourceBanner');
  if (!el) { el = document.createElement('div'); el.id = 'dataSourceBanner'; (document.getElementById('locationResolutionBanner') || document.querySelector('header')).after(el); }
  if (!show) { el.style.display = 'none'; return; }
  el.className = 'px-4 py-2 text-[11px] font-medium border-b bg-green-50 border-green-200 text-green-800';
  el.textContent = '🗺️ Showing fishing spots from our OpenStreetMap + DNR database (refreshed monthly).';
  el.style.display = 'block';
}

// moonPhaseForDate lives in solunar.js (shared with the Forecast tab's daily
// moon-phase field); fall back to an inline copy if solunar.js hasn't loaded
// for some reason so the rest of the app still works.
function getCurrentMoonPhase() {
  if (typeof moonPhaseForDate === 'function') return moonPhaseForDate(new Date());
  const refNew = new Date('2000-01-06T18:14:00Z');
  return ((Date.now() - refNew) / (1000 * 60 * 60 * 24) % 29.53) / 29.53;
}

// ---------------------------------------------------------------------------
// Phase 3 (issue #37) helpers — legal status, hours, accessibility advisory.
// ---------------------------------------------------------------------------

// Amber, prominent — never rendered as just another quick-glance pill, since
// a catch-and-release-only spot changes what a parent should plan for.
function catchReleaseBadge(loc, extraClass) {
  if (!loc || loc.legalStatus !== 'catch_and_release') return '';
  return `<div class="${extraClass || ''} bg-amber-100 border border-amber-300 text-amber-800 font-black text-[11px] px-2.5 py-1 rounded-lg inline-flex items-center gap-1 w-fit">
    ♻️ Catch &amp; Release Only
  </div>`;
}

// Hand-curated closure/advisory override (data/spot-notices.json, merged at
// build time by tools/build_spots_data.py) — same "own banner, not folded
// into quick-glance tags" treatment as catchReleaseBadge, since a closure
// changes trip planning more than an amenity tag does.
function statusNoticeBanner(loc, extraClass) {
  if (!loc || !loc.statusNotice || !loc.statusNotice.message) return '';
  const isClosure = loc.statusNotice.severity === 'closure';
  const colors = isClosure
    ? 'bg-red-100 border-red-300 text-red-800'
    : 'bg-amber-100 border-amber-300 text-amber-800';
  const icon  = isClosure ? '🚧' : '⚠️';
  const label = isClosure ? 'Closed / Restricted' : 'Advisory';
  const title = String(loc.statusNotice.message).replace(/"/g, '&quot;');
  return `<div class="${extraClass || ''} ${colors} border font-black text-[11px] px-2.5 py-1 rounded-lg inline-flex items-center gap-1 w-fit" title="${title}">
    ${icon} ${label}
  </div>`;
}

// Never imply 24/7 — absent/unrecognized hours always read as "not listed",
// not "open all the time" (MIGRATION_PLAN.md §6).
function formatHours(hours) {
  if (!hours) return 'Hours not listed';
  if (hours.trim().toLowerCase() === 'sunrise-sunset') return 'Sunrise–Sunset';
  return hours;
}

function legalStatusLabel(legalStatus) {
  if (legalStatus === 'catch_and_release') return '♻️ Catch & Release Only';
  if (legalStatus === 'public') return 'Public Access';
  return 'Legal status not listed';
}

// The real proximity-joined amenity set (MIGRATION_PLAN.md §6, §9) — replaces
// the old placeholder Picnic Area / Shade fields, which weren't backed by
// real data.
const AMENITY_ITEMS = [
  { key: 'restrooms',     icon: '🚻', label: 'Restrooms' },
  { key: 'changingTable', icon: '🚼', label: 'Changing Table' },
  { key: 'drinkingWater', icon: '🚰', label: 'Drinking Water' },
  { key: 'playground',    icon: '🛝', label: 'Playground' },
  { key: 'parking',       icon: '🅿️', label: 'Parking' },
  { key: 'shelter',       icon: '⛱️', label: 'Shelter' },
];

function nearbyBaitLabel(loc) {
  const nearest = loc.nearbyBait && loc.nearbyBait[0];
  return nearest ? `${nearest.name} (~${nearest.distanceMi} mi)` : 'None found nearby';
}

function feeLabel(loc) {
  if (loc.fee === 'yes') return 'Fee Required';
  if (loc.fee === 'no') return 'Free';
  if (loc.amenities && loc.amenities.parkingFee) return 'Parking Fee Required';
  return 'Check Locally';
}

// ---------------------------------------------------------------------------
// Quick-glance tag helpers (PRD §4.2.1: High Activity, Restrooms, Easy
// Casting, Dock Access, Playground)
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
    container.innerHTML = `
      <div class="text-center py-20 px-6 text-gray-400">
        <div class="text-5xl mb-4">🎣</div>
        <p class="font-bold text-gray-600 text-base">Couldn't find any fishing spots</p>
        <p class="text-sm mt-1">Try a different area, or increase your Max Drive time.</p>
      </div>`;
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
          ${catchReleaseBadge(loc, 'mb-1.5')}
          ${statusNoticeBanner(loc, 'mb-1.5')}
          <div class="flex gap-2 items-center text-[11px] text-gray-500 font-medium">
            <span>📍 ${loc.distMiles} mi</span><span>•</span>
            <span>🚗 ~${Math.round(loc.estDriveHours * 60)} min</span>
            ${loc.weather && !loc.weather.usingFallback ? `<span>• ${Math.round(loc.weather.tempF)}°F</span>` : ''}
            ${loc.source === 'osm-live' ? '<span class="text-green-600">• Live</span>' : ''}
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
// The plain numeric Score badge shown in the header on the Overview/Fish/
// Amenities tabs. The Forecast tab swaps #headerScoreArea's contents for its
// own reactive Bite Action / Kid Comfort gauges (forecast.js) and switchTab()
// restores this markup when navigating back to another tab.
function headerScoreBadgeMarkup(loc) {
  return `<div class="bg-white/20 backdrop-blur-md p-3 rounded-xl text-center min-w-[60px]">
    <div class="text-[10px] uppercase font-black opacity-80">Score</div>
    <div class="text-xl font-black">${loc.score}</div>
  </div>`;
}
window.headerScoreBadgeMarkup = headerScoreBadgeMarkup;

function renderDetailContent(loc) {
  const moonPhase = getCurrentMoonPhase();
  const moonIcon  = getMoonIcon(moonPhase);
  const saved     = isSpotSaved(loc.id);

  const tempDisplay     = (loc.weather && !loc.weather.usingFallback) ? `${Math.round(loc.weather.tempF)}°F` : '--°F';
  const windDisplay     = (loc.weather && loc.weather.windMph != null && !loc.weather.usingFallback) ? `${Math.round(loc.weather.windMph)} mph` : '-- mph';
  const weatherNote     = (loc.weather && loc.weather.usingFallback)
    ? '<p class="text-[10px] text-yellow-600 mt-1">⚠️ Estimated weather — live data unavailable</p>'
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
            <div id="headerScoreArea" class="flex items-center gap-2">${headerScoreBadgeMarkup(loc)}</div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2 mb-3">
          ${tagPill(loc.accessibility, 'bg-white/20 text-white')}
          ${tagPill(loc.region, 'bg-white/20 text-white')}
          ${loc.source === 'osm-live' ? tagPill('Live Data', 'bg-white/20 text-white') : ''}
        </div>
        ${catchReleaseBadge(loc)}
        ${statusNoticeBanner(loc, 'mt-1.5')}
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
          <div id="inat-panel-${loc.id}" class="mb-6 bg-teal-50 border border-teal-100 rounded-xl p-4">
            <div class="text-[10px] uppercase font-black text-teal-600 mb-2">🌿 Community Fish Sightings</div>
            <div data-inat-body class="space-y-0.5">
              <div class="text-xs text-teal-600 italic">Loading recent observations nearby…</div>
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
          <div class="space-y-3 mb-6">
            <div class="flex justify-between text-xs"><span class="text-gray-500 font-bold uppercase">Legal Status</span><span class="font-black text-gray-700">${legalStatusLabel(loc.legalStatus)}</span></div>
            <div class="flex justify-between text-xs"><span class="text-gray-500 font-bold uppercase">Hours</span><span class="font-black text-gray-700">${formatHours(loc.hours)}</span></div>
          </div>
          ${loc.statusNotice && loc.statusNotice.message ? `
          <div class="mb-6 p-3 rounded-xl border ${loc.statusNotice.severity === 'closure' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'}">
            <div class="text-[10px] uppercase font-black mb-1">${loc.statusNotice.severity === 'closure' ? '🚧 Closed / Restricted' : '⚠️ Advisory'}</div>
            <div class="text-xs font-medium">${loc.statusNotice.message}</div>
          </div>` : ''}

          <h4 class="text-xs font-black uppercase tracking-widest text-gray-400 mb-3">Amenities Nearby</h4>
          <div class="grid grid-cols-2 gap-4">
            ${AMENITY_ITEMS.map(a => {
              const on = !!(loc.amenities && loc.amenities[a.key]);
              return `
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${on ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-300'}">${a.icon}</div>
                <div>
                  <div class="text-xs font-bold ${on ? 'text-gray-700' : 'text-gray-400'}">${a.label}</div>
                  ${on ? '' : '<div class="text-[10px] text-gray-300">Not listed</div>'}
                </div>
              </div>`;
            }).join('')}
          </div>

          <div class="mt-8 pt-6 border-t space-y-3">
            <div class="flex justify-between text-xs"><span class="text-gray-500 font-bold uppercase">Nearest Bait &amp; Tackle</span><span class="font-black text-gray-700 text-right">${nearbyBaitLabel(loc)}</span></div>
            <div class="flex justify-between text-xs"><span class="text-gray-500 font-bold uppercase">Fee</span><span class="font-black text-gray-700">${feeLabel(loc)}</span></div>
            <div>
              <div class="flex justify-between text-xs">
                <span class="text-gray-500 font-bold uppercase">Access Type</span>
                <span class="font-black text-gray-700">${loc.accessibility}${loc.wheelchairAccessible ? ' · ♿ ADA' : ''}</span>
              </div>
              <p class="text-[10px] ${loc.dnr ? 'text-emerald-600' : 'text-gray-400'} mt-1">${loc.dnr ? '✓ Verified via state DNR records' : 'Inferred from map data — not verified; use your judgment for young kids'}</p>
            </div>
          </div>
          ${typeof renderDNRPanel === 'function' ? renderDNRPanel(loc) : ''}
        </div>

        <div id="tab-forecast" style="display:none;">
          <div id="forecastRoot"></div>
        </div>
      </div>

      <div class="mx-5 mb-5 bg-yellow-50 border-2 border-dashed border-yellow-200 rounded-xl p-4">
        <div class="text-[10px] uppercase font-black text-yellow-600 mb-1">Parent Pro-Tip</div>
        <p id="parentProTipText" class="text-xs text-yellow-800 italic leading-relaxed font-medium">"${getProTip(loc)}"</p>
      </div>
    </div>`;

  // Kick off async iNaturalist enrichment for the Community Fish Sightings panel.
  loadAndRenderINatPanel(loc);
}

// ---------------------------------------------------------------------------
// iNaturalist community fish sightings (free, no API key)
// Fetches recent verifiable fish observations within 10 km / last 60 days and
// renders up to 5 into the Overview tab. Cached in-memory per spot for the
// session. Fully guarded — any failure degrades to a friendly message.
// ---------------------------------------------------------------------------
const _inatCache = {};

async function fetchINatSightings(lat, lng) {
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://api.inaturalist.org/v1/observations` +
    `?lat=${lat}&lng=${lng}&radius=10&iconic_taxa=Actinopterygii` +
    `&verifiable=true&photos=true&order=desc&order_by=observed_on` +
    `&per_page=5&d1=${since}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000); // PRD: 8s timeout
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`iNat HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json.results) ? json.results.slice(0, 5) : [];
  } finally {
    clearTimeout(timer);
  }
}

// "What's Biting Lately" — species chips derived from the sightings already
// fetched for the Community Fish Sightings panel above. No new network call:
// same iNat response, just aggregated by species instead of listed as links.
function whatsBitingChips(sightings) {
  const species = [];
  for (const o of sightings) {
    const name = (o.taxon && (o.taxon.preferred_common_name || o.taxon.name)) || null;
    if (name && !species.includes(name)) species.push(name);
  }
  if (!species.length) return '';
  const chips = species.map(s => `<span class="text-[10px] px-2 py-0.5 rounded-full bg-teal-600 text-white font-bold">${s}</span>`).join('');
  return `<div class="mb-2 pb-2 border-b border-teal-200">
    <div class="text-[10px] uppercase font-black text-teal-600 mb-1.5">🐟 What's Biting Lately</div>
    <div class="flex flex-wrap gap-1.5">${chips}</div>
  </div>`;
}

async function loadAndRenderINatPanel(loc) {
  const panel = document.getElementById(`inat-panel-${loc.id}`);
  if (!panel) return;
  const body = panel.querySelector('[data-inat-body]');
  const render = html => { if (body) body.innerHTML = html; };

  try {
    let sightings = _inatCache[loc.id];
    if (!sightings) {
      sightings = await fetchINatSightings(loc.coordinates.lat, loc.coordinates.lng);
      _inatCache[loc.id] = sightings;
    }
    if (!sightings.length) {
      render('<div class="text-xs text-teal-600 italic">No recent fish sightings reported nearby.</div>');
      return;
    }
    render(whatsBitingChips(sightings) + sightings.map(o => {
      const name  = (o.taxon && (o.taxon.preferred_common_name || o.taxon.name)) || 'Unknown fish';
      const when  = o.observed_on_string || o.observed_on || '';
      const who   = (o.user && (o.user.name || o.user.login)) || '';
      const photo = (o.photos && o.photos[0] && o.photos[0].url) ||
                    (o.taxon && o.taxon.default_photo && o.taxon.default_photo.square_url) || '';
      const thumb = photo
        ? `<img src="${photo}" alt="" class="w-10 h-10 rounded-lg object-cover flex-shrink-0" loading="lazy">`
        : `<div class="w-10 h-10 rounded-lg bg-teal-100 flex items-center justify-center flex-shrink-0">🐟</div>`;
      const meta  = [when, who].filter(Boolean).join(' · ');
      return `<a href="${o.uri || '#'}" target="_blank" rel="noopener"
                class="flex items-center gap-3 py-1.5 hover:bg-teal-100/50 rounded-lg -mx-1 px-1 transition-colors">
                ${thumb}
                <div class="min-w-0">
                  <div class="text-xs font-bold text-teal-900 truncate">${name}</div>
                  <div class="text-[10px] text-teal-600 truncate">${meta}</div>
                </div>
              </a>`;
    }).join(''));
  } catch (err) {
    console.warn('[iNat] enrichment failed:', err.message);
    render('<div class="text-xs text-teal-600 italic">Community sightings unavailable right now.</div>');
  }
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
  const childAge      = parseInt(document.getElementById('childAge').value)  || 6;
  const maxDriveHours = parseFloat(document.getElementById('driveTime').value) || 1.5;

  // Phase 2 (issue #36): pre-built, perimeter-scoped spot data replaces the
  // live per-search Overpass call. loadSpotsNearby (spots-loader.js) loads
  // only the data/spots/{ABBR}.json files for states inside the drive-time
  // perimeter, IndexedDB-cached; it falls back to live Overpass only for an
  // area with no pre-built file yet. DNR merging is no longer done here — it's
  // baked into those files at build time (issue #35).
  const locations = await loadSpotsNearby(userCoords.lat, userCoords.lng, maxDriveHours * 45);
  if (locations.length === 0) {
    showDataSourceBanner(false);
    showLoading(false);
    allResults = [];
    renderCards(allResults);
    return;
  }
  showDataSourceBanner(true);

  // No accessibility hard-filter (issue #34) — bank/dock access is advisory,
  // surfaced on the card and detail view, never used to exclude a spot from
  // results regardless of child age.
  const candidates = locations
    .map(loc => { const distMiles = haversineDistance(userCoords, loc.coordinates); return { ...loc, distMiles: Math.round(distMiles), estDriveHours: distMiles / 45 }; })
    .filter(loc => loc.estDriveHours <= maxDriveHours)
    .sort((a, b) => a.distMiles - b.distMiles);

  const spotWeathers = await Promise.all(candidates.map(loc => fetchWeather(loc.coordinates.lat, loc.coordinates.lng, true).catch(() => originWeather)));

  allResults = candidates.map((loc, i) => {
    const spotWeather = spotWeathers[i] || originWeather;
    // Record this pressure reading and read back the rolling trend (last 3
    // readings per spot in localStorage) so the trend actually contributes to
    // the score instead of defaulting to 'stable'.
    const pKey = coordKey(loc.coordinates.lat, loc.coordinates.lng);
    if (spotWeather && typeof spotWeather.pressureHpa === 'number') recordPressure(pKey, spotWeather.pressureHpa);
    const pressureTrend = getTrend(pKey);
    const score = calcSuccessScore(loc, spotWeather, moonPhase, childAge, pressureTrend);
    return { ...loc, weather: spotWeather, score, pressureTrend };
  });

  showLoading(false);
  renderCards(allResults);
}

document.getElementById('searchBtn').addEventListener('click', init);
