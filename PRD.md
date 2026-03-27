# Product Requirements Document (PRD)
## Lets-Go-Fishing — Kid-Friendly Fishing Spot Finder
**Version:** 1.0 | **Date:** March 21, 2026 | **Owner:** iv-for-fun

---

## 1. Overview

### 1.1 Purpose
A mobile-first, single-page web application hosted on GitHub Pages that helps parents find the **best kid-friendly fishing spots** near them, ranked by a proprietary **"Success Score"** based on drive time, fish activity, kid amenities, and accessibility.

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

| Layer | Technology |
|---|---|
| Markup | HTML5 |
| Styling | Tailwind CSS (mobile-first) |
| Logic | Vanilla JavaScript (ES6+) |
| Hosting | GitHub Pages (static, client-side only) |
| Caching | `localStorage` with 6-hour TTL |
| Location | Browser Geolocation API + fallback autocomplete |
| Maps/Distance | MapBox API (or Google Distance Matrix API) |
| Weather/Moon | OpenWeatherMap API (or StormGlass API) |
| Fishing Data | Mock JSON dataset (MVP); extensible to public fishing APIs |

---

## 4. Core Features

### 4.1 Header / Controls
- **Max Drive Time Dropdown:** 0.5 to 4.0 hours in 30-minute increments.
- **Child Age Input:** Integer 1–12.
  - If `age < 6` → filter and prioritize **Dock** or **Clear Bank** locations only.
- **Location Detection:** Auto-detect via Geolocation API; fallback to a search/autocomplete bar.

### 4.2 Home View — Location List
- Cards sorted by **driving distance** (Distance Matrix API or Haversine formula fallback).
- Each card displays:
  - Location name, distance, and drive time estimate.
  - **Success Score** (0–100) displayed as a color-coded badge (🟢 70+, 🟡 40–69, 🔴 <40).
  - Quick-glance tags: `High Activity`, `Restrooms`, `Easy Casting`, `Dock Access`, `Playground`.

### 4.3 Detail View — Location Profile
- **Gear Guide:** Dynamic recommendations based on target species.
- **30-Day Forecast Calendar:** Color-coded grid (Green/Yellow/Red) based on barometric pressure and moon phases.
- **Logistics Panel:** Fees, parking, accessibility type (Dock / Clear Bank / Obstructed Bank).
- **Kid-Factor Tags:** Restrooms ✅, Playground ✅, Shaded Area ✅, Picnic Tables ✅.

---

## 5. The "Success Score" Algorithm

| Factor | Weight | Data Source |
|---|---|---|
| Catch Probability (weather temp + barometric pressure) | 35% | OpenWeatherMap |
| Lunar Phase Activity Multiplier | 20% | StormGlass / moon phase API |
| Kid-Factor Bonus (restrooms, playground, dock) | 25% | Mock JSON / Places API |
| Accessibility Score (Clear Bank > Obstructed) | 20% | Mock JSON dataset |

**Kid-Factor Scoring Detail:**
- Restrooms present: +8 pts
- Playground present: +7 pts
- Dock Access: +6 pts (mandatory bonus if `age < 6`)
- Shaded/Covered Area: +4 pts

---

## 6. Caching Strategy

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

## 7. Data Model — Location Object

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
  "region": "Atlanta, GA"
}
```

---

## 8. UI/UX Requirements
- All touch targets: **minimum 44×44px**
- Mobile-first: designed for 375px wide, responsive to desktop
- Font size minimum: **16px** for body text
- Bottom nav bar: **Home | Map | Saved**
- Color system: forest green `#2D6A4F`, sky blue `#48CAE4`, sand `#F4E285`

---

## 9. API Configuration

```javascript
// config.example.js
const CONFIG = {
  MAPBOX_API_KEY: "YOUR_MAPBOX_KEY_HERE",
  OPENWEATHER_API_KEY: "YOUR_OPENWEATHER_KEY_HERE",
  STORMGLASS_API_KEY: "YOUR_STORMGLASS_KEY_HERE"
};
```

---

## 10. File Structure

```
lets-go-fishing/
├── index.html
├── config.example.js
├── config.js              ← gitignored
├── app.js
├── scorer.js
├── data/
│   └── locations.json
├── styles/
│   └── tailwind.css
├── components/
│   ├── card.js
│   ├── detail.js
│   └── forecast.js
└── README.md
```

---

## 11. Backlog / Future Features
- [ ] PWA support (offline mode, home screen install)
- [ ] Interactive map view with clustered pins
- [ ] User-saved favorite spots (localStorage)
- [ ] Real-time fish reports integration
- [ ] Social sharing of fishing trip results
- [ ] Push notifications for "peak fishing window" alerts

---

## 12. Success Metrics (MVP)

| Metric | Target |
|---|---|
| Page load time (mobile 4G) | < 3 seconds |
| Locations returned per search | 5–15 within drive radius |
| Score calculation time | < 500ms |
| Cache hit rate after first load | > 80% |
