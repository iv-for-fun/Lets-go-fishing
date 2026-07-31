# 🎣 Let's Go Fishing — Kid-Friendly Fishing Spot Finder

A mobile-first web app that helps parents find the **best kid-friendly fishing spots** near them, ranked by drive time, amenities, and a proprietary **"Success Score"** — so you spend less time planning and more time fishing.

> **Live App:** [https://iv-for-fun.github.io/Lets-go-fishing](https://iv-for-fun.github.io/Lets-go-fishing)

---

## 🧭 Features

- 📍 **Auto-Location** — Uses the browser Geolocation API to find spots near you, with a manual address fallback
- 🚗 **Drive Time Filter** — Filter spots from 30 minutes to 4 hours away (30-min increments)
- 👦 **Child Age Input** — Ages 1–15; boosts dock-access spots in the score for kids under 6, but never hides a spot — accessibility is advisory, not a filter
- 🏆 **Success Score Algorithm** — Each spot is ranked by:
  - Catch Probability (weather temp, barometric pressure, lunar phase)
  - Kid-Factor bonus (restrooms, playgrounds, dock access)
  - Accessibility rating (Dock > Clear Bank > Obstructed Bank)
- 🃏 **Spot Cards** — Quick-glance tags ("High Activity," "Restrooms," "Easy Casting," "Dock Access," "Playground"), an amber **♻️ Catch & Release Only** badge, and a 🚧/⚠️ **closure/advisory notice** when a spot has one
- 📋 **Detail View** per spot including:
  - Dynamic **Gear Guide** (e.g., "Bobber & Worms" for panfish, "Small Spinners" for trout) plus a seasonal fish-behavior Parent Pro-Tip
  - **Reactive 7-Day Forecast** — hourly Fish Activity + Kid Comfort scoring with a "Parent-Trust" safety override, a "Best Window" peak-hour finder, and real moon-transit-based solunar windows (🟢/🟡/🔴 per hour and per day)
  - Legal status, hours, real proximity amenities, nearest bait & tackle, fees, an accessibility advisory note (verified vs. assumed), and a **🐟 What's Biting Lately** species chip row alongside Community Fish Sightings
- ⚡ **6-Hour Local Cache** — API results cached in `localStorage` to reduce redundant calls

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| UI Framework | HTML5 + Tailwind CSS (mobile-first, CDN) |
| Logic | Vanilla JavaScript (ES6+) |
| Hosting | GitHub Pages (client-side only) |
| Location | Browser Geolocation API + Nominatim (OSM) geocoding fallback |
| Drive Time | Haversine formula (client-side, no key required) |
| Weather & 7-Day Forecast | [Open-Meteo API](https://open-meteo.com/) — **free, no API key required**; graceful mock fallback only on fetch failure |
| Moon Phase & Solunar | Computed client-side — epoch-based phase + real moon-transit/rise/set astronomy (`solunar.js`) |
| Fishing Spots | Pre-built, per-state OpenStreetMap + DNR data (`data/spots/{ABBR}.json`, refreshed monthly), loaded per drive-time perimeter; live Overpass query only as a fallback for a state with no pre-built file yet; shows a "couldn't find any fishing spots" message when none are returned |
| Caching | `localStorage` (6-hour TTL, weather); `IndexedDB` (6-hour TTL, pre-built spot data) |

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/iv-for-fun/Lets-go-fishing.git
cd Lets-go-fishing
```

### 2. Run Locally

No build step, no API key, no setup. Open `index.html` directly in your browser, or use a simple local server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

### 3. Deploy to GitHub Pages

Push to the `main` branch. GitHub Pages serves directly from the repo root — no build pipeline, no secrets needed.

---

## 📁 Project Structure

```
Lets-go-fishing/
│
├── index.html            # SPA shell, nav, views, map logic + inline UI script
├── app.js                # Search, location resolution, scoring pipeline, cache, card/detail rendering
├── scorer.js             # Card-list Success Score algorithm, epoch moon phase, pressure trend
├── enrichment.js         # Perimeter geometry helpers (statesInPerimeter) + DNR info panel
├── spots-loader.js       # Loads pre-built data/spots/{ABBR}.json per drive-time perimeter, IndexedDB-cached
├── solunar.js            # Moon transit/rise/set astronomy — solunar major/minor windows
├── forecast.js           # Open-Meteo fetch, 7-day scoring engine, Forecast tab rendering
│
├── data/
│   ├── locations.json           # Curated spot dataset (not currently used as a runtime fallback)
│   ├── us-states-borders.geojson # State polygons for perimeter scoping
│   ├── dnr/{ABBR}.json           # Curated per-state DNR inputs (build-time source)
│   ├── spot-notices.json         # Hand-edited closure/advisory override, merged in at build time
│   └── spots/{ABBR}.json         # Pre-built merged OSM+DNR spot data the app actually loads (regenerated monthly)
│
├── tools/
│   └── build_spots_data.py      # Generates data/spots/{ABBR}.json from OpenStreetMap + data/dnr
│
├── .github/
│   └── workflows/        # Data-generation workflows (state borders, DNR, spots)
│
├── PRD.md                # Product requirements
├── CLAUDE.md             # Project context for Claude Code (imports PRD.md)
└── README.md
```

---

## 🧮 Success Score Algorithm

Each fishing spot receives a **0–100 score** calculated as:

```
Success Score = (Catch Probability × 0.35) + (Pressure Trend × 0.10)
              + (Lunar Phase × 0.20) + (Kid Factor × 0.20) + (Accessibility × 0.15)
```

| Component | Weight | Factors |
|---|---|---|
| **Catch Probability** | 35% | Air temp + barometric pressure level (Open-Meteo / mock) |
| **Lunar Phase** | 20% | Client-side moon-phase activity multiplier |
| **Kid Factor** | 20% | +points for restrooms, playground, shade, dock access (cap 25) |
| **Accessibility** | 15% | Dock > Clear Bank > Obstructed Bank |
| **Pressure Trend** | 10% | Rising / falling / stable from a rolling 3-reading store |

See `scorer.js` for the exact `WEIGHTS` and component functions.

---

## 📱 Mobile-First Design

All touch targets are a minimum of **44×44px** per Apple/Google UX guidelines. The UI is designed for one-handed use on a smartphone while managing a fishing rod and a kid simultaneously.

---

## 🗂️ Project Roadmap

Tracked in the **[Where to Fish App](https://github.com/users/iv-for-fun/projects)** GitHub Project.

- [x] MVP: Location + curated spot data + Success Score cards
- [x] Live weather + barometric pressure integration (Open-Meteo)
- [x] Moon phase calculation (client-side)
- [x] Drive time filtering via Haversine formula
- [x] Reactive 7-Day Forecast Engine (replaces the earlier 30-Day Forecast calendar)
- [x] Gear Guide dynamic recommendations
- [ ] User-submitted spot reviews
- [ ] Offline PWA support

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

*Built with ❤️ for parents who want their kids to love the outdoors.*
