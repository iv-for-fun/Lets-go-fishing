# 🎣 Let's Go Fishing — Kid-Friendly Fishing Spot Finder

A mobile-first web app that helps parents find the **best kid-friendly fishing spots** near them, ranked by drive time, amenities, and a proprietary **"Success Score"** — so you spend less time planning and more time fishing.

> **Live App:** [https://iv-for-fun.github.io/Lets-go-fishing](https://iv-for-fun.github.io/Lets-go-fishing)

---

## 🧭 Features

- 📍 **Auto-Location** — Uses the browser Geolocation API to find spots near you, with a manual address fallback
- 🚗 **Drive Time Filter** — Filter spots from 30 minutes to 4 hours away (30-min increments)
- 👦 **Child Age Input** — Ages 1–12; kids under 6 are automatically routed to dock or clear-bank locations
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
| Location | Browser Geolocation API (no key required) |
| Drive Time | Haversine formula (client-side, no key required) |
| Weather & Pressure | [Open-Meteo API](https://open-meteo.com/) (free, no token) |
| Moon Phases | Computed client-side (astronomical formula) |
| Fishing Spots | Curated regional JSON dataset (bundled, no API key) |
| Caching | `localStorage` (6-hour TTL) |

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/iv-for-fun/Lets-go-fishing.git
cd Lets-go-fishing
```

### 2. Run Locally

No build step required. Open `index.html` directly in your browser, or use a simple local server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

### 3. Deploy to GitHub Pages

Push to the `main` branch. GitHub Pages serves directly from the repo root — no build pipeline needed.

---

## 📁 Project Structure

```
Lets-go-fishing/
│
├── index.html              # SPA entry point — app shell & layout
│
├── assets/
│   ├── css/
│   │   └── styles.css      # Custom styles & Tailwind overrides
│   ├── js/
│   │   ├── app.js          # App bootstrap, routing, view rendering
│   │   ├── location.js     # Geolocation API + address fallback
│   │   ├── scoring.js      # Success Score algorithm
│   │   ├── weather.js      # Open-Meteo API integration
│   │   ├── lunar.js        # Moon phase calculation (client-side)
│   │   ├── forecast.js     # 30-day calendar logic
│   │   ├── cache.js        # localStorage cache layer (6-hr TTL)
│   │   └── utils.js        # Haversine formula, helpers, formatters
│   └── icons/
│       └── favicon.ico
│
├── data/
│   └── spots.json          # Curated regional fishing spot dataset
│
├── docs/
│   └── BACKLOG.md          # Feature backlog & design notes
│
└── README.md
```

---

## 🧮 Success Score Algorithm

Each fishing spot receives a **0–100 score** calculated as:

```
Success Score = (Catch Probability × 0.5) + (Kid Factor × 0.3) + (Accessibility × 0.2)
```

| Component | Factors |
|---|---|
| **Catch Probability** | Air temp, barometric pressure trend, lunar phase |
| **Kid Factor** | +points for restrooms, playground, dock access |
| **Accessibility** | Clear bank = high; obstructed bank = low; dock = high |

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
