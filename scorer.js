// scorer.js — Success Score Algorithm (0–100)
// Upgrade 3: pressure TREND (rising/falling/stable) now contributes a separate
// trend bonus/penalty on top of the static snapshot score, aligning the
// "catch probability" component more closely with how anglers read conditions.

const WEIGHTS = {
  catchProbability: 0.35,  // weather snapshot (temp + pressure level)
  pressureTrend:    0.10,  // NEW: barometric trend bonus/penalty
  lunarPhase:       0.20,
  kidFactor:        0.20,
  accessibility:    0.15
};

// ---------------------------------------------------------------------------
// Pressure trend detection
// ---------------------------------------------------------------------------
// We store the last two pressure readings keyed per location in localStorage.
// On each weather fetch we call recordPressure(coordKey, hpa) which rotates
// a small circular buffer [prev, current].  getTrend() reads that buffer and
// returns one of: 'rising' | 'falling' | 'stable'.
//
// Fishing science:
//   Rising pressure → fish become more active (good for scoring)
//   Falling pressure → fish go deep, bite slows (bad)
//   Stable pressure → neutral, fish on regular patterns

const TREND_STORE_KEY_PREFIX = 'pt_'; // pressure-trend prefix in localStorage

function recordPressure(key, hpa) {
  try {
    const raw = localStorage.getItem(TREND_STORE_KEY_PREFIX + key);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({ hpa, ts: Date.now() });
    // Keep only last 3 readings
    if (arr.length > 3) arr.shift();
    localStorage.setItem(TREND_STORE_KEY_PREFIX + key, JSON.stringify(arr));
  } catch { /* storage unavailable */ }
}

function getTrend(key) {
  try {
    const raw = localStorage.getItem(TREND_STORE_KEY_PREFIX + key);
    if (!raw) return 'stable';
    const arr = JSON.parse(raw);
    if (arr.length < 2) return 'stable';
    const oldest = arr[0].hpa;
    const newest = arr[arr.length - 1].hpa;
    const delta  = newest - oldest;
    if (delta >  1.5) return 'rising';
    if (delta < -1.5) return 'falling';
    return 'stable';
  } catch { return 'stable'; }
}

// Export helpers so app.js can call recordPressure after each weather fetch
window._recordPressure = recordPressure;
window._getTrend       = getTrend;

// ---------------------------------------------------------------------------
// Trend score: 0–100
//   rising  → 85 (good)
//   stable  → 55 (neutral)
//   falling → 20 (poor)
// ---------------------------------------------------------------------------
function calcTrendScore(trend) {
  if (trend === 'rising')  return 85;
  if (trend === 'falling') return 20;
  return 55; // stable
}

// Human-readable label used in UI
function trendLabel(trend) {
  if (trend === 'rising')  return '↗️ Rising';
  if (trend === 'falling') return '↘️ Falling';
  return '↔️ Stable';
}
window.trendLabel = trendLabel;

// ---------------------------------------------------------------------------
// Component scorers (unchanged from prior version)
// ---------------------------------------------------------------------------
function calcKidFactor(amenities, accessibility, childAge) {
  let score = 0;
  if (amenities.restrooms)   score += 8;
  if (amenities.playground)  score += 7;
  if (amenities.shadedArea)  score += 4;
  if (accessibility === 'Dock') {
    score += 6;
    if (childAge < 6) score += 10;
  }
  return Math.min(score, 25);
}

function calcAccessibilityScore(accessibility) {
  const map = { 'Dock': 100, 'Clear Bank': 80, 'Obstructed Bank': 40 };
  return map[accessibility] ?? 40;
}

function calcWeatherScore(tempF, pressureHpa) {
  const tempScore  = 100 - Math.min(Math.abs(tempF - 68) * 3, 100);
  const pressScore = 100 - Math.min(Math.abs(pressureHpa - 1018) * 5, 100);
  return (tempScore + pressScore) / 2;
}

function calcLunarScore(moonPhase) {
  const distance = Math.min(moonPhase, 1 - moonPhase);
  return Math.round(100 - (distance / 0.25) * 100);
}

// ---------------------------------------------------------------------------
// Main scorer — now accepts optional pressureTrend string
// ---------------------------------------------------------------------------
function calcSuccessScore(location, weatherData, moonPhase, childAge, pressureTrend) {
  const trend = pressureTrend || 'stable';

  const catchProb  = calcWeatherScore(weatherData.tempF, weatherData.pressureHpa);
  const trendScore = calcTrendScore(trend);
  const lunar      = calcLunarScore(moonPhase);
  const kidFactor  = (calcKidFactor(location.amenities, location.accessibility, childAge) / 25) * 100;
  const access     = calcAccessibilityScore(location.accessibility);

  const score =
    catchProb  * WEIGHTS.catchProbability +
    trendScore * WEIGHTS.pressureTrend +
    lunar      * WEIGHTS.lunarPhase +
    kidFactor  * WEIGHTS.kidFactor +
    access     * WEIGHTS.accessibility;

  return Math.round(score);
}
