// app.js — Main application logic

const CACHE_TTL = 21600; // 6 hours in seconds

async function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject("Geolocation not supported");
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => reject("Location denied")
    );
  });
}

function haversineDistance(coord1, coord2) {
  const R = 3958.8; // miles
  const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
  const dLng = (coord2.lng - coord1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(coord1.lat * Math.PI/180) * Math.cos(coord2.lat * Math.PI/180) *
    Math.sin(dLng/2)**2;
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
  const cacheKey = `weather_${lat.toFixed(2)}_${lng.toFixed(2)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${CONFIG.OPENWEATHER_API_KEY}&units=imperial`;
  const res = await fetch(url);
  const json = await res.json();
  const data = { tempF: json.main.temp, pressureHpa: json.main.pressure };
  setCache(cacheKey, data);
  return data;
}

async function init() {
  let userCoords;
  try {
    userCoords = await getLocation();
  } catch {
    userCoords = { lat: 33.749, lng: -84.388 }; // Atlanta fallback
  }

  const childAge = parseInt(document.getElementById("childAge").value) || 8;
  const maxDriveHours = parseFloat(document.getElementById("driveTime").value) || 1.5;
  const weather = await fetchWeather(userCoords.lat, userCoords.lng);

  // Mock moon phase (0–1); replace with StormGlass API call
  const moonPhase = 0.05;

  const locations = await fetch("data/locations.json").then(r => r.json());

  const results = locations
    .map(loc => {
      const distMiles = haversineDistance(userCoords, loc.coordinates);
      const estDriveHours = distMiles / 45; // rough avg speed
      const score = calcSuccessScore(loc, weather, moonPhase, childAge);
      return { ...loc, distMiles: Math.round(distMiles), estDriveHours, score };
    })
    .filter(loc => {
      if (childAge < 6 && loc.accessibility === "Obstructed Bank") return false;
      return loc.estDriveHours <= maxDriveHours;
    })
    .sort((a, b) => a.distMiles - b.distMiles);

  renderCards(results);
}

document.getElementById("searchBtn").addEventListener("click", init);
window.addEventListener("load", init);
