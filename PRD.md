# Product Requirements Document (PRD)
## Lets-Go-Fishing — Kid-Friendly Fishing Spot Finder
**Version:** 1.1 | **Updated:** June 19, 2026 | **Owner:** iv-for-fun

> **v1.1 Change Log:** Aligned to actual MVP implementation. Updated technical stack, score weights, forecast logic, file structure, API configuration, and backlog status to reflect shipped code.

---

## 1. Overview

### 1.1 Purpose
A mobile-first, single-page web application hosted on GitHub Pages that helps parents find the **best kid-friendly fishing spots** near them, ranked by a proprietary **“Success Score”** based on drive time, fish activity, kid amenities, and accessibility.

### 1.2 Goals
- Help parents with children ages 1–12 find age-appropriate fishing locations quickly.
- Surface actionable intel: gear recommendations, activity forecasts, and logistics.
- Operate entirely client-side (no backend), deployed on GitHub Pages.

### 1.3 Non-Goals
- No user accounts or authentication (MVP).
- No real-time fish reporting or social features (future backlog).
- No native mobile app (PWA enhancements are backlog).

---

## 2. Target Users

| Persona | Description |
|---|---|
| **Primary** | Parent/guardian with child(ren) ages 1–12 planning a fishing outing |
| **Secondary** | Grandparents, camp counselors, youth fishing program coordinators |

---

## 3. Technical Stack

| Layer | Technology | Notes |
|---|---|---|
| Markup | HTML5 | Single-page app (`index.html`) |
| Styling | Tailwind CSS (CDN, mobile-first) | |
| Logic | Vanilla JavaScript (ES6+) | `app.js`, `scorer.js`, `config.js` |
| Hosting | GitHub Pages (static, client-side only) | |
| Caching | `localStorage` with 6-hour TTL | Keyed by location + date |
| Location | Browser Geolocation API + Nominatim (OSM) geocoding fallback | Replaces Google Places Autocomplete |
| Maps | Leaflet.js + OpenStreetMap tiles | Replaces MapBox API |
| Distance | Haversine formula ÷ avg 45 mph estimate | Replaces Distance Matrix API |
| Spot Data | Overpass API (OpenStreetMap) — live fetch | 5 hardcoded Atlanta fallbacks if OSM unavailable |
| Weather | OpenWeatherMap API (key in `config.js`) | Graceful mock fallback if no key |
| Moon Phase | Client-side math (no API call) | Epoch-based calculation |
| Pressure Trend | `localStorage` rolling 3-reading store | Computed in `scorer.js` via `getTrend()` |

---

## 4. Core Features

### 4.1 Header / Controls
- **Max Drive Time Dropdown:** 0.5 to 4.0 hours in 30-minute increments.
- **Child Age Input:** Integer 1–12 (`max="12"`).
  - If `age < 6` → filter and prioritize **Dock** or **Clear Bank** locations only.
- **Location Detection:** Auto-detect via Geolocation API; fallback to Nominatim geocoding text search.

### 4.2 Home View — Location List
- Cards sorted by **driving distance** (Haversine formula).
- Each card displays:
  - Location name, distance (miles), and estimated drive time.
  - **Success Score** (0–100) as a color-coded badge (🟢 70+, 🟡 40–69, 🔴 <40).
  - Quick-glance tags: `High Activity` (score ≥70), `Restrooms`, `Easy Casting` (Dock or Clear Bank), `Dock Access`, `Playground`.

### 4.3 Detail View — Location Profile (4 tabs)

| Tab | Content |
|---|---|
| **Overview** | Score badge, distance, drive time, accessibility type, kid-factor tags, Google Maps link |
| **Fish** | Target species chips, dynamic Gear Guide, pro tips |
| **Amenities** | Restrooms, Playground, Picnic Tables, Shaded Area, Parking, Fees |
| **Forecast** | 30-day calendar grid — days 1–5 blended (moon + pressure trend), days 6–30 moon-only |

### 4.4 Map View
- Leaflet.js map with color-coded circle markers (green / yellow / red by score).
- Tap a marker to see a popup with score, distance, drive time, and a “View Details” button.

### 4.5 Saved Spots
- Bookmark icon on any card saves the location to `localStorage`.
- Dedicated **Saved** tab in bottom nav lists all bookmarked spots; tap to open detail view.

---

## 5. The “Success Score” Algorithm

| Factor | Weight | Data Source |
|---|---|---|
| Catch Probability (weather temp + barometric pressure) | 35% | OpenWeatherMap API / mock fallback |
| Lunar Phase Activity Multiplier | 20% | Client-side epoch math |
| Kid-Factor Bonus (restrooms, playground, dock) | 20% | Location dataset |
| Accessibility Score (Clear Bank > Obstructed) | 15% | Location dataset |
| Barometric Pressure Trend | 10% | `localStorage` rolling 3-reading store |

