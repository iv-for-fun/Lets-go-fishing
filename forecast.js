// forecast.js — Reactive 7-Day Kid-Friendly Fishing Forecast Engine
//
// Data: Open-Meteo (free, no API key), one batched call per spot covering
// 7 days of hourly + daily fields, cached like the rest of the app's
// weather data (see getCached/setCache/coordKey in app.js).
//
// Scoring: per-hour Fish Activity + Kid Comfort sub-scores with hard
// safety/comfort overrides, aggregated to daily stars/labels and a
// "Best Window" (highest-scoring 2-3hr span). See PRD.md for the full
// algorithm writeup.
//
// State: a single `selectedDate` drives all reactive UI pieces (header
// gauges, summary banner, hourly timeline, Parent Pro-Tip) — see
// selectDay() at the bottom.

const FORECAST_CACHE_PREFIX = 'forecast7_';
const FORECAST_DAYLIGHT_START_HOUR = 5;  // aggregation/best-window search window
const FORECAST_DAYLIGHT_END_HOUR   = 21;

// ---------------------------------------------------------------------------
// WMO weather code -> text/icon (shared with app.js's fetchWeather)
// ---------------------------------------------------------------------------
const WMO_WEATHER_TEXT = {
  0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm'
};
const WMO_WEATHER_ICON = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌦️', 56: '🌧️', 57: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '🌧️', 66: '🌨️', 67: '🌨️',
  71: '🌨️', 73: '🌨️', 75: '❄️', 77: '❄️',
  80: '🌦️', 81: '🌧️', 82: '⛈️', 85: '🌨️', 86: '❄️',
  95: '⛈️', 96: '⛈️', 99: '⛈️'
};
function describeWeatherCode(code) { return WMO_WEATHER_TEXT[code] || ''; }
function weatherCodeIcon(code) { return WMO_WEATHER_ICON[code] || '🌡️'; }
window.describeWeatherCode = describeWeatherCode;

// ---------------------------------------------------------------------------
// Small time helpers
// ---------------------------------------------------------------------------
// Open-Meteo (timezone=auto) returns local wall-clock ISO strings with no
// UTC offset, e.g. "2026-07-13T14:00". Parsing that string *as if* it were
// UTC gives every local timestamp a consistent numeric "pretend-UTC" ms
// value; shifting real UTC solunar times by utc_offset_seconds lands them
// in that same pretend timeline, so the two can be compared directly
// without ever resolving a real IANA timezone.
function parseLocalAsPretendUTC(isoLocalStr) {
  return new Date(isoLocalStr.length === 16 ? isoLocalStr + ':00Z' : isoLocalStr + 'Z').getTime();
}
function formatHourLabel(hour24) {
  const h = ((hour24 + 11) % 12) + 1;
  return `${h}:00 ${hour24 < 12 ? 'AM' : 'PM'}`;
}

// ---------------------------------------------------------------------------
// Trend classification — reuses the same ±1.5 hPa threshold as scorer.js's
// getTrend(), contiguous (no undefined gap between the buckets).
// ---------------------------------------------------------------------------
function classifyPressureTrend(deltaHpa) {
  if (deltaHpa < -1.5) return 'falling';
  if (deltaHpa > 1.5) return 'rising';
  return 'stable';
}
function pressureTrendIcon(trend) {
  return trend === 'falling' ? '↘️' : trend === 'rising' ? '↗️' : '➡️';
}
function pressureTrendLabel(trend) {
  return trend === 'falling' ? 'Falling Pressure' : trend === 'rising' ? 'Rising Pressure' : 'Stable Pressure';
}

// Unified wind breakpoints (used for BOTH the qualitative UI label and the
// Kid Comfort penalty — the source spec had these disagree at the 8-11mph
// boundary; scoring's thresholds win since they drive the safety override).
function windTier(mph) {
  if (mph <= 7) return { tier: 'calm', icon: '🍃', label: 'Calm' };
  if (mph <= 11) return { tier: 'light', icon: '💨', label: 'Light Breeze' };
  return { tier: 'windy', icon: '⚠️', label: 'Choppy / Windy' };
}

