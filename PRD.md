# Product Requirements Document (PRD)
## Lets-Go-Fishing — Kid-Friendly Fishing Spot Finder
**Version:** 1.6 | **Updated:** July 12, 2026 | **Owner:** iv-for-fun

> **v1.6 Change Log:** Phase 2 of the pre-built, perimeter-scoped data re-architecture (epic #39) shipped: a new `spots-loader.js` replaces the live per-search Overpass call with the pre-built `data/spots/{ABBR}.json` files from Phase 1 (issue #35), scoped to the drive-time perimeter and cached in **IndexedDB** (6hr TTL). Live Overpass now runs only as a fallback for a state with no pre-built file yet (tracking: issue #36). The live in-browser DNR fetch/match/merge code (`enrichFromDNR`, `matchDNRRecord`, `mergeDNRIntoLoc`, `dnrRecordToLoc`, `normalizeDNRRecord`) was removed from `enrichment.js` — that merge now happens once at build time (Phase 1); `enrichment.js` keeps only the perimeter-geometry helpers (now shared with `spots-loader.js`) and `renderDNRPanel()`. Updated Technical Stack (§3), AI Research Agent status (§4.6), Caching Strategy (§7), Non-Functional Requirements (§13), file structure (§12), and backlog (§14, row 18).

> **v1.5 Change Log:** Phase 1 of the pre-built, perimeter-scoped data re-architecture (epic #39) shipped: `tools/build_spots_data.py` + the **Generate Spots Data** workflow build merged `data/spots/{ABBR}.json` (SE region by default — GA, AL, SC, TN, NC) from OpenStreetMap (broadened tag set, amenity/bait/food proximity join) fuzzy-merged with curated `data/dnr/{ABBR}.json` records (tracking: issue #35). **Build-time only — the live app does not read `data/spots/` yet**; runtime remains live Overpass as described elsewhere in this doc until Phase 2 (issue #36) ships. Updated file structure (§12) and backlog (§14, row 18).

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
| Logic | Vanilla JavaScript (ES6+) | `app.js`, `scorer.js`, `enrichment.js`, `spots-loader.js`, `config.js` |
| Hosting | GitHub Pages (static, client-side only) | |
| Caching | `localStorage` (6hr TTL, weather) + `IndexedDB` (6hr TTL, pre-built spot data) | Keyed by location + date (weather) / state abbr (spots) |
| Location | Browser Geolocation API + Nominatim (OSM) geocoding fallback | Replaces Google Places Autocomplete |
| Maps | Leaflet.js + OpenStreetMap tiles | Replaces MapBox API |
| Distance | Haversine formula ÷ avg 45 mph estimate | Replaces Distance Matrix API |
| Spot Data | Pre-built, per-state `data/spots/{ABBR}.json` (OSM + DNR merged monthly at build time), loaded per drive-time perimeter via `spots-loader.js` (issue #36) | Live Overpass API fallback only for a perimeter state with no pre-built file yet; shows a "couldn't find any fishing spots" message when nothing is found either way |
| Spot Enrichment | DNR merge baked in at build time (`tools/build_spots_data.py`, issue #35); `enrichment.js` renders the DNR panel from the pre-built `dnr` sub-object. iNaturalist sightings remain live (§4.6) | LLM summarization still backlog — see §4.6 |
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
  - "Live" badge only when a spot came from the live-Overpass fallback path this search (`source === 'osm-live'`) — pre-built OSM/DNR spots (the normal case) don't carry it, since they're refreshed monthly, not fetched live.
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

> **Status (v1.6):** DNR merging is now **build-time only**. Through v1.5, `enrichment.js` fetched and fuzzy-matched DNR records into search results live, per request. Phase 2 of the data re-architecture (issue #36) removed that live fetch/match/merge code entirely — the same matching rules (name similarity + ≤3km proximity, described below) now run once a month in `tools/build_spots_data.py` (Phase 1, issue #35), and the merged result ships pre-baked in `data/spots/{ABBR}.json`'s `dnr` sub-object. `enrichment.js` today only (a) provides the perimeter-geometry helpers (`statesInPerimeter()`, now shared with `spots-loader.js` to scope which `data/spots/{ABBR}.json` files to fetch) and (b) renders the **DNR Info panel** (`renderDNRPanel(loc)`) from whatever `loc.dnr` object it's handed — it no longer knows or cares whether that came from a build-time merge or (hypothetically) a live one. **(2) iNaturalist "Community Fish Sightings"** remains live, unaffected (`app.js`). **Only (3) LLM summarization remains backlog** (tied to the API-key decision). Real authoritative DNR data for all states is still needed (tracked in #33).

When a user opens a spot's detail view, live enrichment (today: iNaturalist sightings) runs asynchronously to add real-world information the pre-built data can't carry (recent activity). DNR/species/amenity enrichment, by contrast, is already merged into the spot record by the time it reaches the browser.

#### Pipeline Overview

| Step | Source | Function | Notes |
|---|---|---|---|
| 1 | **State DNR** curated JSON | `tools/build_spots_data.py` (build time) | Fuzzy-merges DNR amenity/species records into `data/spots/{ABBR}.json` monthly; adds DNR-only spots (`source: "dnr"`). No longer a runtime call — see issue #36. |
| 2 | **iNaturalist API** | `fetchINatSightings()` (`app.js`) | Fetches recent verifiable fish observations within 10 km radius; free, no key; still live, on detail-view open |
| 3 | **LLM Summary** *(optional)* | `summarizeWithAI()` | Sends enriched data to OpenAI `gpt-4o-mini` or Gemini Flash to generate a friendly 2–3 sentence "What to Expect" blurb; requires `OPENAI_API_KEY` or `GEMINI_API_KEY` |

#### DNR Merge (build time, `tools/build_spots_data.py`)
- Loads curated `data/dnr/{ABBR}.json` public fishing access points.
- Normalizes records into a standard shape with `dnrId`, `waterbody`, `county`, `acres`, `amenities` (restrooms, ADA, parking, camping, bait shop, loan poles, kids programs), `confirmedSpecies`, `fees`, and `fishing` details.
- Fuzzy-matches on name similarity and geographic proximity (≤3 km) to merge DNR data into OSM-derived spots for the same state.
- Merged spots get confirmed species, official fees, and DNR amenity flags folded in.
- Unmatched DNR spots within the state are written into `data/spots/{ABBR}.json` as their own records with `source: "dnr"`.
- At runtime, a **DNR Info panel** (`renderDNRPanel(loc)`, `enrichment.js`) renders on the Amenities tab whenever `loc.dnr` is present (regardless of whether the spot's own `source` is `"osm"` or `"dnr"`), showing official waterbody stats, ADA accessibility, amenity icons, and a deep link to the DNR website.

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
- DNR data: pre-merged at build time into `data/spots/{ABBR}.json`; no runtime DNR cache needed anymore (see §7 for how the merged spot files themselves are cached).
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
Weather API responses are stored in `localStorage` keyed by location + date; every explicit **Find Spots** click calls `bustCacheForCoords()` to force fresh weather for the resolved coordinates.

**Spot data is cached differently** (issue #36): the pre-built `data/spots/{ABBR}.json` files change monthly, not per-request, so they're intentionally *not* busted on every click. `spots-loader.js` caches each fetched state's normalized spots in **IndexedDB** (`letsGoFishingCache` DB, `stateSpots` store, keyed by state abbr) with the same 6-hour TTL, so a repeat search for the same area hits IndexedDB instead of re-fetching. Only the live-Overpass fallback path (for a perimeter state with no pre-built file yet) uses the per-click-busted `localStorage` `spots_{coordKey}` cache from `fetchFishingSpotsNearby()`.

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

> `source` is `"osm"` for pre-built OSM-derived spots (`data/spots/{ABBR}.json`, the normal case, refreshed monthly — see §3, §7); `"osm-live"` specifically for spots fetched via the live-Overpass fallback this search (only used when a perimeter state has no pre-built file yet, so the "Live" badge is accurate); `"dnr"` for state-DNR-only spots (now written into `data/spots/{ABBR}.json` at build time, not merged live); omitted or `"static"` for curated fallback spots (currently unused, see backlog row 8).

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
- Status banners for: GPS denial, missing weather API key, data source (pre-built OSM+DNR database vs. live-Overpass fallback), and active location display

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
├── enrichment.js       ← perimeter-geometry helpers (statesInPerimeter, shared with spots-loader.js) + DNR info panel (§4.6)
├── spots-loader.js     ← loads pre-built data/spots/{ABBR}.json per drive-time perimeter, IndexedDB-cached (§7); live-Overpass fallback (issue #36)
├── config.js           ← API keys (OpenWeatherMap); committed so the client-side build works
├── config.example.js   ← Template (committed)
├── data/
│   ├── locations.json          ← Curated spot dataset (not currently used as a runtime fallback)
│   ├── us-states-borders.geojson ← State polygons; used to scope spots loading to the perimeter
│   ├── dnr/
│   │   ├── index.json          ← Manifest: which states have DNR data files (regenerated)
│   │   └── {ABBR}.json         ← Per-state DNR public-access records (GA curated; others generated); build-time input only
│   └── spots/                  ← Merged OSM+DNR spot data (see docs/MIGRATION_PLAN.md); this is what the app actually loads (issue #36)
│       ├── index.json          ← Manifest: which states have a built spots file
│       └── {ABBR}.json         ← Per-state merged fishing spots (OSM + DNR + amenity/bait proximity)
├── tools/
│   ├── build_dnr_data.py       ← Generates data/dnr/{ABBR}.json for all states from OpenStreetMap
│   ├── build_spots_data.py     ← Generates data/spots/{ABBR}.json (SE region by default) — issue #35
│   └── test_build_spots_data.py ← Offline unit tests for build_spots_data.py's pure logic
└── .github/
    └── workflows/      ← GitHub Pages deploy · state-borders gen · DNR-data gen · spots-data gen (generate-spots-data.yml)
```

**Populating DNR data for all states:** run the **Generate DNR Data** workflow (Actions tab → `workflow_dispatch`). It runs `tools/build_dnr_data.py` on GitHub (where Overpass is reachable), which builds a per-state file of real OpenStreetMap boat-ramp / fishing-access points for every state, filtered to each state's polygon, and rebuilds the manifest. Files marked `"curated": true` (e.g. `GA.json`) are never overwritten, so authoritative per-state data always wins over the OSM baseline. OSM source is community data, not official DNR records — labelled as such in each generated file.

**Populating merged spot data (data/spots/):** run the **Generate Spots Data** workflow (Actions tab → `workflow_dispatch`). It runs `tools/build_spots_data.py` on GitHub (where Overpass is reachable), which fetches a broadened OSM fishing-spot tag set + amenity/bait/food nodes per state, spatial-joins amenities to spots in code, fuzzy-merges in curated `data/dnr/{ABBR}.json` records, and writes `data/spots/{ABBR}.json` + rebuilds the manifest. Defaults to the Southeast region (GA, AL, SC, TN, NC); pass explicit state abbreviations to build others. This is Phase 1 of the re-architecture in `docs/MIGRATION_PLAN.md` (epic #39); the app has read `data/spots/` at runtime since Phase 2 (issue #36) shipped in v1.6.

---

## 13. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Initial load time | < 3 seconds on 4G |
| Overpass API timeout | 25 seconds (hard limit in query); only invoked as the live-fallback path (issue #36) |
| Weather API timeout | Graceful fallback within 5 seconds |
| iNaturalist API timeout | 8 seconds; graceful fallback to empty panel |
| Pre-built spots fetch | No explicit timeout; any failure (network, missing file) falls back to live Overpass for that search |
| Cache hit rate | > 80% for repeated same-area searches within 6 hours (IndexedDB for spot data, localStorage for weather) |
| Accessibility | WCAG AA touch targets (44×44px), 16px minimum body font |

---

## 14. Feature Backlog

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Core SPA shell + bottom nav | ✅ Shipped | |
| 2 | Overpass API live spot fetch | ✅ Shipped | Now the fallback path only (issue #36) — primary source is pre-built `data/spots/{ABBR}.json` (row 18) |
| 3 | Success Score algorithm | ✅ Shipped | |
| 4 | Weather integration (OWM) | ✅ Shipped | |
| 5 | Quick-glance tags | ✅ Shipped | |
| 6 | 30-day forecast calendar | ✅ Shipped | |
| 7 | Gear guide (14 species) | ✅ Shipped | |
| 8 | Fallback curated spots JSON | ❌ Removed (v1.4) | Live-only now; shows "couldn't find any fishing spots" when Overpass returns nothing |
| 9 | Saved spots (localStorage) | ✅ Shipped | |
| 10 | Leaflet map view | ✅ Shipped | |
| 11 | Nominatim geocoding | ✅ Shipped | |
| 12 | AI Research Agent (DNR + iNat + LLM) | 🟡 Partial | iNat panel live (`app.js`); DNR merge moved from a live per-request match (v1.4) to a build-time merge (`tools/build_spots_data.py`, v1.6) — `enrichment.js` now only renders the DNR panel. Only LLM summary still backlog. Tracked in issue #33 |
| 13 | Real DNR data per state | 🟡 Partial | Pipeline shipped: `tools/build_dnr_data.py` + `generate-dnr-data.yml` build all states from OpenStreetMap on demand. Replace OSM baseline with authoritative state-agency data per state (drop in a `"curated": true` file) as it's sourced |
| 14 | PWA / offline support | 🔲 Backlog | Service worker + manifest |
| 15 | User-submitted fish reports | 🔲 Backlog | Requires backend |
| 16 | Push notifications (tidal/weather alerts) | 🔲 Backlog | |
| 17 | Multi-state DNR expansion | 🔲 Backlog | Start with GA, expand to SC/TN/AL/FL |
| 18 | Pre-built, perimeter-scoped spot data (epic #39) | 🟡 Partial | **Phase 1 shipped (issue #35):** `tools/build_spots_data.py` + `generate-spots-data.yml` build merged `data/spots/{ABBR}.json` (SE region) from OSM + DNR. **Phase 2 shipped (issue #36):** `spots-loader.js` loads those files per drive-time perimeter, IndexedDB-cached; live Overpass demoted to fallback-only; live in-browser DNR merge removed. Remaining: Phase 3 card/detail UI (#37 — catch-&-release badge, hours, real amenities, bait, accessibility advisory), Phase 4 scale (#38) |
