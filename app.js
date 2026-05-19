// app.js — Main application logic
// DATA FRESHNESS GUARANTEE:
//   Every explicit "Find Spots" click busts both the weather and spots caches
//   for the resolved coordinates, so all detail-view data always reflects
//   the current location and the freshest available API data.

const CACHE_TTL = 21600; // 6 hours in seconds

// Atlanta fallback coordinates
const ATLANTA_FALLBACK = { lat: 33.749, lng: -84.388 };

// Overpass search radius — ~75 miles, filtered further by max drive time
const OVERPASS_RADIUS_M = 120000;

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------
async function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject('Geolocation not supported');
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => reject('Location denied')
    );
  });
}

async function geocodeLocation(locationString) {
  if (!locationString || locationString.trim() === '' || locationString.toLowerCase().includes('current')) {
    return null;
  }
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationString)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'LetsGoFishingApp/1.0' } });
    if (!res.ok) throw new Error('Geocoding failed');
    const data = await res.json();
    if (data.length === 0) throw new Error('Location not found');
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (err) {
    console.warn('Geocoding error:', err);
    return null;
  }
}

function haversineDistance(coord1, coord2) {
  const R = 3958.8;
  const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
  const dLng = (coord2.lng - coord1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Cache — keyed at 3 decimal places (~110m resolution) to prevent
// cross-location collisions that plagued the 2-decimal (1.1km) scheme.
// Force-busting: pass forceRefresh=true on explicit user searches.
// ---------------------------------------------------------------------------
function coordKey(lat, lng) {
  return `${lat.toFixed(3)}_${lng.toFixed(3)}`;
}

function getCached(key) {
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;
    const { data, timestamp } = JSON.parse(item);
    if ((Date.now() / 1000) - timestamp > CACHE_TTL) {
      localStorage.removeItem(key);
      return null;
    }
    return data;
  } catch { return null; }
}

function setCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() / 1000 }));
  } catch { /* storage unavailable */ }
}

