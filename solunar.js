// solunar.js — Moon phase + solunar (major/minor feeding window) astronomy
//
// Low-precision lunar position (truncated series, accurate to a few arcmin —
// the same "good enough for a heuristic score" precision philosophy as the
// rest of the app's astronomy, not JPL-ephemeris grade) used to solve moon
// transit/antitransit (major windows) and moonrise/moonset (minor windows)
// via iterative refinement, the standard approach used by most lightweight
// moon-rise/set calculators.
//
// Everything here works in UTC. Callers that need local-time results (the
// Forecast tab, matching Open-Meteo's timezone=auto hourly series) shift by
// the location's utc_offset_seconds themselves — this module has no
// timezone/network dependency.

const SOLUNAR_DEG2RAD = Math.PI / 180;
const SOLUNAR_RAD2DEG = 180 / Math.PI;

// Moon's altitude at which it's considered risen/set. A fixed 0.125° is the
// standard simplified constant used by low-precision moonrise/set
// algorithms — it roughly cancels the Moon's own parallax against
// atmospheric refraction + its apparent radius, without a full parallax
// model.
const MOON_RISE_SET_ALTITUDE_DEG = 0.125;

function toJulianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function normalizeDeg(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

// Geocentric apparent Moon position (ecliptic -> equatorial), truncated to
// the dominant terms of the Meeus low-precision series.
function moonPosition(jd) {
  const d = jd - 2451545.0; // days since J2000.0

  const Lp = normalizeDeg(218.316 + 13.176396 * d); // mean longitude
  const M  = normalizeDeg(134.963 + 13.064993 * d); // mean anomaly
  const F  = normalizeDeg(93.272  + 13.229350 * d); // argument of latitude

  const lonEcl = Lp + 6.289 * Math.sin(M * SOLUNAR_DEG2RAD);
  const latEcl = 5.128 * Math.sin(F * SOLUNAR_DEG2RAD);

  const eps = 23.439 * SOLUNAR_DEG2RAD; // mean obliquity of the ecliptic
  const lonR = lonEcl * SOLUNAR_DEG2RAD;
  const latR = latEcl * SOLUNAR_DEG2RAD;

  const ra = Math.atan2(
    Math.sin(lonR) * Math.cos(eps) - Math.tan(latR) * Math.sin(eps),
    Math.cos(lonR)
  ) * SOLUNAR_RAD2DEG;
  const dec = Math.asin(
    Math.sin(latR) * Math.cos(eps) + Math.cos(latR) * Math.sin(eps) * Math.sin(lonR)
  ) * SOLUNAR_RAD2DEG;

  return { ra: normalizeDeg(ra), dec };
}

// Greenwich Sidereal Time (degrees) at a given Julian Date.
function greenwichSiderealTimeDeg(jd) {
  const d = jd - 2451545.0;
  const T = d / 36525;
  return normalizeDeg(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T);
}

function localSiderealTimeDeg(jd, lngDeg) {
  return normalizeDeg(greenwichSiderealTimeDeg(jd) + lngDeg);
}

// Iteratively solve for the UTC instant nearest `guessDate` at which the
// Moon's hour angle equals `targetHourAngleDeg` (0 = upper transit / major
// window center, 180 = lower transit / antitransit, the other major-window
// center ~12h25m away).
function solveMoonHourAngle(guessDate, lngDeg, targetHourAngleDeg) {
  let jd = toJulianDate(guessDate);
  for (let i = 0; i < 4; i++) {
    const { ra } = moonPosition(jd);
    const lst = localSiderealTimeDeg(jd, lngDeg);
    let h = normalizeDeg(lst - ra - targetHourAngleDeg);
    if (h > 180) h -= 360; // signed hour angle, degrees
    // Sidereal rate ~360.9856 deg per 24h — convert the hour-angle error to
    // a time correction and step toward convergence.
    jd -= h / 360.9856;
  }
  return new Date(jd * 86400000 - 2440587.5 * 86400000);
}

// Solve for moonrise/moonset nearest `guessDate` (the day's upper transit),
// using the Moon's declination at transit (changes slowly enough over a day
// that one refinement pass is sufficient for this precision level).
function solveMoonRiseSet(transitDate, lat, lng) {
  const jdTransit = toJulianDate(transitDate);
  const { dec } = moonPosition(jdTransit);
  const latR = lat * SOLUNAR_DEG2RAD;
  const decR = dec * SOLUNAR_DEG2RAD;
  const h0R  = MOON_RISE_SET_ALTITUDE_DEG * SOLUNAR_DEG2RAD;

  const cosH0 = (Math.sin(h0R) - Math.sin(latR) * Math.sin(decR)) /
    (Math.cos(latR) * Math.cos(decR));
  if (cosH0 < -1 || cosH0 > 1) return { rise: null, set: null }; // circumpolar / never-rises day

  const H0deg = Math.acos(cosH0) * SOLUNAR_RAD2DEG;
  const riseGuess = new Date(transitDate.getTime() - (H0deg / 360.9856) * 86400000);
  const setGuess   = new Date(transitDate.getTime() + (H0deg / 360.9856) * 86400000);

  return {
    rise: solveMoonHourAngle(riseGuess, lng, -H0deg),
    set:  solveMoonHourAngle(setGuess, lng, H0deg)
  };
}

// Simple epoch-based moon phase (0 = new, 0.5 = full), shared by the card
// list's moon icon (app.js) and the Forecast tab's daily moonPhase field.
function moonPhaseForDate(date) {
  const refNew = new Date('2000-01-06T18:14:00Z');
  const diffDays = (date - refNew) / (1000 * 60 * 60 * 24);
  return ((diffDays % 29.53) + 29.53) % 29.53 / 29.53;
}
window.moonPhaseForDate = moonPhaseForDate;

function isNewOrFullMoon(phase) {
  const distanceFromNew  = Math.min(phase, 1 - phase);
  const distanceFromFull = Math.abs(phase - 0.5);
  return distanceFromNew < 0.05 || distanceFromFull < 0.05;
}
window.isNewOrFullMoon = isNewOrFullMoon;

// Major (~2hr, centered on transit/antitransit) and minor (~1hr, centered on
// moonrise/moonset) solunar windows for the UTC calendar day containing
// `dayStartUTC` (pass local midnight already shifted to its UTC instant).
// Searches a padded range so a window centered just before/after midnight
// still shows up for the adjacent day it actually affects.
function getSolunarWindows(dayStartUTC, lat, lng) {
  const major = [];
  const minor = [];
  const searchStart = new Date(dayStartUTC.getTime() - 3 * 3600000);
  const searchEnd   = new Date(dayStartUTC.getTime() + 27 * 3600000);

  // Upper transits recur every ~24h50m — check a guess near local noon plus
  // neighbors so we don't miss one near either edge of the search window.
  const noonGuess = new Date(dayStartUTC.getTime() + 12 * 3600000);
  const upperGuesses = [-1, 0, 1].map(n =>
    new Date(noonGuess.getTime() + n * 24.8412 * 3600000));

  upperGuesses.forEach(guess => {
    const transit = solveMoonHourAngle(guess, lng, 0);
    if (transit >= searchStart && transit <= searchEnd) {
      major.push({ start: new Date(transit.getTime() - 3600000), end: new Date(transit.getTime() + 3600000) });
      const antitransit = solveMoonHourAngle(transit, lng, 180);
      if (antitransit >= searchStart && antitransit <= searchEnd) {
        major.push({ start: new Date(antitransit.getTime() - 3600000), end: new Date(antitransit.getTime() + 3600000) });
      }
      const { rise, set } = solveMoonRiseSet(transit, lat, lng);
      [rise, set].forEach(t => {
        if (t && t >= searchStart && t <= searchEnd) {
          minor.push({ start: new Date(t.getTime() - 1800000), end: new Date(t.getTime() + 1800000) });
        }
      });
    }
  });

  return { major, minor };
}
window.getSolunarWindows = getSolunarWindows;
