// app.js — Main application logic

const CACHE_TTL = 21600; // 6 hours in seconds

// Atlanta fallback coordinates
const ATLANTA_FALLBACK = { lat: 33.749, lng: -84.388 };

async function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject("Geolocation not supported");
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => reject("Location denied")
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
  const a = Math.sin(dLat/2)**2 + Math.cos(coord1.lat * Math.PI/180) * Math.cos(coord2.lat * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getCached(key) {
  const item = localStorage.getItem(key);
  if (!item) return null;
  const { data, timestamp } = JSON.parse(item);
  if ((Date.now() / 1000) - timestamp > CACHE_TTL) return null;
  return data;
}

function setCache(key, data) {
  localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() / 1000 }));
}

async function fetchWeather(lat, lng) {
  const hasKey = typeof CONFIG !== "undefined" && CONFIG.OPENWEATHER_API_KEY && CONFIG.OPENWEATHER_API_KEY.length > 10;
  if (!hasKey) return { tempF: 68, pressureHpa: 1016, usingFallback: true };
  const cacheKey = `weather_${lat.toFixed(2)}_${lng.toFixed(2)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${CONFIG.OPENWEATHER_API_KEY}&units=imperial`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OWM error: ${res.status}`);
    const json = await res.json();
    const data = { tempF: json.main.temp, pressureHpa: json.main.pressure };
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.warn("Weather fetch failed, using fallback:", err);
    return { tempF: 68, pressureHpa: 1016, usingFallback: true };
  }
}

function showLoading(show) {
  const el = document.getElementById("loadingState");
  if (el) el.style.display = show ? "block" : "none";
}

function showError(msg) {
  const container = document.getElementById("cardContainer");
  container.innerHTML = `<div class="text-center mt-8 p-4"><p class="text-red-500 font-semibold">⚠️ Something went wrong</p><p class="text-gray-500 text-sm mt-1">${msg}</p><button onclick="init()" class="mt-3 bg-green-700 text-white px-4 py-2 rounded text-sm">Try Again</button></div>`;
}

function showGpsBanner(show) {
  const el = document.getElementById("gpsBanner");
  if (el) el.style.display = show ? "block" : "none";
}

function showWeatherBanner(show) {
  const el = document.getElementById("weatherBanner");
  if (el) el.style.display = show ? "block" : "none";
}

function getCurrentMoonPhase() {
  const date = new Date();
  const refNew = new Date('2000-01-06T18:14:00Z');
  const diffMs = date - refNew;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return (diffDays % 29.53) / 29.53;
}

function renderCards(results) {
  const container = document.getElementById("cardContainer");
  if (results.length === 0) {
    container.innerHTML = `<div class="text-center py-20 text-gray-400 text-sm">No spots found within your drive time. Try increasing the Max Drive or checking your location.</div>`;
    return;
  }
  
  container.innerHTML = results.map(loc => `
    <div onclick="showDetailView('${loc.id}')" class="bg-white rounded-xl shadow-sm border p-4 flex gap-4 items-center cursor-pointer active:scale-[0.98] transition-all">
      <div class="w-16 h-16 bg-gray-100 rounded-lg flex items-center justify-center text-2xl">
        ${loc.accessibility === "Dock" ? '🛶' : '🏖️'}
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
        </div>
        <div class="flex gap-1 mt-2">
          ${loc.targetSpecies.slice(0, 2).map(s => tagPill(s)).join('')}
          ${loc.targetSpecies.length > 2 ? tagPill(`+${loc.targetSpecies.length - 2}`) : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function showDetailView(locId) {
  const loc = allResults.find(l => l.id === locId);
  if (!loc) return;

  document.getElementById("listView").style.display = "none";
  document.getElementById("detailView").style.display = "block";
  window.scrollTo(0, 0);

  const detailContent = document.getElementById("detailContent");
  
  const moonIcon = getMoonIcon(getCurrentMoonPhase());
  
  detailContent.innerHTML = `
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
          ${tagPill(loc.accessibility, "bg-white/20 text-white")}
          ${tagPill(loc.region, "bg-white/20 text-white")}
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex border-b bg-gray-50">
        <button id="btn-overview" onclick="switchTab('overview', '${loc.id}')" class="tab-btn tab-active flex-1">Overview</button>
        <button id="btn-fish" onclick="switchTab('fish', '${loc.id}')" class="tab-btn tab-inactive flex-1">Fish & Gear</button>
        <button id="btn-amenities" onclick="switchTab('amenities', '${loc.id}')" class="tab-btn tab-inactive flex-1">Amenities</button>
        <button id="btn-forecast" onclick="switchTab('forecast', '${loc.id}')" class="tab-btn tab-inactive flex-1">Forecast</button>
      </div>

      <div class="p-5">
        <!-- Overview Tab -->
        <div id="tab-overview">
          <div class="grid grid-cols-2 gap-3 mb-6">
            <div class="bg-blue-50 p-3 rounded-xl border border-blue-100">
              <div class="text-[10px] uppercase font-black text-blue-400 mb-1">Current Temp</div>
              <div class="text-xl font-black text-blue-900">${loc.weather?.tempF || '--'}°F</div>
            </div>
            <div class="bg-purple-50 p-3 rounded-xl border border-purple-100">
              <div class="text-[10px] uppercase font-black text-purple-400 mb-1">Moon Phase</div>
              <div class="text-xl font-black text-purple-900">${moonIcon} <span class="text-xs opacity-60">Today</span></div>
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

          <a href="https://www.google.com/maps/dir/?api=1&destination=${loc.coordinates.lat},${loc.coordinates.lng}" target="_blank"
            class="block w-full bg-green-700 text-white text-center py-4 rounded-xl font-black shadow-lg shadow-green-700/20 active:scale-95 transition-all">
            Get Directions
          </a>
        </div>

        <!-- Fish & Gear Tab -->
        <div id="tab-fish" style="display:none;">
          <div class="space-y-4">
            <div class="bg-orange-50 border border-orange-100 rounded-xl p-4">
              <h5 class="text-orange-800 font-bold text-sm mb-2 flex items-center gap-2">
                <span>🎣</span> Beginner Setup (Ages 3-7)
              </h5>
              <p class="text-xs text-orange-700 leading-relaxed">
                Lightweight 4ft spin-cast rod (Zebco Dock Demon style) with 6lb mono line. Small bobber, #8 gold hook, and live red wigglers or corn.
              </p>
            </div>
            <div class="bg-green-50 border border-green-100 rounded-xl p-4">
              <h5 class="text-green-800 font-bold text-sm mb-2 flex items-center gap-2">
                <span>🏅</span> Junior Pro (Ages 8+)
              </h5>
              <p class="text-xs text-green-700 leading-relaxed">
                5'6" medium-light spinning combo. Try 1/8oz rooster tails or small soft plastic worms (Senko style) near structure.
              </p>
            </div>
          </div>
        </div>

        <!-- Amenities Tab -->
        <div id="tab-amenities" style="display:none;">
          <div class="grid grid-cols-2 gap-4">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center ${loc.amenities.restrooms ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-300'}">
                🚻
              </div>
              <div class="text-xs font-bold ${loc.amenities.restrooms ? 'text-gray-700' : 'text-gray-400'}">Restrooms</div>
            </div>
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center ${loc.amenities.playground ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-300'}">
                🛝
              </div>
              <div class="text-xs font-bold ${loc.amenities.playground ? 'text-gray-700' : 'text-gray-400'}">Playground</div>
            </div>
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center ${loc.amenities.picnicTables ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-300'}">
                🧺
              </div>
              <div class="text-xs font-bold ${loc.amenities.picnicTables ? 'text-gray-700' : 'text-gray-400'}">Picnic Area</div>
            </div>
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center ${loc.amenities.shadedArea ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-300'}">
                🌳
              </div>
              <div class="text-xs font-bold ${loc.amenities.shadedArea ? 'text-gray-700' : 'text-gray-400'}">Shade</div>
            </div>
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
      
      <!-- Pro Tip Box -->
      <div class="mx-5 mb-5 bg-yellow-50 border-2 border-dashed border-yellow-200 rounded-xl p-4">
        <div class="text-[10px] uppercase font-black text-yellow-600 mb-1">Parent Pro-Tip</div>
        <p class="text-xs text-yellow-800 italic leading-relaxed font-medium">
          "The bank near the ${loc.accessibility === 'Dock' ? 'dock pilings' : 'big oak tree'} is usually stacked with Bluegill around 10am. Perfect for keeping the kids busy while you set up lunch!"
        </p>
      </div>
    </div>
  `;
}

async function init() {
  showLoading(true);
  showGpsBanner(false);
  showWeatherBanner(false);
  document.getElementById("cardContainer").innerHTML = "";

  const locationInput = document.getElementById("locationInput").value;
  let userCoords;

  const geocoded = await geocodeLocation(locationInput);
  if (geocoded) {
    userCoords = geocoded;
    showGpsBanner(true);
  } else {
    try {
      userCoords = await getLocation();
    } catch {
      userCoords = ATLANTA_FALLBACK;
      showGpsBanner(true);
    }
  }

  let weather;
  try {
    weather = await fetchWeather(userCoords.lat, userCoords.lng);
  } catch {
    weather = { tempF: 68, pressureHpa: 1016, usingFallback: true };
  }
  showWeatherBanner(!!weather.usingFallback);

  const moonPhase = getCurrentMoonPhase();

  let locations;
  try {
    locations = await fetch("data/locations.json").then(r => {
      if (!r.ok) throw new Error("Could not load locations");
      return r.json();
    });
  } catch (err) {
    showLoading(false);
    showError("Could not load fishing spots. " + err.message);
    return;
  }

  const childAge = parseInt(document.getElementById("childAge").value) || 6;
  const maxDriveHours = parseFloat(document.getElementById("driveTime").value) || 1.5;

  allResults = locations
    .map(loc => {
      const distMiles = haversineDistance(userCoords, loc.coordinates);
      const estDriveHours = distMiles / 45;
      const score = calcSuccessScore(loc, weather, moonPhase, childAge);
      return { ...loc, distMiles: Math.round(distMiles), estDriveHours, score, weather };
    })
    .filter(loc => {
      if (childAge < 6 && loc.accessibility === "Obstructed Bank") return false;
      return loc.estDriveHours <= maxDriveHours;
    })
    .sort((a, b) => a.distMiles - b.distMiles);

  showLoading(false);
  renderCards(allResults);
}

document.getElementById("searchBtn").addEventListener("click", init);