function bustCacheForCoords(lat, lng) {
  // Remove both weather and spots cache entries for these coordinates
  // so that an explicit new search always fetches fresh data.
  const key = coordKey(lat, lng);
  try {
    localStorage.removeItem(`weather_${key}`);
    localStorage.removeItem(`spots_${key}`);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Weather fetch — per-spot weather using the spot's own coordinates
// so each card shows weather accurate to its location, not the user's origin.
// ---------------------------------------------------------------------------
async function fetchWeather(lat, lng, forceRefresh = false) {
  const hasKey = typeof CONFIG !== 'undefined' && CONFIG.OPENWEATHER_API_KEY && CONFIG.OPENWEATHER_API_KEY.length > 10;
  if (!hasKey) return { tempF: 68, pressureHpa: 1016, usingFallback: true };

  const cacheKey = `weather_${coordKey(lat, lng)}`;
  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${CONFIG.OPENWEATHER_API_KEY}&units=imperial`;
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
// Overpass API — live fishing spots near user coordinates
// forceRefresh busts the cache so a new location always gets fresh spots.
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
    const spots = normalizeOverpassResults(json.elements, lat, lng);
    if (spots.length > 0) setCache(cacheKey, spots);
    return spots;
  } catch (err) {
    console.warn('Overpass fetch failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalize OSM elements → app location schema
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
      name,
      coordinates: { lat: elLat, lng: elLng },
      accessibility,
      amenities,
      targetSpecies,
      fees,
      region,
      source: 'osm'
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
// Dynamic gear guide — recommendations keyed to the spot's actual species
// ---------------------------------------------------------------------------
const GEAR_DB = {
  // Beginner rigs (ages 3-7) by primary species
  beginner: {
    default:         { rod: '4ft Zebco spin-cast (Dock Demon)',    line: '6lb mono',  rig: 'Small bobber, #8 gold hook',         bait: 'red wigglers or corn' },
    'Bluegill':      { rod: '4ft Zebco spin-cast (Dock Demon)',    line: '6lb mono',  rig: 'Small bobber, #8 gold hook',         bait: 'red worms or crickets' },
    'Bream':         { rod: '4ft Zebco spin-cast (Dock Demon)',    line: '6lb mono',  rig: 'Small bobber, #8 gold hook',         bait: 'red worms or crickets' },
    'Crappie':       { rod: '4ft Zebco spin-cast',                 line: '6lb mono',  rig: 'Small bobber, #6 hook, split shot',  bait: 'small minnow or jig (1/32oz)' },
    'Catfish':       { rod: '5ft medium spin-cast',                line: '10lb mono', rig: 'Bottom rig, #4 circle hook',         bait: 'chicken liver or nightcrawlers' },
    'Bass':          { rod: '4.5ft light spin-cast',               line: '8lb mono',  rig: 'Wacky rig or small spinner',         bait: 'plastic worm or curly tail grub' },
    'Largemouth Bass': { rod: '4.5ft light spin-cast',             line: '8lb mono',  rig: 'Wacky rig or small inline spinner',  bait: 'plastic worm or live shiner' },
    'Walleye':       { rod: '5ft medium spin-cast',                line: '8lb mono',  rig: 'Slip bobber, #4 hook',               bait: 'nightcrawler on a plain hook' },
    'Northern Pike': { rod: '5ft medium-heavy spin-cast',          line: '14lb mono', rig: 'Wire leader, #2 treble hook',        bait: 'large shiner or flashy spoon' },
    'Perch':         { rod: '4ft light spin-cast',                 line: '6lb mono',  rig: 'Small bobber, #8 hook',              bait: 'small minnow or waxworm' },
    'Striped Bass':  { rod: '5ft medium spin-cast',                line: '12lb mono', rig: 'Float rig, #2 hook',                 bait: 'live shad or cut bait' },
  },
  // Junior pro rigs (ages 8+)
  pro: {
    default:         { rod: "5'6\" medium-light spinning combo",   line: '8lb mono',  rig: '1/8oz rooster tail or Senko worm',  bait: 'soft plastic worms near structure' },
    'Bluegill':      { rod: "5' ultralight spinning",              line: '4lb fluoro', rig: '1/32oz jig head',                  bait: 'small tube or twister tail' },
    'Bream':         { rod: "5' ultralight spinning",              line: '4lb fluoro', rig: '1/32oz jig head',                  bait: 'small tube or cricket on a hook' },
    'Crappie':       { rod: "6' light spinning",                   line: '6lb fluoro', rig: '1/16oz marabou jig',               bait: 'crappie tube or small minnow' },
    'Catfish':       { rod: "6'6\" medium-heavy spinning",         line: '17lb mono', rig: 'Slip sinker rig, #1 circle hook',   bait: 'stink bait or cut shad' },
    'Bass':          { rod: "6' medium spinning",                  line: '10lb fluoro', rig: '3/16oz Texas-rig',                bait: '4" plastic worm or Senko' },
    'Largemouth Bass': { rod: "6'6\" medium baitcaster or spinning", line: '12lb fluoro', rig: '1/4oz jig or Texas-rig',        bait: 'creature bait or swim jig near cover' },
    'Walleye':       { rod: "6' medium spinning",                  line: '8lb fluoro', rig: '1/4oz jig head',                   bait: '3" paddle tail swimbait or live crawler' },
    'Northern Pike': { rod: "6'6\" medium-heavy spinning",         line: '20lb braid + wire leader', rig: 'Inline spinner or swim bait', bait: '5" swimbait or large spoon' },
    'Perch':         { rod: "5' light spinning",                   line: '6lb mono',  rig: '1/16oz jig or drop shot',           bait: 'small minnow or perch eye' },
    'Striped Bass':  { rod: "7' medium-heavy spinning",            line: '20lb braid', rig: 'Bucktail jig or live-liner rig',   bait: 'live bunker or large swimshad' },
  }
};

function getGearRecommendation(targetSpecies, isBeginnerAge) {
  const db = isBeginnerAge ? GEAR_DB.beginner : GEAR_DB.pro;
  // Find the first species in the spot's list that has a specific entry
  for (const sp of targetSpecies) {
    if (db[sp]) return db[sp];
  }
  return db.default;
}

function renderGearGuide(loc) {
  const beginnerGear = getGearRecommendation(loc.targetSpecies, true);
  const proGear = getGearRecommendation(loc.targetSpecies, false);
  const primarySpecies = loc.targetSpecies[0] || 'fish';

  return `
    <div class="space-y-4">
      <p class="text-[11px] text-gray-400 font-semibold uppercase tracking-widest mb-1">
        Gear matched to: ${loc.targetSpecies.slice(0, 3).join(', ')}
      </p>
      <div class="bg-orange-50 border border-orange-100 rounded-xl p-4">
        <h5 class="text-orange-800 font-bold text-sm mb-2 flex items-center gap-2">
          <span>🎣</span> Beginner Setup (Ages 3–7)
        </h5>
        <ul class="text-xs text-orange-700 space-y-1 leading-relaxed">
          <li><span class="font-bold">Rod:</span> ${beginnerGear.rod}</li>
          <li><span class="font-bold">Line:</span> ${beginnerGear.line}</li>
          <li><span class="font-bold">Rig:</span> ${beginnerGear.rig}</li>
          <li><span class="font-bold">Bait:</span> ${beginnerGear.bait}</li>
        </ul>
      </div>
      <div class="bg-green-50 border border-green-100 rounded-xl p-4">
        <h5 class="text-green-800 font-bold text-sm mb-2 flex items-center gap-2">
          <span>🏅</span> Junior Pro (Ages 8+)
        </h5>
        <ul class="text-xs text-green-700 space-y-1 leading-relaxed">
          <li><span class="font-bold">Rod:</span> ${proGear.rod}</li>
          <li><span class="font-bold">Line:</span> ${proGear.line}</li>
          <li><span class="font-bold">Rig:</span> ${proGear.rig}</li>
          <li><span class="font-bold">Bait:</span> ${proGear.bait}</li>
        </ul>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Pro Tip — species-specific, location-aware
// ---------------------------------------------------------------------------
function getProTip(loc) {
  const species = loc.targetSpecies[0] || 'panfish';
  const isDock = loc.accessibility === 'Dock';
  const tips = {
    'Bluegill':        isDock ? `Drop a cricket right under the dock's shadow — Bluegill stack there all morning.` : `Work the shady bank edges with a bobber and worm early in the morning.`,
    'Bream':           `Bream love the shade. Cast near overhanging branches and let the bait settle naturally.`,
    'Crappie':         isDock ? `Vertical jig along the dock pilings — Crappie suspend at 4–8ft around structure.` : `Cast parallel to any fallen logs or brush piles. Crappie love ambush cover.`,
    'Catfish':         `Set a bottom bait near the deepest hole you can find and let it sit. Catfish do the work for you — great for keeping young anglers patient.`,
    'Bass':            isDock ? `Flip a plastic worm right to the dock pilings — Bass use structure as ambush points.` : `Walk the bank slowly and cast to any shady pockets or visible cover.`,
    'Largemouth Bass': isDock ? `Flip a creature bait tight to dock pilings on the shady side — Bass ambush from structure.` : `Target any visible cover (stumps, laydowns, grass edges) with a slow-rolled worm.`,
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
// Static fallback spots (Atlanta area) — only used if Overpass returns nothing
// ---------------------------------------------------------------------------
const STATIC_FALLBACK_SPOTS = [
  {
    id: 'lake-allatoona-001', name: 'Lake Allatoona — McKaskey Creek',
    coordinates: { lat: 34.1473, lng: -84.7229 }, accessibility: 'Dock',
    amenities: { restrooms: true, playground: true, picnicTables: true, shadedArea: true },
    targetSpecies: ['Largemouth Bass', 'Crappie', 'Bluegill'],
    fees: { parking: '$5/day', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static'
  },
  {
    id: 'stone-mountain-lake-001', name: 'Stone Mountain Park — Fishing Area',
    coordinates: { lat: 33.8081, lng: -84.1452 }, accessibility: 'Clear Bank',
    amenities: { restrooms: true, playground: true, picnicTables: true, shadedArea: true },
    targetSpecies: ['Bass', 'Bluegill', 'Catfish'],
    fees: { parking: '$20/vehicle', fishing: 'Free with park entry' }, region: 'Atlanta, GA', source: 'static'
  },
  {
    id: 'sweetwater-creek-001', name: 'Sweetwater Creek State Park',
    coordinates: { lat: 33.7490, lng: -84.6271 }, accessibility: 'Clear Bank',
    amenities: { restrooms: true, playground: false, picnicTables: true, shadedArea: true },
    targetSpecies: ['Bass', 'Bream', 'Catfish'],
    fees: { parking: '$5/day', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static'
  },
  {
    id: 'lake-lanier-001', name: 'Lake Lanier — Sawnee Campground Dock',
    coordinates: { lat: 34.1732, lng: -84.0168 }, accessibility: 'Dock',
    amenities: { restrooms: true, playground: false, picnicTables: true, shadedArea: true },
    targetSpecies: ['Striped Bass', 'Largemouth Bass', 'Crappie'],
    fees: { parking: '$5/day', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static'
  },
  {
    id: 'kennesaw-mountain-pond-001', name: 'Kennesaw Mountain — Visitors Pond',
    coordinates: { lat: 33.9748, lng: -84.5766 }, accessibility: 'Clear Bank',
    amenities: { restrooms: true, playground: true, picnicTables: true, shadedArea: true },
    targetSpecies: ['Bluegill', 'Bass', 'Catfish'],
    fees: { parking: 'Free', fishing: 'GA License Required' }, region: 'Atlanta, GA', source: 'static'
  }
];

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showLoading(show) {
  const el = document.getElementById('loadingState');
  if (el) el.style.display = show ? 'block' : 'none';
}

function showError(msg) {
  const container = document.getElementById('cardContainer');
  container.innerHTML = `<div class="text-center mt-8 p-4"><p class="text-red-500 font-semibold">⚠️ Something went wrong</p><p class="text-gray-500 text-sm mt-1">${msg}</p><button onclick="init()" class="mt-3 bg-green-700 text-white px-4 py-2 rounded text-sm">Try Again</button></div>`;
}

function showGpsBanner(show) {
  const el = document.getElementById('gpsBanner');
  if (el) el.style.display = show ? 'block' : 'none';
}

function showWeatherBanner(show) {
  const el = document.getElementById('weatherBanner');
  if (el) el.style.display = show ? 'block' : 'none';
}

function showDataSourceBanner(source) {
  let el = document.getElementById('dataSourceBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dataSourceBanner';
    document.querySelector('header').after(el);
  }
  if (source === 'osm') {
    el.className = 'px-4 py-2 text-[11px] font-medium border-b bg-green-50 border-green-200 text-green-800';
    el.textContent = '🗺️ Showing live fishing spots near your location from OpenStreetMap.';
  } else {
    el.className = 'px-4 py-2 text-[11px] font-medium border-b bg-yellow-50 border-yellow-200 text-yellow-800';
    el.textContent = '📋 Showing curated Atlanta-area spots — live data unavailable for this location.';
  }
  el.style.display = 'block';
}

function getCurrentMoonPhase() {
  const refNew = new Date('2000-01-06T18:14:00Z');
  const diffDays = (Date.now() - refNew) / (1000 * 60 * 60 * 24);
  return (diffDays % 29.53) / 29.53;
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
  container.innerHTML = results.map(loc => `
    <div onclick="showDetailView('${loc.id}')" class="bg-white rounded-xl shadow-sm border p-4 flex gap-4 items-center cursor-pointer active:scale-[0.98] transition-all">
      <div class="w-16 h-16 bg-gray-100 rounded-lg flex items-center justify-center text-2xl">
        ${loc.accessibility === 'Dock' ? '🛶' : '🏖️'}
      </div>
      <div class="flex-1">
        <div class="flex justify-between items-start mb-1">
          <h3 class="font-bold text-gray-800 leading-tight">${loc.name}</h3>
          ${scoreBadge(loc.score)}
        </div>
        <div class="flex gap-2 items-center text-[11px] text-gray-500 font-medium">
          <span>📍 ${loc.distMiles} mi</span>
          <span>•</span>
          <span>🚗 ~${Math.round(loc.estDriveHours * 60)} min</span>
          ${loc.weather && !loc.weather.usingFallback ? `<span>• ${Math.round(loc.weather.tempF)}°F</span>` : ''}
          ${loc.source === 'osm' ? '<span class="text-green-600">• Live</span>' : ''}
        </div>
        <div class="flex gap-1 mt-2">
          ${loc.targetSpecies.slice(0, 2).map(s => tagPill(s)).join('')}
          ${loc.targetSpecies.length > 2 ? tagPill(`+${loc.targetSpecies.length - 2}`) : ''}
        </div>
      </div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Detail view — all data sourced directly from the enriched loc object
// which is set fresh on every init() call (no stale globals).
// ---------------------------------------------------------------------------
function showDetailView(locId) {
  const loc = allResults.find(l => l.id === locId);
  if (!loc) return;

  document.getElementById('listView').style.display = 'none';
  document.getElementById('detailView').style.display = 'block';
  window.scrollTo(0, 0);

  const moonPhase = getCurrentMoonPhase();
  const moonIcon = getMoonIcon(moonPhase);

  // Weather values — from the loc's own fetched weather, not a global
  const tempDisplay = (loc.weather && !loc.weather.usingFallback)
    ? `${Math.round(loc.weather.tempF)}°F`
    : '--°F';
  const pressureDisplay = (loc.weather && !loc.weather.usingFallback)
    ? `${loc.weather.pressureHpa} hPa`
    : '-- hPa';
  const windDisplay = (loc.weather && loc.weather.windMph != null && !loc.weather.usingFallback)
    ? `${Math.round(loc.weather.windMph)} mph`
    : '-- mph';
  const weatherNote = (loc.weather && loc.weather.usingFallback)
    ? '<p class="text-[10px] text-yellow-600 mt-1">⚠️ Estimated weather — add API key for live data</p>'
    : `<p class="text-[10px] text-gray-400 mt-1">${loc.weather.description || ''}</p>`;

  document.getElementById('detailContent').innerHTML = `
    <div class="bg-white rounded-2xl shadow-sm border overflow-hidden mb-6">
      <div class="bg-green-700 p-6 text-white">
        <div class="flex justify-between items-start mb-4">
          <h2 class="text-2xl font-black leading-tight">${loc.name}</h2>
          <div class="bg-white/20 backdrop-blur-md p-3 rounded-xl text-center min-w-[70px]">
            <div class="text-[10px] uppercase font-black opacity-80">Score</div>
            <div class="text-2xl font-black">${loc.score}</div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${tagPill(loc.accessibility, 'bg-white/20 text-white')}
          ${tagPill(loc.region, 'bg-white/20 text-white')}
          ${loc.source === 'osm' ? tagPill('Live Data', 'bg-white/20 text-white') : ''}
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex border-b bg-gray-50">
        <button id="btn-overview"  onclick="switchTab('overview','${loc.id}')"  class="tab-btn tab-active flex-1">Overview</button>
        <button id="btn-fish"      onclick="switchTab('fish','${loc.id}')"      class="tab-btn tab-inactive flex-1">Fish &amp; Gear</button>
        <button id="btn-amenities" onclick="switchTab('amenities','${loc.id}')" class="tab-btn tab-inactive flex-1">Amenities</button>
        <button id="btn-forecast"  onclick="switchTab('forecast','${loc.id}')"  class="tab-btn tab-inactive flex-1">Forecast</button>
      </div>

      <div class="p-5">

        <!-- Overview Tab -->
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
              </div>
            `).join('')}
          </div>

          <a href="https://www.google.com/maps/dir/?api=1&destination=${loc.coordinates.lat},${loc.coordinates.lng}"
            target="_blank"
            class="block w-full bg-green-700 text-white text-center py-4 rounded-xl font-black shadow-lg shadow-green-700/20 active:scale-95 transition-all">
            Get Directions
          </a>
        </div>

        <!-- Fish & Gear Tab — dynamic per loc.targetSpecies -->
        <div id="tab-fish" style="display:none;">
          ${renderGearGuide(loc)}
        </div>

        <!-- Amenities Tab -->
        <div id="tab-amenities" style="display:none;">
          <div class="grid grid-cols-2 gap-4">
            ${[
              { key: 'restrooms',    icon: '🚻', label: 'Restrooms' },
              { key: 'playground',   icon: '🛝', label: 'Playground' },
              { key: 'picnicTables', icon: '🧺', label: 'Picnic Area' },
              { key: 'shadedArea',   icon: '🌳', label: 'Shade' }
            ].map(a => `
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full flex items-center justify-center ${loc.amenities[a.key] ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-300'}">
                  ${a.icon}
                </div>
                <div class="text-xs font-bold ${loc.amenities[a.key] ? 'text-gray-700' : 'text-gray-400'}">${a.label}</div>
              </div>
            `).join('')}
          </div>
          <div class="mt-8 pt-6 border-t space-y-3">
            <div class="flex justify-between text-xs">
              <span class="text-gray-500 font-bold uppercase">Parking Fee</span>
              <span class="font-black text-gray-700">${loc.fees.parking}</span>
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-gray-500 font-bold uppercase">Fishing License</span>
              <span class="font-black text-gray-700">${loc.fees.fishing}</span>
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-gray-500 font-bold uppercase">Access Type</span>
              <span class="font-black text-gray-700">${loc.accessibility}</span>
            </div>
          </div>
        </div>

        <!-- Forecast Tab -->
        <div id="tab-forecast" style="display:none;">
          <div id="forecastGrid" class="grid grid-cols-7 gap-1"></div>
          <div class="mt-4 flex gap-4 justify-center">
            <div class="flex items-center gap-1 text-[10px] font-bold"><div class="w-2 h-2 rounded bg-green-400"></div> Excellent</div>
            <div class="flex items-center gap-1 text-[10px] font-bold"><div class="w-2 h-2 rounded bg-yellow-300"></div> Good</div>
            <div class="flex items-center gap-1 text-[10px] font-bold"><div class="w-2 h-2 rounded bg-red-400"></div> Poor</div>
          </div>
        </div>

      </div>

      <!-- Pro Tip — species-specific, location-aware -->
      <div class="mx-5 mb-5 bg-yellow-50 border-2 border-dashed border-yellow-200 rounded-xl p-4">
        <div class="text-[10px] uppercase font-black text-yellow-600 mb-1">Parent Pro-Tip</div>
        <p class="text-xs text-yellow-800 italic leading-relaxed font-medium">
          "${getProTip(loc)}"
        </p>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main init — called on every "Find Spots" click.
// Flow:
//  1. Resolve coordinates (typed input → Nominatim → GPS → Atlanta fallback)
//  2. BUST cache for those coordinates (always fetch fresh on explicit search)
//  3. Fetch weather at user origin (for score calculation baseline)
//  4. Fetch live spots via Overpass
//  5. For each spot, fetch its own weather concurrently (per-spot accuracy)
//  6. Score, filter, sort — then render. All data in allResults[] is fresh.
// ---------------------------------------------------------------------------
async function init() {
  showLoading(true);
  showGpsBanner(false);
  showWeatherBanner(false);
  document.getElementById('cardContainer').innerHTML = '';

  // Step 1 — resolve user coordinates
  const locationInput = document.getElementById('locationInput').value;
  let userCoords;

  const geocoded = await geocodeLocation(locationInput);
  if (geocoded) {
    userCoords = geocoded;
  } else {
    try {
      userCoords = await getLocation();
    } catch {
      userCoords = ATLANTA_FALLBACK;
      showGpsBanner(true);
    }
  }

  // Step 2 — bust stale cache so this search is always fresh data
  bustCacheForCoords(userCoords.lat, userCoords.lng);

  // Step 3 — fetch origin weather (used for scoring)
  let originWeather;
  try {
    originWeather = await fetchWeather(userCoords.lat, userCoords.lng, true);
  } catch {
    originWeather = { tempF: 68, pressureHpa: 1016, usingFallback: true };
  }
  showWeatherBanner(!!originWeather.usingFallback);

  const moonPhase = getCurrentMoonPhase();

  // Step 4 — fetch live spots (force-refreshed, no stale cache)
  let locations = await fetchFishingSpotsNearby(userCoords.lat, userCoords.lng, true);
  const usingLiveData = locations.length > 0;
  if (!usingLiveData) locations = STATIC_FALLBACK_SPOTS;
  showDataSourceBanner(usingLiveData ? 'osm' : 'static');

  const childAge = parseInt(document.getElementById('childAge').value) || 6;
  const maxDriveHours = parseFloat(document.getElementById('driveTime').value) || 1.5;

  // Step 5 — compute distances, filter, then fetch per-spot weather concurrently
  const candidates = locations
    .map(loc => {
      const distMiles = haversineDistance(userCoords, loc.coordinates);
      const estDriveHours = distMiles / 45;
      return { ...loc, distMiles: Math.round(distMiles), estDriveHours };
    })
    .filter(loc => {
      if (childAge < 6 && loc.accessibility === 'Obstructed Bank') return false;
      return loc.estDriveHours <= maxDriveHours;
    })
    .sort((a, b) => a.distMiles - b.distMiles);

  // Fetch each spot's own live weather in parallel — accurate to the spot's coords
  const weatherPromises = candidates.map(loc =>
    fetchWeather(loc.coordinates.lat, loc.coordinates.lng, true)
      .catch(() => originWeather)
  );
  const spotWeathers = await Promise.all(weatherPromises);

  // Step 6 — attach per-spot weather, score, finalize allResults[]
  allResults = candidates.map((loc, i) => {
    const spotWeather = spotWeathers[i] || originWeather;
    const score = calcSuccessScore(loc, spotWeather, moonPhase, childAge);
    return { ...loc, weather: spotWeather, score };
  });

  showLoading(false);
  renderCards(allResults);
}

document.getElementById('searchBtn').addEventListener('click', init);
