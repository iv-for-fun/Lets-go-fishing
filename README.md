# 🎣 Let's Go Fishing — Kid-Friendly Fishing Spot Finder

A mobile-first web app that helps parents find the **best kid-friendly fishing spots** near them, ranked by drive time, amenities, and a proprietary **"Success Score"** — so you spend less time planning and more time fishing.

> **Live App:** [https://iv-for-fun.github.io/Lets-go-fishing](https://iv-for-fun.github.io/Lets-go-fishing)

---

## 🧭 Features

- 📍 **Auto-Location** — Uses the browser Geolocation API to find spots near you, with a manual address fallback
- 🚗 **Drive Time Filter** — Filter spots from 30 minutes to 4 hours away (30-min increments)
- 👦 **Child Age Input** — Ages 1–15; kids under 6 are automatically routed to dock or clear-bank locations
- 🏆 **Success Score Algorithm** — Each spot is ranked by:
  - Catch Probability (weather temp, barometric pressure, lunar phase)
  - Kid-Factor bonus (restrooms, playgrounds, dock access)
  - Accessibility rating (Clear Bank > Obstructed Bank for young children)
- 🃏 **Spot Cards** — Quick-glance tags like "High Activity," "Restrooms," and "Easy Casting"
- 📋 **Detail View** per spot including:
  - Dynamic **Gear Guide** (e.g., "Bobber & Worms" for panfish, "Small Spinners" for trout)
  - **30-Day Forecast Calendar** — color-coded fish activity (🟢 Green / 🟡 Yellow / 🔴 Red) based on pressure trends and moon phases
  - Fees, parking, and accessibility details
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
| Weather & Pressure | [OpenWeatherMap API](https://openweathermap.org/api) (key in `config.js`, gitignored locally and generated at deploy time from a GitHub Actions secret; graceful mock fallback if absent) |
| Moon Phases | Computed client-side (astronomical formula) |
| Fishing Spots | Pre-built, per-state OpenStreetMap + DNR data (`data/spots/{ABBR}.json`, refreshed monthly), loaded per drive-time perimeter; live Overpass query only as a fallback for a state with no pre-built file yet; shows a "couldn't find any fishing spots" message when none are returned |
| Caching | `localStorage` (6-hour TTL, weather); `IndexedDB` (6-hour TTL, pre-built spot data) |

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/iv-for-fun/Lets-go-fishing.git
cd Lets-go-fishing
```

### 2. Add Your API Key (optional)

```bash
cp config.example.js config.js
```

Edit `config.js` and add your [OpenWeatherMap API key](https://openweathermap.org/api). `config.js` is gitignored — it's never committed. Without a key, the app falls back to mock weather data.

### 3. Run Locally

No build step required. Open `index.html` directly in your browser, or use a simple local server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

### 4. Deploy to GitHub Pages

Push to the `main` branch — the **Deploy to GitHub Pages** workflow (`.github/workflows/deploy-pages.yml`) generates `config.js` from the `OPENWEATHER_API_KEY` repository secret and publishes the site. No manual build step. One-time setup (repo admin, in GitHub Settings):

1. **Settings → Secrets and variables → Actions** → New repository secret named `OPENWEATHER_API_KEY` with your real key.
2. **Settings → Pages → Build and deployment → Source** → `GitHub Actions`.

---

## 📁 Project Structure

```
Lets-go-fishing/
│
├── index.html            # SPA shell, nav, views, map/forecast logic + inline UI script
├── app.js                # Search, location resolution, scoring pipeline, cache, card/detail rendering
├── scorer.js             # Success Score algorithm, moon phase, pressure trend
├── enrichment.js         # Perimeter geometry helpers (statesInPerimeter) + DNR info panel
├── spots-loader.js       # Loads pre-built data/spots/{ABBR}.json per drive-time perimeter, IndexedDB-cached
├── config.js             # API keys (OpenWeatherMap); gitignored, local-only — see config.example.js
├── config.example.js     # Config template (committed)
│
├── data/
│   ├── locations.json           # Curated spot dataset (not currently used as a runtime fallback)
│   ├── us-states-borders.geojson # State polygons for perimeter scoping
│   ├── dnr/{ABBR}.json           # Curated per-state DNR inputs (build-time source)
│   └── spots/{ABBR}.json         # Pre-built merged OSM+DNR spot data the app actually loads (regenerated monthly)
│
├── tools/
│   └── build_spots_data.py      # Generates data/spots/{ABBR}.json from OpenStreetMap + data/dnr
│
├── .github/
│   └── workflows/        # deploy-pages.yml (builds config.js from a repo secret, publishes to Pages) + data-generation workflows
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
| **Catch Probability** | 35% | Air temp + barometric pressure level (OpenWeatherMap / mock) |
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

- [ ] MVP: Location + curated spot data + Success Score cards
- [ ] Live weather + barometric pressure integration (Open-Meteo)
- [ ] Moon phase calculation (client-side)
- [ ] Drive time filtering via Haversine formula
- [ ] 30-Day Forecast calendar view
- [ ] Gear Guide dynamic recommendations
- [ ] User-submitted spot reviews
- [ ] Offline PWA support

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

*Built with ❤️ for parents who want their kids to love the outdoors.*
