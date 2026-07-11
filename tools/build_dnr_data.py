#!/usr/bin/env python3
"""
build_dnr_data.py — Generate per-state public fishing-access data for the
DNR enrichment layer (data/dnr/{ABBR}.json) + the manifest (data/dnr/index.json).

WHY THIS EXISTS
---------------
The app's DNR enrichment is state-generic and perimeter-scoped: it loads only
the states a search actually touches. But it needs a data file per state. This
script produces those files from a real, keyless, nationwide source
(OpenStreetMap via the Overpass API) so DNR data can be returned for every
state — not just Georgia.

It is meant to run in an environment WITH internet access (e.g. GitHub Actions,
see .github/workflows/generate-dnr-data.yml), because Overpass must be reachable.

DATA SOURCE & HONESTY
---------------------
Source is OpenStreetMap (community-maintained), labelled as such in every file's
`source` field. This is NOT official state-agency data. It covers named boat
ramps / slipways (`leisure=slipway`) and designated fishing sites
(`leisure=fishing`) — real public access points with real coordinates — but
amenity/species detail is only as good as OSM tagging (often sparse).

Authoritative state-DNR data always wins: any file containing `"curated": true`
is treated as hand-maintained and is NEVER overwritten by this script. To
promote a state to authoritative data, replace its file with curated records
and set `"curated": true` (see data/dnr/GA.json for the shape).

USAGE
-----
    python3 tools/build_dnr_data.py                 # all states
    python3 tools/build_dnr_data.py GA FL SC        # specific states
    python3 tools/build_dnr_data.py --min-records 1 # keep states with >=1 record
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

ROOT        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BORDERS     = os.path.join(ROOT, "data", "us-states-borders.geojson")
DNR_DIR     = os.path.join(ROOT, "data", "dnr")
MANIFEST    = os.path.join(DNR_DIR, "index.json")
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
SLEEP_BETWEEN_STATES = 8   # be polite to the free Overpass servers
MAX_RETRIES          = 4


# --------------------------------------------------------------------------- #
# Geometry — ray-casting point-in-polygon over a Polygon / MultiPolygon
# --------------------------------------------------------------------------- #
def _point_in_ring(lng, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def point_in_geometry(lng, lat, geometry):
    t = geometry["type"]
    if t == "Polygon":
        return _point_in_ring(lng, lat, geometry["coordinates"][0])
    if t == "MultiPolygon":
        return any(_point_in_ring(lng, lat, poly[0]) for poly in geometry["coordinates"])
    return False


def bbox_of(geometry):
    min_lng = min_lat = float("inf")
    max_lng = max_lat = float("-inf")

    def scan(ring):
        nonlocal min_lng, min_lat, max_lng, max_lat
        for lng, lat in ring:
            min_lng, min_lat = min(min_lng, lng), min(min_lat, lat)
            max_lng, max_lat = max(max_lng, lng), max(max_lat, lat)

    if geometry["type"] == "Polygon":
        for ring in geometry["coordinates"]:
            scan(ring)
    else:
        for poly in geometry["coordinates"]:
            for ring in poly:
                scan(ring)
    return (min_lng, min_lat, max_lng, max_lat)


# --------------------------------------------------------------------------- #
# Overpass
# --------------------------------------------------------------------------- #
def overpass_query(bbox):
    min_lng, min_lat, max_lng, max_lat = bbox
    b = f"{min_lat},{min_lng},{max_lat},{max_lng}"
    return f"""
