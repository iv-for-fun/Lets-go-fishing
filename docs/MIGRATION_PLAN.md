# Migration Plan — Pre-built, Perimeter-Scoped Fishing Data

**Status:** Planned · **Owner:** iv-for-fun · **Tracking epic:** see repo issues

This is the design north-star for moving Lets-Go-Fishing from live per-search API
calls to a pre-built, per-state static data model. Build against this doc; keep it
updated as decisions change.

---

## 1. Principle

- **Slow-changing data → pre-built static files, refreshed monthly.** Fishing spots,
  access points, amenities — lakes don't move.
- **Fast-changing data → live at request.** Weather, moon/pressure, community sightings.
- Everything stays **free** on GitHub (Pages + Actions), well under the ~1 GB limit.

## 2. Three data sources

| Source | Role | Fetched |
|---|---|---|
| **OpenStreetMap** (Overpass now, Geofabrik-swappable later) | Primary spot inventory + amenities | Build time, monthly |
| **State DNR files** (`data/dnr/{ABBR}.json`) | Authoritative enrichment (official amenities/species/access) | Build time (curated inputs, hand-maintained) |
| **iNaturalist** | Recent community fish sightings (10 km / 60 days) | Live, on detail-view open |

## 3. Data flow

```
MONTHLY BUILD (GitHub Actions — has network)      RUNTIME (browser — static files only)
──────────────────────────────────────────       ─────────────────────────────────────
per state:                                        on "Find Spots":
  fetch OSM fishing spots (tag set §5)              statesInPerimeter(coords, driveMi)
  fetch OSM amenity/shop/food nodes                 load data/spots/{ABBR}.json per state
  read data/dnr/{ABBR}.json (curated)               (cache in IndexedDB)
  ── spatial-join amenities (§6) ──                 concat → distance → drive-time filter
  ── fuzzy-merge DNR (§7) ──                         → score & rank (weather, moon, pressure)
  ── attach bait/food (§6) ──                        → render
  write data/spots/{ABBR}.json (merged)            live per detail view: iNaturalist panel
  rebuild data/spots/index.json (manifest)
```

## 4. File layout

| Path | Role | Committed |
|---|---|---|
| `data/dnr/{ABBR}.json` | DNR **inputs** (curated, hand-maintained; `"curated": true`) | ✅ durable source |
| `data/spots/{ABBR}.json` | **Merged output** the app loads (OSM + DNR + amenities + bait) | ✅ regenerated monthly |
| `data/spots/index.json` | Manifest of built states | ✅ |
| `data/us-states-borders.geojson` | Perimeter geometry | ✅ (exists) |
| raw OSM extract / Overpass results, amenity/shop pulls | Transient build artifacts | ❌ discarded |

Rule: **anything the build can re-create is transient (raw OSM); anything it can't
(curated DNR) is committed and never overwritten; the merged output is committed and
freely regenerated.**

## 5. OSM tag set (build filter)

**Pull as fishing spots:**
- `leisure=fishing` (node/way/rel)
- `fishing=yes | catch_and_release | permissive` (any type) ← the attribute catch we were missing
- `sport=fishing`
- `man_made=fishing_peg`
- `man_made=pier` **with** a fishing signal → "Dock"
- `leisure=slipway` (boat ramps) → access points; **this is what surfaces river access (e.g. the Chattahoochee)**
- named `natural=water`, named `landuse=reservoir`

**Hard-exclude (never shown):** `fishing=private`, `fishing=no`, `industrial/landuse=aquaculture`, `relation leisure=park`.

**Legal status** (from `fishing=*` value, surfaced on the card):
- `yes` → public · `catch_and_release` → **♻️ Catch & Release Only** (amber warning badge; also reinforced in detail view) · `private`/`no` → excluded.

**Keep unnamed** high-confidence spots (fallback label); require a name only for the broad `natural=water` catch. **Drop the `out center 60` cap** (build-time, per state).

## 6. Amenity & service enrichment (proximity)

