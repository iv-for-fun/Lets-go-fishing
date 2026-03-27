// scorer.js — Success Score Algorithm (0–100)

const WEIGHTS = {
  catchProbability: 0.35,
  lunarPhase: 0.20,
  kidFactor: 0.25,
  accessibility: 0.20
};

function calcKidFactor(amenities, accessibility, childAge) {
  let score = 0;
  if (amenities.restrooms)   score += 8;
  if (amenities.playground)  score += 7;
  if (amenities.shadedArea)  score += 4;
  if (accessibility === "Dock") {
    score += 6;
    if (childAge < 6) score += 10; // mandatory bonus for toddlers
  }
  return Math.min(score, 25); // cap at 25pts raw
}

function calcAccessibilityScore(accessibility) {
  const map = { "Dock": 100, "Clear Bank": 80, "Obstructed Bank": 40 };
  return map[accessibility] ?? 40;
}

// weatherScore: 0–100 based on temp (60–75°F ideal) and pressure (1013–1023 hPa ideal)
function calcWeatherScore(tempF, pressureHpa) {
  let tempScore = 100 - Math.min(Math.abs(tempF - 68) * 3, 100);
  let pressScore = 100 - Math.min(Math.abs(pressureHpa - 1018) * 5, 100);
  return (tempScore + pressScore) / 2;
}

// lunarScore: 0–100 (new moon & full moon = peak activity)
function calcLunarScore(moonPhase) {
  // moonPhase: 0 = new moon, 0.5 = full moon, 1 = new moon
  const distance = Math.min(moonPhase, 1 - moonPhase); // 0 = peak, 0.25 = lowest
  return Math.round(100 - (distance / 0.25) * 100);
}

function calcSuccessScore(location, weatherData, moonPhase, childAge) {
  const catchProb = calcWeatherScore(weatherData.tempF, weatherData.pressureHpa);
  const lunar     = calcLunarScore(moonPhase);
  const kidFactor = (calcKidFactor(location.amenities, location.accessibility, childAge) / 25) * 100;
  const access    = calcAccessibilityScore(location.accessibility);

  const score =
    catchProb * WEIGHTS.catchProbability +
    lunar     * WEIGHTS.lunarPhase +
    kidFactor * WEIGHTS.kidFactor +
    access    * WEIGHTS.accessibility;

  return Math.round(score);
}