[out:json][timeout:180];
(
  node["leisure"="slipway"]["name"]({b});
  way["leisure"="slipway"]["name"]({b});
  node["leisure"="fishing"]["name"]({b});
  way["leisure"="fishing"]["name"]({b});
);
out center 600;
""".strip()


def fetch_overpass(query):
    last_err = None
    for attempt in range(MAX_RETRIES):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            data = urllib.parse.urlencode({"data": query}).encode()
            req = urllib.request.Request(endpoint, data=data,
                                         headers={"User-Agent": "LetsGoFishing-DNR-builder/1.0"})
            with urllib.request.urlopen(req, timeout=200) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            last_err = e
            wait = 2 ** (attempt + 1)
            print(f"    Overpass attempt {attempt + 1} failed ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"Overpass failed after {MAX_RETRIES} attempts: {last_err}")


# --------------------------------------------------------------------------- #
# OSM element -> normalized DNR record
# --------------------------------------------------------------------------- #
def truthy(tags, *keys):
    for k in keys:
        v = tags.get(k)
        if v and v not in ("no", "false", "0"):
            return True
    return False


def element_to_record(el, abbr):
    lat = el.get("lat") or (el.get("center") or {}).get("lat")
    lng = el.get("lon") or (el.get("center") or {}).get("lon")
    if lat is None or lng is None:
        return None
    tags = el.get("tags", {})
    name = tags.get("name")
    if not name:
        return None

    is_ramp = tags.get("leisure") == "slipway"
    ada = tags.get("wheelchair") == "yes"
    species = []
    for key in ("fish", "species"):
        if tags.get(key):
            species = [s.strip() for s in tags[key].split(";") if s.strip()]
            break

    return {
        "dnrId": f"osm-{abbr.lower()}-{el.get('type', 'node')}-{el.get('id')}",
        "name": name,
        "waterbody": tags.get("water_name") or tags.get("name") or "",
        "county": "",
        "coordinates": {"lat": round(lat, 6), "lng": round(lng, 6)},
        "accessibility": "Dock" if is_ramp else "Clear Bank",
        "rampType": "Boat ramp" if is_ramp else "",
        "amenities": {
            "restrooms":   truthy(tags, "toilets", "toilets:disposal"),
            "restroomsADA": ada,
            "parking":     truthy(tags, "parking"),
            "parkingADA":  ada,
            "dockADA":     ada and is_ramp,
        },
        "confirmedSpecies": species,
        "fees": {
            "parking": ("Fee" if truthy(tags, "fee") else "Check Locally"),
            "fishing": "License May Be Required",
        },
        "fishing": {
            "bankFishing": not is_ramp,
            "pier": tags.get("man_made") == "pier",
        },
        "moreInfo": tags.get("description", ""),
        "infoLink": tags.get("website") or tags.get("url") or "",
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def is_curated(abbr):
    path = os.path.join(DNR_DIR, f"{abbr}.json")
    if not os.path.exists(path):
        return False
    try:
        with open(path) as f:
            return bool(json.load(f).get("curated"))
    except Exception:
        return False


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    min_records = 1
    if "--min-records" in sys.argv:
        min_records = int(sys.argv[sys.argv.index("--min-records") + 1])

    with open(BORDERS) as f:
        borders = json.load(f)

    features = {ft["properties"]["abbr"]: ft for ft in borders["features"]
               if ft.get("properties", {}).get("abbr")}
    wanted = [a.upper() for a in args] if args else sorted(features)

    os.makedirs(DNR_DIR, exist_ok=True)
    produced, skipped_curated = [], []

    for abbr in wanted:
        if abbr not in features:
            print(f"[{abbr}] no border geometry — skipping", flush=True)
            continue
        if is_curated(abbr):
            print(f"[{abbr}] curated file present — preserving", flush=True)
            skipped_curated.append(abbr)
            produced.append(abbr)
            continue

        geom = features[abbr]["geometry"]
        name = features[abbr]["properties"].get("name", abbr)
        print(f"[{abbr}] {name}: querying Overpass…", flush=True)
        try:
            data = fetch_overpass(overpass_query(bbox_of(geom)))
        except RuntimeError as e:
            print(f"[{abbr}] FAILED: {e}", flush=True)
            continue

        seen, records = set(), []
        for el in data.get("elements", []):
            rec = element_to_record(el, abbr)
            if not rec:
                continue
            # keep only points genuinely inside the state polygon (bbox bleeds
            # into neighbours)
            c = rec["coordinates"]
            if not point_in_geometry(c["lng"], c["lat"], geom):
                continue
            key = rec["name"].lower()
            if key in seen:
                continue
            seen.add(key)
            records.append(rec)

        print(f"[{abbr}] {len(records)} access points", flush=True)
        if len(records) >= min_records:
            out = {
                "state": abbr,
                "source": "OpenStreetMap via Overpass (community data — not official DNR records)",
                "generated": time.strftime("%Y-%m-%d"),
                "curated": False,
                "records": records,
            }
            with open(os.path.join(DNR_DIR, f"{abbr}.json"), "w") as f:
                json.dump(out, f, separators=(",", ":"))
            produced.append(abbr)

        time.sleep(SLEEP_BETWEEN_STATES)

    # Rebuild manifest from every state file now present on disk.
    states = sorted(
        fn[:-5] for fn in os.listdir(DNR_DIR)
        if fn.endswith(".json") and fn != "index.json"
    )
    with open(MANIFEST, "w") as f:
        json.dump({
            "description": "Manifest of US states with a DNR public-access data file in this directory. "
                           "The enrichment pipeline only fetches states/{ABBR}.json for states listed here "
                           "AND within the search perimeter. Regenerated by tools/build_dnr_data.py.",
            "schemaVersion": 1,
            "states": states,
        }, f, indent=2)

    print(f"\nDone. Manifest lists {len(states)} states: {', '.join(states)}")
    if skipped_curated:
        print(f"Preserved curated: {', '.join(skipped_curated)}")


if __name__ == "__main__":
    main()
