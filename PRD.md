# Product Requirements Document (PRD)
## Lets-Go-Fishing — Kid-Friendly Fishing Spot Finder
**Version:** 1.4 | **Updated:** July 8, 2026 | **Owner:** iv-for-fun

> **v1.4 Change Log:** Corrected doc-vs-code drift. The **AI Research Agent (§4.6) was never actually implemented** — `enrichment.js` was never committed and the wiring shipped in v1.3 broke the live site; it has been reverted and moved back to the backlog (tracking: issue #33). **Static fallback spots removed** — when the live Overpass query returns nothing, the app now shows a "couldn't find any fishing spots" message instead of substituting curated Atlanta spots (`data/locations.json` remains in the repo but is no longer a runtime fallback). **Pressure trend is now wired into the score** (previously computed but never applied). Child age range confirmed 1–15 in `index.html`.

> **v1.3 Change Log:** Added AI Research Agent (§4.6). New data sources: Georgia DNR public access points (`enrichFromDNR`), iNaturalist community fish sightings (`enrichSpotWithINat`), and optional OpenAI/Gemini LLM summarization. Extended data model (§8) with `dnr` sub-object. Updated API config (§11) with `OPENAI_API_KEY`. Updated file structure (§12) with `enrichment.js`. Backlog updated (§14). *(⚠️ Superseded by v1.4 — this work was reverted; see above.)*

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
| Logic | Vanilla JavaScript (ES6+) | `app.js`, `scorer.js`, `enrichment.js`, `config.js` |
| Hosting | GitHub Pages (static, client-side only) | |
| Caching | `localStorage` with 6-hour TTL | Keyed by location + date |
| Location | Browser Geolocation API + Nominatim (OSM) geocoding fallback | Replaces Google Places Autocomplete |
| Maps | Leaflet.js + OpenStreetMap tiles | Replaces MapBox API |
| Distance | Haversine formula ÷ avg 45 mph estimate | Replaces Distance Matrix API |
| Spot Data | Overpass API (OpenStreetMap) — live fetch only | Shows a "couldn't find any fishing spots" message when the query returns nothing (no static fallback as of v1.4) |
| Spot Enrichment | *(Not implemented — reverted; see §4.6 / issue #33)* | — |
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
| **Overview** | Weather widgets (Temp, Wind, Moon), 🌿 Community Fish Sightings (iNat panel), top species chips, Google Maps directions link |
| **Fish & Gear** | Beginner Setup (Ages 3–7) + Junior Pro (Ages 8+) gear guides matched to target species; pro tip |
| **Amenities** | Restrooms, Playground, Picnic Area, Shade; Parking Fee, Fishing License, Access Type; DNR Info panel (when available) |
| **Forecast** | 30-day calendar grid — days 1–5 blended (moon + pressure trend), days 6–30 moon-only |

**Parent Pro-Tip** panel appears below the tab content on every location — sourced from `getProTip(loc)`, which varies by primary species and dock vs. bank access type.

### 4.4 Map View
- Leaflet.js map with color-coded circle markers (green / yellow / red by score).
- Tap a marker to see a popup with score, distance, drive time, and a "View Details" button.

### 4.5 Saved Spots
- Bookmark icon on any card saves the location to `localStorage`.
- Dedicated **Saved** tab in bottom nav lists all bookmarked spots; tap to open detail view.

### 4.6 AI Research Agent (Spot Enrichment) 🔲 Backlog — NOT shipped (reverted)

> **Status (v1.4):** This section describes intended, not shipped, behavior. The v1.3 attempt was never functional — `enrichment.js` was never committed and the call sites broke the live site, so the work was reverted. Rebuild is tracked in **issue #33**. The design below is retained as the target spec.

When a user opens a spot's detail view, a lightweight client-side research pipeline runs asynchronously to enrich the spot's data with real-world information. All logic would live in `enrichment.js`.

#### Pipeline Overview

| Step | Source | Function | Notes |
|---|---|---|---|
| 1 | **Georgia DNR** public access JSON | `enrichFromDNR()` | Merges DNR amenity/species records during `init()`; adds DNR-only spots |
| 2 | **iNaturalist API** | `enrichSpotWithINat()` | Fetches recent verifiable fish observations within 10 km radius; free, no key |
| 3 | **LLM Summary** *(optional)* | `summarizeWithAI()` | Sends enriched data to OpenAI `gpt-4o-mini` or Gemini Flash to generate a friendly 2–3 sentence "What to Expect" blurb; requires `OPENAI_API_KEY` or `GEMINI_API_KEY` |

#### DNR Enrichment (`enrichFromDNR`)
- Loads Georgia DNR public fishing access points from a bundled/proxied JSON source.
- Normalizes records via `normalizeDNRRecord()` into a standard shape with `dnrId`, `waterbody`, `county`, `acres`, `amenities` (restrooms, ADA, parking, camping, bait shop, loan poles, kids programs), `confirmedSpecies`, `fees`, and `fishing` details.
- `matchDNRRecord(loc, dnrSpots)` fuzzy-matches on name similarity and geographic proximity (≤3 km) to merge DNR data into existing Overpass results.
- `mergeDNRIntoLoc(loc, match)` enriches matched spots with confirmed species, official fees, and DNR amenity flags.
- Unmatched DNR spots within drive time are appended to `allResults` as `source: "dnr"`.
- A **DNR Info panel** (`renderDNRPanel(loc)`) renders on the Amenities tab when `loc.dnr` is present, showing official waterbody stats, ADA accessibility, amenity icons, and a deep link to the DNR website.

#### iNaturalist Sightings (`enrichSpotWithINat`)
- Queries `https://api.inaturalist.org/v1/observations` filtered to `iconic_taxa=Actinopterygii` (fish), within 10 km, within the last 60 days.
- Returns up to 5 recent verified sightings with taxon name, observer, date, and photo.
- Results render as a **"🌿 Community Fish Sightings"** panel at the top of the Overview tab.
- Free and no API key required. Results cached in-memory per session.

#### LLM Summarization *(optional)*
- Triggered only when `CONFIG.OPENAI_API_KEY` or `CONFIG.GEMINI_API_KEY` is present.
- Prompt includes: spot name, region, access type, species, amenities, and up to 400 chars of iNat/DNR context.
- Model: `gpt-4o-mini` (OpenAI) or `gemini-1.5-flash` (Google).
- Estimated cost: < $0.0002 per call.
- Output replaces the static "What to Expect" placeholder with a dynamic, friendly summary.

#### Caching
- DNR data: fetched once per session, held in `_dnrCache`.
- iNat data: held in `_inatCache` keyed by spot ID (in-memory only, not `localStorage`).
- LLM summary: held in `_researchCache` keyed by spot ID (in-memory only).

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

> `source` is `"osm"` for live Overpass results; `"dnr"` for Georgia DNR-only spots; omitted or `"static"` for curated fallback spots.

**Extended DNR sub-object** (present when `source === "dnr"` or DNR match found):

```json
"dnr": {
  "waterbody": "Lake Allatoona",
  "county": "Cherokee",
  "acres": 12010,
  "status": "Public",
  "operator": "U.S. Army Corps of Engineers",
  "phone": "770-382-4700",
  "rampType": "Paved",
  "numLanes": 4,
  "motorRestrictions": "None",
  "yearRound": true,
  "bankFishing": true,
  "pier": true,
  "moreInfo": "Restrooms, ADA accessible, picnic area, camping nearby",
  "infoLink": "https://gadnr.org/..."
}
```

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
  OPENWEATHER_API_KEY: "YOUR_OPENWEATHER_KEY_HERE",
  // Optional — enables AI-generated "What to Expect" summaries in Detail view
  OPENAI_API_KEY:      "YOUR_OPENAI_KEY_HERE",    // gpt-4o-mini (~$0.0002/call)
  GEMINI_API_KEY:      "YOUR_GEMINI_KEY_HERE",    // gemini-1.5-flash (free tier)
  // MapBox, StormGlass, and Google APIs not used in current implementation
};
```

> **iNaturalist API** requires no key. **Georgia DNR data** is bundled/proxied and requires no key. Only OpenWeatherMap and LLM summarization (optional) require keys. The app degrades gracefully without any key.

---

## 12. File Structure

```
lets-go-fishing/
├── index.html          ← SPA shell, nav, views, forecast/map logic + inline UI script
├── app.js              ← search, location resolution, scoring pipeline, cache, UI rendering
├── scorer.js           ← Success Score algorithm, moon phase, pressure trend
├── config.js           ← API keys (OpenWeatherMap); committed so the client-side build works
├── config.example.js   ← Template (committed)
├── data/
│   └── locations.json  ← Curated spot dataset (not currently used as a runtime fallback)
│                          (enrichment.js — AI Research Agent — is NOT present; see §4.6 / issue #33)
└── .github/
    └── workflows/      ← GitHub Pages deployment
```

---

## 13. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Initial load time | < 3 seconds on 4G |
| Overpass API timeout | 25 seconds (hard limit in query) |
| Weather API timeout | Graceful fallback within 5 seconds |
| iNaturalist API timeout | 8 seconds; graceful fallback to empty panel |
| DNR enrichment timeout | 10 seconds; silent fail if unavailable |
| Cache hit rate | > 80% for repeated same-area searches within 6 hours |
| Accessibility | WCAG AA touch targets (44×44px), 16px minimum body font |

---

## 14. Feature Backlog

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Core SPA shell + bottom nav | ✅ Shipped | |
| 2 | Overpass API live spot fetch | ✅ Shipped | |
| 3 | Success Score algorithm | ✅ Shipped | |
| 4 | Weather integration (OWM) | ✅ Shipped | |
| 5 | Quick-glance tags | ✅ Shipped | |
| 6 | 30-day forecast calendar | ✅ Shipped | |
| 7 | Gear guide (14 species) | ✅ Shipped | |
| 8 | Fallback curated spots JSON | ❌ Removed (v1.4) | Live-only now; shows "couldn't find any fishing spots" when Overpass returns nothing |
| 9 | Saved spots (localStorage) | ✅ Shipped | |
| 10 | Leaflet map view | ✅ Shipped | |
| 11 | Nominatim geocoding | ✅ Shipped | |
| 12 | AI Research Agent (DNR + iNat + LLM) | 🔲 Backlog (reverted) | v1.3 attempt never worked (`enrichment.js` never committed); rebuild tracked in issue #33 |
| 13 | GA DNR confirmed species data file | 🔲 Backlog | Populate `data/dnr-access-points.json` with real GA DNR records |
| 14 | PWA / offline support | 🔲 Backlog | Service worker + manifest |
| 15 | User-submitted fish reports | 🔲 Backlog | Requires backend |
| 16 | Push notifications (tidal/weather alerts) | 🔲 Backlog | |
| 17 | Multi-state DNR expansion | 🔲 Backlog | Start with GA, expand to SC/TN/AL/FL |
