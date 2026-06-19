# Product Requirements Document (PRD)
## Lets-Go-Fishing — Kid-Friendly Fishing Spot Finder
**Version:** 1.2 | **Updated:** June 19, 2026 | **Owner:** iv-for-fun

> **v1.2 Change Log:** Fine-grained sync pass against live code. Corrected child age range (1–15 per `index.html`), kid-factor Dock bonus details (base +6, age<6 bonus +10, cap 25pts), pressure buffer size (last 3 readings), gear guide age labels (Beginner 3–7 / Junior Pro 8+), card tag definitions (Easy Casting = Clear Bank only; Dock Access = Dock only), pro-tip logic sourced from `getProTip()`, OSM fallback clarified as `data/locations.json` via `loadFallbackSpots()`, and Quick-Glance Tags marked shipped in backlog.

> **v1.1 Change Log:** Aligned to actual MVP implementation. Updated technical stack, score weights, forecast logic, file structure, API configuration, and backlog status to reflect shipped code.

---

## 1. Overview

### 1.1 Purpose
A mobile-first, single-page web application hosted on GitHub Pages that helps parents find the **best kid-friendly fishing spots** near them, ranked by a proprietary **"Success Score"** based on drive time, fish activity, kid amenities, and accessibility.

### 1.2 Goals
- Help parents with children ages 1–15 find age-appropriate fishing locations quickly.
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
| **Primary** | Parent/guardian with child(ren) ages 1–15 planning a fishing outing |
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
| Spot Data | Overpass API (OpenStreetMap) — live fetch; fallback to `data/locations.json` via `loadFallbackSpots()` | 5 curated Atlanta spots if OSM unavailable |
| Weather | OpenWeatherMap API (key in `config.js`) | Graceful mock fallback if no key |
| Moon Phase | Client-side math (no API call) | Epoch-based calculation |
| Pressure Trend | `localStorage` rolling 3-reading store | Computed in `scorer.js` via `getTrend()` |

---

## 4. Core Features

### 4.1 Header / Controls
- **Max Drive Time Dropdown:** 0.5 to 4.0 hours in 30-minute increments.
- **Child Age Input:** Integer 1–15 (`max="15"` in `index.html`).
  - If `age < 6` → filter out **Obstructed Bank** locations entirely; prioritize **Dock** or **Clear Bank**.
- **Location Detection:** Auto-detect via Geolocation API; fallback to Nominatim geocoding text search.
  - Blank input or "current"/"current location" → GPS only.
  - Any other text → Nominatim geocode (no GPS mixing).
  - Atlanta `{33.749, -84.388}` is last-resort fallback only.

### 4.2 Home View — Location List
- Cards sorted by **driving distance** (Haversine formula).
- Each card displays:
  - Location name, distance (miles), and estimated drive time.
  - **Success Score** (0–100) as a color-coded badge (🟢 70+, 🟡 40–69, 🔴 <40).
  - Species tags (up to 2 shown + overflow count).
  - **Quick-glance tags** (see §4.2.1).
  - Live badge if data sourced from OSM.
  - Bookmark icon to save/unsave.

#### 4.2.1 Quick-Glance Tags

| Tag | Condition | Style |
|---|---|---|
| 🔥 High Activity | `score >= 70` | green pill |
| 🚻 Restrooms | `amenities.restrooms === true` | blue pill |
| 🎣 Easy Casting | `accessibility === 'Clear Bank'` | orange pill |
| 🛥️ Dock Access | `accessibility === 'Dock'` | teal pill |
| 🛝 Playground | `amenities.playground === true` | purple pill |

### 4.3 Detail View — Location Profile (4 tabs)

| Tab | Content |
|---|---|
| **Overview** | Weather widgets (Temp, Wind, Moon), top species chips, Google Maps directions link |
| **Fish & Gear** | Beginner Setup (Ages 3–7) + Junior Pro (Ages 8+) gear guides matched to target species; pro tip |
| **Amenities** | Restrooms, Playground, Picnic Area, Shade; Parking Fee, Fishing License, Access Type |
| **Forecast** | 30-day calendar grid — days 1–5 blended (moon + pressure trend), days 6–30 moon-only |

**Parent Pro-Tip** panel appears below the tab content on every location — sourced from `getProTip(loc)`, which varies by primary species and dock vs. bank access type.

### 4.4 Map View
- Leaflet.js map with color-coded circle markers (green / yellow / red by score).
- Tap a marker to see a popup with score, distance, drive time, and a "View Details" button.

### 4.5 Saved Spots
- Bookmark icon on any card saves the location to `localStorage`.
- Dedicated **Saved** tab in bottom nav lists all bookmarked spots; tap to open detail view.

---

## 5. The "Success Score" Algorithm