Most kid-relevant amenities are **separate nearby nodes**, not tags on the fishing feature
(this is why today's amenity flags are wrong/uniform). So the build **bulk-pulls amenity
nodes per state once, then spatial-joins in code** — no per-spot network calls.

- **On-site (~300–500 m):** `amenity=toilets` (+`toilets:wheelchair`, `changing_table`),
  `amenity=drinking_water`, `leisure=playground`, `amenity=parking` (+`fee`), `amenity=shelter`,
  `amenity=picnic_table`, `amenity=bbq`, `amenity=bench`.
- **Nearby services (~5–10 mi):** `shop=fishing` (bait & tackle), food (`amenity=cafe/fast_food/restaurant`).

**Read directly from the spot's own tags:** `opening_hours` (incl. `sunrise-sunset`), `fishing=*`
(legal status), `fee`, `operator`, `website`, `name`, `wheelchair`.

**Unknown ≠ absent / ≠ open** (issue #34): missing data shows "not listed," never a false promise.

## 7. DNR merge (deterministic, per state, build time)

- Fuzzy-match DNR ↔ OSM by name similarity + ≤ 3 km → merge species/fees/amenities into the card.
- Unmatched DNR access points → standalone spots (`source: "dnr"`).
- Dedupe. All matching/merging happens at build time — **none in the browser.**

## 8. Runtime

- Replace live Overpass with: perimeter states → load merged `data/spots/{ABBR}.json` → **IndexedDB** cache (holds MBs; localStorage is too small).
- Keep live: OpenWeather, moon math, pressure trend, iNaturalist (detail view).
- Optional **live-Overpass fallback** only for a state with no built file yet.
- Runtime does: distance → drive-time filter → **score & rank** (`scorer.js`) → render. No merging.
- **No accessibility hard-filter** (issue #34) — surface as advisory.

## 9. Example merged spot record

```jsonc
{
  "name": "Morgan Falls Overlook Park — River Access",
  "coordinates": { "lat": 33.95, "lng": -84.42 },
  "legalStatus": "public",                 // fishing=yes on the spot
  "hours": "sunrise-sunset",               // opening_hours on the spot
  "accessibility": "Dock",                 // slipway/pier → Dock
  "amenities": {                           // proximity, within ~400 m
    "restrooms": true, "changingTable": true, "drinkingWater": true,
    "playground": true, "parking": true, "shelter": false
  },
  "nearbyBait": [{ "name": "Cohutta Fishing Co.", "distanceMi": 3.1 }],
  "targetSpecies": ["Largemouth Bass", "Bluegill", "Trout"],
  "source": "osm"
}
```

## 10. Phased rollout

1. **Phase 1 — Build pipeline (SE region).** Generator + workflow producing merged
   `data/spots/{GA,AL,SC,TN,NC}.json` (OSM tag set + exclusions + amenity proximity join +
   DNR merge + bait/hours/legal-status). Validates the whole chain on the Atlanta/Chattahoochee area.
2. **Phase 2 — Runtime swap.** Perimeter loader reads merged files + IndexedDB cache; retire
   live Overpass (keep as fallback). No merging in browser.
3. **Phase 3 — Card/detail UI.** Catch-&-release badge, hours, real amenities, legal status,
   nearby bait, accessibility advisory (issue #34).
4. **Phase 4 — Scale.** Expand states incrementally; add monthly `schedule` cron; (later) swap
   Overpass → Geofabrik if national scale needs it.

## 11. Guardrails

- Whole site < 1 GB (we're at tens of MB); public-repo Actions unlimited; **no Git LFS**.
- Verify every phase in a real browser before merge; `main` stays deployable.

## 12. Related issues / deferred

- #33 — AI Research Agent rebuild (iNat done; DNR done; LLM deferred)
- #34 — accessibility & legal info surfaced, not used to exclude
- #13 — official per-state DNR data (replaces OSM baseline over time)
- #1 — OpenWeather key rotation (separate, deferred)
