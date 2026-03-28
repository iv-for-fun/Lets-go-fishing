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

  const results = locations
    .map(loc => {
      const distMiles = haversineDistance(userCoords, loc.coordinates);
      const estDriveHours = distMiles / 45;
      const score = calcSuccessScore(loc, weather, moonPhase, childAge);
      return { ...loc, distMiles: Math.round(distMiles), estDriveHours, score };
    })
    .filter(loc => {
      if (childAge < 6 && loc.accessibility === "Obstructed Bank") return false;
      return loc.estDriveHours <= maxDriveHours;
    })
    .sort((a, b) => a.distMiles - b.distMiles);

  showLoading(false);
  renderCards(results);
}

document.getElementById("searchBtn").addEventListener("click", init);
window.addEventListener("load", init);