| Factor | Weight | Data Source |
|---|---|---|
| Catch Probability (weather temp + barometric pressure level) | 35% | OpenWeatherMap API / mock fallback |
| Lunar Phase Activity Multiplier | 20% | Client-side epoch math |
| Kid-Factor Bonus (restrooms, playground, dock) | 20% | Location dataset |
| Accessibility Score (Clear Bank > Obstructed) | 15% | Location dataset |
| Barometric Pressure Trend | 10% | `localStorage` rolling 3-reading store |

**Kid-Factor Scoring Detail (`calcKidFactor()`):**
- Restrooms present: +8 pts
- Playground present: +7 pts
- Shaded area present: +4 pts
- Dock Access: +6 pts base
  - Additional +10 pts if `childAge < 6` (mandatory dock priority)
- **Maximum cap: 25 pts** (normalized to 0–100 before weighting)

**Pressure Trend Detail (`scorer.js` → `getTrend()`):**
- Stores last **3** barometric readings per location in `localStorage` key `pt_{lat}_{lng}`
- Delta is `newest.hpa − oldest.hpa`; threshold ±1.5 hPa
- Rising (delta > +1.5) → score 85; Falling (delta < −1.5) → score 20; Stable → score 55
- Applied as 10% of final score; also drives pressure trend label in 30-day forecast (days 1–5)

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
Every explicit **Find Spots** click calls `bustCacheForCoords()` to force fresh weather and spot data for the resolved coordinates — ensuring detail-view data always reflects the latest search.

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
  "score": 78,
  "source": "osm"
}
```

> `source` is `"osm"` for live Overpass results; omitted or `"static"` for curated fallback spots.

---

## 9. Gear Guide

Two gear profiles are generated per location by `renderGearGuide(loc)`:

| Profile | Age Label | Basis |
|---|---|---|
| **Beginner Setup** | Ages 3–7 | `GEAR_DB.beginner` — spin-cast rods, mono line, bobber/worm rigs |
| **Junior Pro** | Ages 8+ | `GEAR_DB.pro` — spinning combos, fluorocarbon line, jig/soft-plastic rigs |

Species matched in priority order against `targetSpecies` array; falls back to `default` entry if species not in database. Supports 14 species including Bluegill, Bass, Crappie, Catfish, Walleye, Northern Pike, Snook, Redfish, Sheepshead, and Flounder.

---

## 10. UI/UX Requirements
- All touch targets: **minimum 44×44px**
- Mobile-first: designed for 375px wide, responsive to desktop
- Font size minimum: **16px** for body text (prevents iOS auto-zoom on inputs)
- Bottom nav bar: **Explore | Map | Saved**
- Color system: forest green `#2D6A4F`, sky blue `#48CAE4`, sand `#F4E285`
- Status banners for: GPS denial, missing weather API key, data source (Live OSM vs. Static), and active location display

---

## 11. API Configuration

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

## 12. File Structure

```
lets-go-fishing/
├── index.html          ← SPA shell, nav, views, forecast/map logic
├── app.js              ← search, location resolution, scoring pipeline, card + detail rendering
├── scorer.js           ← Success Score algorithm, getTrend(), recordPressure()
├── config.example.js   ← API key template
├── config.js           ← gitignored; holds real keys
├── data/
│   └── locations.json    ← curated fallback dataset (5 Atlanta spots)
└── PRD.md
```

> **Note:** The `components/` directory (card.js, detail.js, forecast.js) listed in v1.0
> was not implemented. Component logic is inline in `app.js` and `index.html`.

---

## 13. Backlog / Future Features

| Feature | Status |
|---|---|
| Interactive map view with color-coded pins | ✅ **Shipped** (Leaflet, v1.0) |
| User-saved favorite spots | ✅ **Shipped** (localStorage, v1.0) |
| Pressure trend in forecast calendar (days 1–5) | ✅ **Shipped** (v1.1) |
| Quick-glance card tags (High Activity, Easy Casting, Dock Access, Restrooms, Playground) | ✅ **Shipped** (v1.1) |
| PWA support (offline mode, home screen install) | ⏳ Backlog |
| Real-time fish reports integration | ⏳ Backlog |
| Social sharing of fishing trip results | ⏳ Backlog |
| Push notifications for "peak fishing window" alerts | ⏳ Backlog |
| Component file refactor (card.js, detail.js, forecast.js) | ⏳ Backlog |
| Replace Haversine with routed drive-time API | ⏳ Backlog |

---

## 14. Success Metrics (MVP)

| Metric | Target |
|---|---|
| Page load time (mobile 4G) | < 3 seconds |
| Locations returned per search | 5–15 within drive radius |
| Score calculation time | < 500ms |
| Cache hit rate after first load | > 80% |