**Kid-Factor Scoring Detail:**
- Restrooms present: +8 pts
- Playground present: +7 pts
- Dock Access: +6 pts (mandatory bonus if `age < 6`)
- Shaded/Covered Area: +4 pts

**Pressure Trend Detail (`scorer.js` → `getTrend()`):**
- Stores last 3 barometric readings per location in `localStorage` key `pt_{lat}_{lng}`
- Rising → +15 score modifier; Falling → −20; Stable → 0
- Applied as 10% of final score; also used in 30-day forecast blending (days 1–5)

---

## 6. 30-Day Forecast Calendar

The forecast tab renders a 30-day grid. Score and color coding differ by day range:

| Day Range | Score Formula | Visual Indicator |
|---|---|---|
| Days 1–5 | `moonScore × 0.7 + (50 + pressureModifier) × 0.3` | Blue ring border |
| Days 6–30 | Moon phase score only | No ring |

**Color thresholds:** 🟢 Excellent ≥70 · 🟡 Good 45–69 · 🔴 Poor <45

Tooltip on hover shows date, moon emoji + %, pressure trend label (days 1–5 only), and blended score.

---

## 7. Caching Strategy

```javascript
const CACHE_TTL = 21600; // 6 hours in seconds
if ((Date.now() / 1000) - cacheTimestamp > CACHE_TTL) {
  fetchFreshData();
} else {
  loadFromCache();
}
```
All API responses stored in `localStorage` keyed by location + date. Cache invalidated after 6 hours.

---

## 8. Data Model — Location Object

```json
{
  "id": "lake-allatoona-001",
  "name": "Lake Allatoona — Day Use Area",
  "coordinates": { "lat": 34.1, "lng": -84.7 },
  "accessibility": "Dock",
  "amenities": {
    "restrooms": true,
    "playground": true,
    "picnicTables": true,
    "shadedArea": true
  },
  "targetSpecies": ["Largemouth Bass", "Crappie", "Bluegill"],
  "fees": { "parking": "$5/day", "fishing": "GA License Required" },
  "region": "Atlanta, GA",
  "distMiles": 32.4,
  "estDriveHours": 0.72,
  "score": 78
}
```

---

## 9. UI/UX Requirements
- All touch targets: **minimum 44×44px**
- Mobile-first: designed for 375px wide, responsive to desktop
- Font size minimum: **16px** for body text (prevents iOS auto-zoom on inputs)
- Bottom nav bar: **Explore | Map | Saved**
- Color system: forest green `#2D6A4F`, sky blue `#48CAE4`, sand `#F4E285`
- Status banners for GPS denial and missing weather API key

---

## 10. API Configuration

```javascript
// config.example.js — copy to config.js and add real keys
// config.js is gitignored; never commit real keys
const CONFIG = {
  OPENWEATHER_API_KEY: "YOUR_OPENWEATHER_KEY_HERE"
  // MapBox, StormGlass, and Google APIs not used in current implementation
};
```

> **Note:** Leaflet/OSM (maps), Nominatim (geocoding), Overpass (spot data), and moon phase
> calculations require **no API key**. Only OpenWeatherMap requires a key; the app
> degrades gracefully with simulated weather data if the key is absent.

---

## 11. File Structure

```
lets-go-fishing/
├── index.html          ← SPA shell, nav, views, forecast/map logic
├── app.js              ← search, scoring pipeline, card + detail rendering
├── scorer.js           ← Success Score algorithm + getTrend()
├── config.example.js   ← API key template
├── config.js           ← gitignored; holds real keys
├── data/
│   └── locations.json    ← fallback dataset (5 Atlanta spots)
└── PRD.md
```

> **Note:** The `components/` directory (card.js, detail.js, forecast.js) listed in v1.0
> was not implemented. Component logic is inline in `app.js` and `index.html`.

---

## 12. Backlog / Future Features

| Feature | Status |
|---|---|
| Interactive map view with color-coded pins | ✅ **Shipped** (Leaflet, v1.0) |
| User-saved favorite spots | ✅ **Shipped** (localStorage, v1.0) |
| Pressure trend in forecast calendar (days 1–5) | ✅ **Shipped** (v1.1) |
| PWA support (offline mode, home screen install) | ⏳ Backlog |
| Real-time fish reports integration | ⏳ Backlog |
| Social sharing of fishing trip results | ⏳ Backlog |
| Push notifications for “peak fishing window” alerts | ⏳ Backlog |
| Component file refactor (card.js, detail.js, forecast.js) | ⏳ Backlog |
| Replace Haversine with routed drive-time API | ⏳ Backlog |

---

## 13. Success Metrics (MVP)

| Metric | Target |
|---|---|
| Page load time (mobile 4G) | < 3 seconds |
| Locations returned per search | 5–15 within drive radius |
| Score calculation time | < 500ms |
| Cache hit rate after first load | > 80% |