// ---------------------------------------------------------------------------
// Step 1: Fish Activity Sub-Score (baseline 50)
// ---------------------------------------------------------------------------
function computeFishActivity(h, ctx) {
  let score = 50;

  if (h.pressureTrend === 'falling') score += 30;
  else if (h.pressureTrend === 'rising') score -= 20;
  else score += 15; // stable

  let light = 0;
  if (ctx.isGoldenLight) light += 20;
  if (h.cloudCoverPct > 60) light += 10;
  if (h.hour >= 11 && h.hour < 15 && h.cloudCoverPct < 15) light -= 15;
  score += Math.max(-20, Math.min(20, light)); // clamp to the stated ±20 cap

  if (ctx.inSolunarWindow || ctx.newOrFullMoon) score += 10;

  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Step 2: Kid Comfort Sub-Score (baseline 100) + warning badges
// ---------------------------------------------------------------------------
function computeKidComfort(h) {
  let score = 100;
  const badges = [];

  if (h.tempF >= 65 && h.tempF <= 85) { /* ideal, no penalty */ }
  else if ((h.tempF >= 55 && h.tempF < 65) || (h.tempF >= 86 && h.tempF < 92)) score -= 30;
  else if (h.tempF < 55) { score -= 100; badges.push('🥶'); }
  else { score -= 100; badges.push('🥵'); } // >= 92

  const wt = windTier(h.windMph);
  if (wt.tier === 'light') score -= 40;
  else if (wt.tier === 'windy' || h.windGustMph > 18) { score -= 100; badges.push('💨'); }

  if (h.precipProbPct > 40 || h.precipMm >= 2.5) { score -= 100; badges.push('⚡'); }

  return { score, badges };
}

// ---------------------------------------------------------------------------
// Step 3: Compound final hourly rating
// ---------------------------------------------------------------------------
function compoundHourRating(fishScore, comfort) {
  // Force Poor whenever comfort drops below the safety floor, regardless of
  // which single penalty (or stack of smaller ones) caused it — simpler and
  // safer than only checking for an individual "immediate fail" parameter.
  if (comfort.score < 40) return { rating: 'poor', badges: comfort.badges };
  if (fishScore >= 75) return { rating: 'excellent', badges: comfort.badges };
  if (fishScore >= 45) return { rating: 'good', badges: comfort.badges };
  return { rating: 'poor', badges: comfort.badges };
}

function ratingColor(rating) {
  return rating === 'excellent' ? 'green' : rating === 'good' ? 'yellow' : 'red';
}
function ratingDot(rating) {
  return rating === 'excellent' ? '🟢' : rating === 'good' ? '🟡' : '🔴';
}

// ---------------------------------------------------------------------------
// Daily aggregation: 0-100 average (5am-9pm window) -> 0-3 stars (half-step)
// ---------------------------------------------------------------------------
function scoreToStars(avg) {
  return Math.round((Math.max(0, Math.min(100, avg)) / 100) * 3 * 2) / 2;
}
function renderStars(stars) {
  const full = Math.floor(stars);
  const half = stars - full >= 0.5;
  return '⭐'.repeat(full) + (half ? '✨' : '') + '☆'.repeat(Math.max(0, 3 - full - (half ? 1 : 0)));
}
function biteLabelFor(avg) { return avg >= 75 ? 'HIGH' : avg >= 45 ? 'FAIR' : 'LOW'; }
function comfortLabelFor(avg) { return avg >= 80 ? 'GREAT' : avg >= 50 ? 'OK' : 'ROUGH'; }

// ---------------------------------------------------------------------------
// Best Window: highest-average 2hr or 3hr span within the daylight range
// ---------------------------------------------------------------------------
function scanWindows(candidates, sizes) {
  let best = null;
  // A comfort-overridden hour (Kid Comfort < 40) contributes 0 here — the
  // "Parent-Trust Metric" means an unsafe/miserable hour can never win the
  // Best Window no matter how high its raw fish activity is.
  sizes.forEach(size => {
    for (let i = 0; i + size <= candidates.length; i++) {
      const span = candidates.slice(i, i + size);
      const avg = span.reduce((s, h) => s + (h.comfortOverride ? 0 : h.fishScore), 0) / span.length;
      if (!best || avg > best.avg || (avg === best.avg && size > best.size)) {
        best = { avg, size, startHour: span[0].hour, endHour: span[span.length - 1].hour + 1, hours: span };
      }
    }
  });
  return best;
}

function findBestWindow(hours) {
  // Today may have very few real hours left (Open-Meteo's hourly array
  // starts at the current hour, not midnight) — degrade window size, then
  // the daylight-hours restriction itself, before giving up.
  const daylight = hours.filter(h => h.hour >= FORECAST_DAYLIGHT_START_HOUR && h.hour <= FORECAST_DAYLIGHT_END_HOUR);
  return scanWindows(daylight, [2, 3]) || scanWindows(hours, [2, 3]) ||
    scanWindows(hours, [1]) || { avg: 0, size: 0, startHour: 0, endHour: 0, hours: [] };
}

// ---------------------------------------------------------------------------
// Summary banner — template-fill from the peak window's dominant factors
// ---------------------------------------------------------------------------
function buildSummaryBanner(day) {
  const bw = day.bestWindow;
  const startLabel = formatHourLabel(bw.startHour);
  const endLabel = formatHourLabel(bw.endHour);
  const reasons = [];
  const anyFalling = bw.hours.some(h => h.pressureTrend === 'falling');
  const anyCalm = bw.hours.every(h => windTier(h.windMph).tier === 'calm');
  const anyGolden = bw.hours.some(h => h._isGoldenLight);
  const anyHot = day.hours.some(h => h.hour >= 12 && h.hour <= 16 && h.tempF >= 86);

  if (anyFalling) reasons.push('falling pressure');
  if (anyCalm) reasons.push('low winds');
  if (anyGolden && !anyFalling) reasons.push('great low-light conditions');
  const reasonText = reasons.length ? reasons.join(' and ') : 'steady conditions';

  if (day.dayRating === 'excellent') {
    return { tone: 'excellent', text:
      `Best window today is ${startLabel} – ${endLabel}. It's a true peak! ${cap(reasonText)} mean the fish will be active and the kids will stay dry.` };
  }
  if (day.dayRating === 'good') {
    const afternoonNote = anyHot ? 'While the afternoon is too hot, this window' : 'This window';
    return { tone: 'good', text:
      `Best window today is ${startLabel} – ${endLabel}. ${afternoonNote} offers a nice breeze and a minor feeding cycle.` };
  }
  return { tone: 'poor', text:
    `Best window today is ${startLabel} – ${endLabel}. It's still not great due to ${anyHot ? 'the mid-day heat' : 'lingering high pressure'}, but this is your absolute best shot.` };
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------------------
// Parent Pro-Tip — layers a weather clause onto the existing species/access
// tip from app.js's getProTip() rather than duplicating that logic.
// ---------------------------------------------------------------------------
function getForecastProTip(loc, day) {
  const base = (typeof getProTip === 'function') ? getProTip(loc) : '';
  const bw = day.bestWindow;
  const anyFalling = bw.hours.some(h => h.pressureTrend === 'falling');
  const cloudy = bw.hours.some(h => h.cloudCoverPct > 60);
  let clause = '';
  if (cloudy && anyFalling) clause = 'Overcast skies and falling pressure are keeping fish active close to the bank. ';
  else if (anyFalling) clause = 'Falling pressure has fish feeding more aggressively today. ';
  else if (bw.hours.some(h => h._isGoldenLight)) clause = 'Low early/late light has fish moving shallow. ';
  return clause + base;
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------
async function fetchForecast(lat, lng, forceRefresh = false) {
  const cacheKey = `${FORECAST_CACHE_PREFIX}${coordKey(lat, lng)}`;
  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // precipitation_unit is pinned explicitly to mm — a live sample showed
  // Open-Meteo defaults precipitation to inches when temperature/wind units
  // are set to imperial, and the scoring thresholds (§5, computeKidComfort)
  // are calibrated in mm/hr.
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lng}` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset` +
    `&hourly=temperature_2m,pressure_msl,wind_speed_10m,wind_gusts_10m,cloud_cover,precipitation_probability,precipitation,weather_code` +
    `&forecast_days=7&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=mm`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo forecast error: ${res.status}`);
  const json = await res.json();
  const data = parseForecastResponse(json, lat, lng);
  setCache(cacheKey, data);
  return data;
}

// weather_code is the current official Open-Meteo name (confirmed against a
// live variable list); weathercode was the pre-rename name. Check both so an
// older/newer API version degrades gracefully instead of silently producing
// wrong scores.
function fieldEither(obj, nameA, nameB) {
  return obj[nameA] !== undefined ? obj[nameA] : obj[nameB];
}

function parseForecastResponse(json, lat, lng) {
  if (!json.hourly || !json.daily || !Array.isArray(json.hourly.time) || !Array.isArray(json.daily.time)) {
    throw new Error('Open-Meteo forecast response missing expected hourly/daily arrays');
  }
  const utcOffsetSeconds = json.utc_offset_seconds || 0;
  const hourlyTimes = json.hourly.time;
  const dailyTimes = json.daily.time;
  const hourlyWeatherCode = fieldEither(json.hourly, 'weather_code', 'weathercode');
  const dailyWeatherCode  = fieldEither(json.daily, 'weather_code', 'weathercode');
  const hourlyCloudCover  = fieldEither(json.hourly, 'cloud_cover', 'cloudcover');
  // Belt-and-suspenders: a live sample showed precipitation returned in
  // inches despite requesting precipitation_unit=mm's sibling params being
  // imperial. Read the actual unit label back and convert if it's not mm,
  // rather than trusting the request param silently held.
  const precipUnit = json.hourly_units && json.hourly_units.precipitation;
  const precipToMm = (precipUnit && precipUnit.startsWith('in')) ? (v) => v * 25.4 : (v) => v;
  if (!Array.isArray(hourlyWeatherCode) || !Array.isArray(dailyWeatherCode) || !Array.isArray(hourlyCloudCover) ||
      !Array.isArray(json.hourly.pressure_msl) || !Array.isArray(json.hourly.wind_speed_10m) ||
      hourlyTimes.length < dailyTimes.length * 24) {
    throw new Error('Open-Meteo forecast response has an unexpected shape');
  }

  // Open-Meteo's hourly array is NOT aligned to dayIdx*24 — it starts at the
  // *current* hour, not midnight, so "today" is a short/partial day and the
  // array runs past the end of daily.time into a trailing partial day too.
  // Bucket every hourly entry by its own date string instead of assuming
  // positional alignment; drop anything outside daily.time's range (we have
  // no daily.sunrise/sunset/temp for it anyway).
  const dayMeta = {};
  dailyTimes.forEach((dateISO, dayIdx) => {
    const dow = new Date(dateISO + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' });
    const label = new Date(dateISO + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    const moonPhase = moonPhaseForDate(new Date(dateISO + 'T12:00:00Z'));
    const newOrFullMoon = isNewOrFullMoon(moonPhase);

    const sunriseMs = parseLocalAsPretendUTC(json.daily.sunrise[dayIdx]);
    const sunsetMs  = parseLocalAsPretendUTC(json.daily.sunset[dayIdx]);
    const civilDawnStartMs = sunriseMs - 25 * 60000;
    const civilDuskEndMs   = sunsetMs + 25 * 60000;
    const morningEndMs = sunriseMs + 60 * 60000;
    const eveningStartMs = sunsetMs - 60 * 60000;

    const dayStartUTC = new Date(Date.parse(dateISO + 'T00:00:00Z') - utcOffsetSeconds * 1000);
    const solunar = getSolunarWindows(dayStartUTC, lat, lng);
    const inAnyWindow = (ms) => solunar.major.concat(solunar.minor).some(w => {
      const wStart = w.start.getTime() + utcOffsetSeconds * 1000;
      const wEnd = w.end.getTime() + utcOffsetSeconds * 1000;
      return ms >= wStart && ms < wEnd;
    });
    const inMajorWindow = (ms) => solunar.major.some(w => {
      const wStart = w.start.getTime() + utcOffsetSeconds * 1000;
      const wEnd = w.end.getTime() + utcOffsetSeconds * 1000;
      return ms >= wStart && ms < wEnd;
    });

    dayMeta[dateISO] = {
      dateISO, dow, label, dayIdx, moonPhase, newOrFullMoon,
      civilDawnStartMs, civilDuskEndMs, morningEndMs, eveningStartMs,
      inAnyWindow, inMajorWindow, hours: []
    };
  });

  for (let idx = 0; idx < hourlyTimes.length; idx++) {
    const timeStr = hourlyTimes[idx];
    const dateISO = timeStr.slice(0, 10);
    const meta = dayMeta[dateISO];
    if (!meta) continue; // outside daily.time's range (trailing partial day)

    const hourOfDay = parseInt(timeStr.slice(11, 13), 10);
    const nowMs = parseLocalAsPretendUTC(timeStr);
    const pressureHpa = json.hourly.pressure_msl[idx];
    const prevPressure = idx >= 3 ? json.hourly.pressure_msl[idx - 3] : null;
    const pressureTrend = prevPressure == null ? 'stable' : classifyPressureTrend(pressureHpa - prevPressure);

    const isGoldenLight =
      (nowMs >= meta.civilDawnStartMs && nowMs <= meta.morningEndMs) ||
      (nowMs >= meta.eveningStartMs && nowMs <= meta.civilDuskEndMs);
    const inSolunarWindow = meta.inAnyWindow(nowMs);

    const h = {
      hour: hourOfDay,
      timeLabel: formatHourLabel(hourOfDay),
      tempF: json.hourly.temperature_2m[idx],
      pressureHpa, pressureTrend,
      windMph: json.hourly.wind_speed_10m[idx],
      windGustMph: json.hourly.wind_gusts_10m ? json.hourly.wind_gusts_10m[idx] : 0,
      cloudCoverPct: hourlyCloudCover[idx],
      precipProbPct: json.hourly.precipitation_probability[idx],
      precipMm: precipToMm(json.hourly.precipitation[idx]),
      weatherCode: hourlyWeatherCode[idx],
      _isGoldenLight: isGoldenLight,
      solunarStars: meta.inMajorWindow(nowMs) ? 3 : inSolunarWindow ? 2 : 1
    };

    h.fishScore = computeFishActivity(h, { isGoldenLight, inSolunarWindow, newOrFullMoon: meta.newOrFullMoon });
    const comfort = computeKidComfort(h);
    h.comfortScore = comfort.score;
    h.comfortOverride = comfort.score < 40;
    const compound = compoundHourRating(h.fishScore, comfort);
    h.rating = compound.rating;
    h.badges = compound.badges;

    meta.hours.push(h);
  }

  const days = dailyTimes.map((dateISO, dayIdx) => {
    const meta = dayMeta[dateISO];
    const hours = meta.hours;

    // "Today" may only have a handful of remaining hours (or, late at
    // night, none inside the usual 5am-9pm window) — fall back to whatever
    // hours actually exist for the day rather than dividing by zero.
    let daylightHours = hours.filter(h => h.hour >= FORECAST_DAYLIGHT_START_HOUR && h.hour <= FORECAST_DAYLIGHT_END_HOUR);
    if (daylightHours.length === 0) daylightHours = hours;
    const avgFish = daylightHours.length ? daylightHours.reduce((s, h) => s + h.fishScore, 0) / daylightHours.length : 0;
    const avgComfort = daylightHours.length ? daylightHours.reduce((s, h) => s + Math.max(0, h.comfortScore), 0) / daylightHours.length : 0;
    const bestWindow = findBestWindow(hours);
    const dayRating = bestWindow.avg >= 75 ? 'excellent' : bestWindow.avg >= 45 ? 'good' : 'poor';

    const day = {
      dateISO, dow: meta.dow, label: meta.label,
      tempMax: json.daily.temperature_2m_max[dayIdx],
      tempMin: json.daily.temperature_2m_min[dayIdx],
      weatherCode: dailyWeatherCode[dayIdx],
      moonPhase: meta.moonPhase, newOrFullMoon: meta.newOrFullMoon,
      hours,
      bestWindow,
      dayRating,
      biteStars: scoreToStars(avgFish), biteLabel: biteLabelFor(avgFish),
      comfortStars: scoreToStars(avgComfort), comfortLabel: comfortLabelFor(avgComfort)
    };
    day.summaryBanner = buildSummaryBanner(day);
    return day;
  });

  return { utcOffsetSeconds, days };
}

// ---------------------------------------------------------------------------
// Reactive state + rendering
// ---------------------------------------------------------------------------
let _forecastState = { locId: null, data: null, selectedDate: null, loading: false, error: false };

async function prefetchForecast(loc) {
  if (!loc || !loc.coordinates) return;
  if (_forecastState.locId === loc.id && (_forecastState.data || _forecastState.loading)) return;
  _forecastState = { locId: loc.id, data: null, selectedDate: null, loading: true, error: false };
  try {
    const data = await fetchForecast(loc.coordinates.lat, loc.coordinates.lng, false);
    if (_forecastState.locId !== loc.id) return; // navigated away before this resolved
    _forecastState.data = data;
    _forecastState.selectedDate = data.days[0].dateISO;
    _forecastState.loading = false;
    const tab = document.getElementById('tab-forecast');
    if (tab && tab.style.display !== 'none') renderForecastTab(loc);
  } catch (err) {
    console.warn('Forecast fetch failed:', err);
    if (_forecastState.locId !== loc.id) return;
    _forecastState.loading = false;
    _forecastState.error = true;
    if (document.getElementById('forecastRoot')) renderForecastError();
  }
}
window.prefetchForecast = prefetchForecast;

function loadingMarkup() {
  return `<div class="text-center py-12 text-gray-400"><div class="spinner inline-block w-6 h-6 border-4 border-green-700 border-t-transparent rounded-full mb-3"></div><p class="text-xs font-bold uppercase tracking-widest">Loading forecast…</p></div>`;
}
function renderForecastError() {
  const root = document.getElementById('forecastRoot');
  if (root) root.innerHTML = `<div class="text-center py-12 text-gray-400"><div class="text-4xl mb-3">🌦️</div><p class="font-bold text-sm">Forecast unavailable right now.</p><p class="text-xs mt-1">Please try again in a moment.</p></div>`;
}

function renderForecastTab(loc) {
  const root = document.getElementById('forecastRoot');
  if (!root) return;

  if (_forecastState.locId !== loc.id) {
    root.innerHTML = loadingMarkup();
    prefetchForecast(loc);
    return;
  }
  if (_forecastState.loading) { root.innerHTML = loadingMarkup(); return; }
  if (_forecastState.error || !_forecastState.data) { renderForecastError(); return; }

  root.innerHTML = `
    <div id="forecastSummaryBanner" class="mb-4"></div>
    <div id="forecastDayStrip" class="flex gap-2 overflow-x-auto pb-2 mb-5 -mx-1 px-1"></div>
    <div id="forecastHourlyHeader" class="mb-2"></div>
    <div id="forecastHourlyTimeline" class="space-y-0.5 max-h-[420px] overflow-y-auto"></div>`;
  hydrateForecastDay(loc);
}
window.renderForecastTab = renderForecastTab;

function selectDay(locId, dateISO) {
  const saved = (typeof getSavedSpots === 'function') ? getSavedSpots() : [];
  const loc = (typeof allResults !== 'undefined' && allResults.find(l => l.id === locId)) || saved.find(l => l.id === locId);
  if (!loc) return;
  _forecastState.selectedDate = dateISO;
  hydrateForecastDay(loc);
}
window.selectDay = selectDay;

function hydrateForecastDay(loc) {
  const data = _forecastState.data;
  const day = data.days.find(d => d.dateISO === _forecastState.selectedDate) || data.days[0];
  renderHeaderGauges(day);
  renderSummaryBanner(day);
  renderDayStrip(loc, data, day);
  renderHourlyTimeline(day);
  renderForecastProTipBox(loc, day);
}

function renderHeaderGauges(day) {
  const area = document.getElementById('headerScoreArea');
  if (!area) return;
  area.innerHTML = `
    <div class="bg-white/20 backdrop-blur-md px-3 py-2 rounded-xl text-center">
      <div class="text-[9px] uppercase font-black opacity-80">Bite Action</div>
      <div class="text-[10px] font-black">| ${day.biteLabel} |</div>
      <div class="text-xs">${renderStars(day.biteStars)}</div>
    </div>
    <div class="bg-white/20 backdrop-blur-md px-3 py-2 rounded-xl text-center">
      <div class="text-[9px] uppercase font-black opacity-80">Kid Comfort</div>
      <div class="text-[10px] font-black">| ${day.comfortLabel} |</div>
      <div class="text-xs">${renderStars(day.comfortStars)}</div>
    </div>`;
}

function renderSummaryBanner(day) {
  const el = document.getElementById('forecastSummaryBanner');
  if (!el) return;
  const bg = day.summaryBanner.tone === 'excellent' ? 'bg-green-50 border-green-200 text-green-900'
    : day.summaryBanner.tone === 'good' ? 'bg-yellow-50 border-yellow-200 text-yellow-900'
    : 'bg-red-50 border-red-200 text-red-900';
  el.innerHTML = `<div class="border rounded-xl p-3 text-sm font-medium ${bg}">${ratingDot(day.summaryBanner.tone)} ${day.summaryBanner.text}</div>`;
}

function dayWarningBadges(day) {
  const set = new Set();
  day.hours
    .filter(h => h.hour >= FORECAST_DAYLIGHT_START_HOUR && h.hour <= FORECAST_DAYLIGHT_END_HOUR)
    .forEach(h => h.badges.forEach(b => set.add(b)));
  return Array.from(set).join(' ');
}

function renderDayStrip(loc, data, selectedDay) {
  const el = document.getElementById('forecastDayStrip');
  if (!el) return;
  el.innerHTML = data.days.map((d, i) => {
    const selected = d.dateISO === selectedDay.dateISO;
    const badges = dayWarningBadges(d);
    const box = selected ? 'border-green-700 bg-green-50 ring-1 ring-green-700'
      : d.dayRating === 'poor' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white';
    return `
      <button onclick="selectDay('${loc.id}','${d.dateISO}')" class="flex-shrink-0 w-20 border rounded-xl p-2 text-center min-h-[44px] ${box}">
        <div class="text-[10px] font-black uppercase text-gray-500">${i === 0 ? 'Today' : d.dow}</div>
        <div class="text-xs font-bold text-gray-700 mb-1">${d.label}</div>
        <div class="text-sm">${ratingDot(d.dayRating)}</div>
        <div class="text-[9px] font-bold text-gray-500 capitalize">${d.dayRating}</div>
        ${badges ? `<div class="text-[9px] mt-0.5">${badges}</div>` : ''}
      </button>`;
  }).join('');
}

function hourlyRowMarkup(h, expanded) {
  const dot = ratingDot(h.rating);
  const ratingText = h.rating.charAt(0).toUpperCase() + h.rating.slice(1);
  const wt = windTier(h.windMph);
  if (expanded) {
    return `<div class="flex items-center gap-2 text-xs py-1 flex-wrap">
      <span class="w-16 font-bold text-gray-600">${h.timeLabel}</span>
      <span>${dot}</span>
      <span class="font-black">${ratingText}</span>
      <span>${pressureTrendIcon(h.pressureTrend)} ${pressureTrendLabel(h.pressureTrend)}</span>
      ${h.solunarStars === 3 ? '<span>⭐⭐ Solunar Peak</span>' : ''}
    </div>`;
  }
  const descriptor = h.badges.length ? `${h.badges.join(' ')} ${ratingText}`
    : (h.precipProbPct >= 20 ? `${wt.icon} ${wt.label}, ${h.precipProbPct}% rain` : `${wt.icon} ${wt.label}, Low Rain Risk`);
  return `<div class="flex items-center gap-2 text-xs py-1.5 border-b border-gray-50">
    <span class="w-16 text-gray-500">${h.timeLabel}</span>
    <span>${weatherCodeIcon(h.weatherCode)}</span>
    <span>${dot}</span>
    <span class="font-bold">${ratingText}</span>
    <span class="text-gray-500">${Math.round(h.tempF)}°F</span>
    <span class="text-gray-400 text-[11px] truncate">${descriptor}</span>
  </div>`;
}

function renderHourlyTimeline(day) {
  const headerEl = document.getElementById('forecastHourlyHeader');
  if (headerEl) headerEl.innerHTML = `<h4 class="text-xs font-black uppercase tracking-widest text-gray-400">Hourly Timeline | ${day.dow} ${day.label}</h4>`;

  const el = document.getElementById('forecastHourlyTimeline');
  if (!el) return;
  const bw = day.bestWindow;

  let html = '';
  let i = 0;
  while (i < day.hours.length) {
    const inBest = day.hours[i].hour >= bw.startHour && day.hours[i].hour < bw.endHour;
    if (inBest) {
      let block = '';
      while (i < day.hours.length && day.hours[i].hour >= bw.startHour && day.hours[i].hour < bw.endHour) {
        block += hourlyRowMarkup(day.hours[i], true);
        i++;
      }
      html += `<div id="bestWindowBox" class="border-2 border-amber-400 bg-amber-50 rounded-xl p-3 my-2">
        <div class="text-xs font-black text-amber-700 mb-1">🏆 Best Window (${formatHourLabel(bw.startHour)} - ${formatHourLabel(bw.endHour % 24)})</div>
        ${block}
      </div>`;
    } else {
      html += hourlyRowMarkup(day.hours[i], false);
      i++;
    }
  }
  el.innerHTML = html;

  const box = document.getElementById('bestWindowBox');
  if (box) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderForecastProTipBox(loc, day) {
  const el = document.getElementById('parentProTipText');
  if (el) el.textContent = `"${getForecastProTip(loc, day)}"`;
}
