#!/usr/bin/env python3
"""
build_spots_data.py — Phase 1 of the pre-built, perimeter-scoped data
migration (issue #35, epic #39). Generates merged per-state fishing-spot
data (data/spots/{ABBR}.json) + the manifest (data/spots/index.json).

WHY THIS EXISTS
---------------
See docs/MIGRATION_PLAN.md. Fishing spots don't change often, so instead of
querying Overpass live on every search (today's app.js behavior), we
pre-build one merged JSON file per state at build time: real OSM fishing
spots (broadened tag set), amenity/bait/food proximity joined in code (no
per-spot network calls), and curated DNR records (data/dnr/{ABBR}.json)
fuzzy-merged in. The browser will later (issue #36) just load the merged
file for whichever states are inside the search perimeter — no client-side
merging.

This script only WRITES data/spots/{ABBR}.json — it does not change what the
live app loads. Wiring the runtime to read these files is issue #36.

Must run in an environment WITH internet access (e.g. GitHub Actions, see
.github/workflows/generate-spots-data.yml), because Overpass must be
reachable.

DATA SOURCES & HONESTY
-----------------------
Primary inventory is OpenStreetMap (community-maintained) via Overpass —
labelled as such in every file's `source` field. Curated DNR records in
data/dnr/{ABBR}.json (see tools/build_dnr_data.py) are fuzzy-merged in where
they match an OSM spot by name + proximity (<=3km); unmatched DNR records
are kept as standalone spots. The DNR fuzzy-match algorithm here (stop
words, 0.5 similarity threshold, 3km radius) is a deliberate Python port of
enrichment.js's runtime matcher (_nameSimilarity/matchDNRRecord), which
stays live as a fallback for any state without a built file yet (see
docs/MIGRATION_PLAN.md §8). If you tune the threshold or stop-word list in
one, update the other, or build-time and runtime merges will silently
diverge for the same spot.

USAGE
-----
    python3 tools/build_spots_data.py                # SE region (Phase 1 default)
    python3 tools/build_spots_data.py GA              # just Georgia
    python3 tools/build_spots_data.py GA AL SC TN NC  # explicit state list

Pure logic (tag mapping, spatial join, DNR merge) is unit-tested offline in
tools/test_build_spots_data.py — no network required for those tests.
"""

import json
import math
import os
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

ROOT     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BORDERS  = os.path.join(ROOT, "data", "us-states-borders.geojson")
DNR_DIR  = os.path.join(ROOT, "data", "dnr")
SPOTS_DIR = os.path.join(ROOT, "data", "spots")
MANIFEST  = os.path.join(SPOTS_DIR, "index.json")

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
MAX_RETRIES          = 4
SLEEP_BETWEEN_QUERIES = 3    # between a state's fishing-spot and support queries
SLEEP_BETWEEN_STATES  = 8    # be polite to the free Overpass servers

# Phase 1 scope (docs/MIGRATION_PLAN.md §10): Southeast region, validated on
# the Atlanta/Chattahoochee area. Expansion is issue #38 (Phase 4).
DEFAULT_STATES = ["GA", "AL", "SC", "TN", "NC"]

ON_SITE_RADIUS_MI = 0.3   # ~480 m; within the "~300-500 m" range in §6
NEARBY_RADIUS_MI  = 8.0   # within the "~5-10 mi" range in §6
NEARBY_LIMIT      = 3

FISHING_VALUES = ("yes", "catch_and_release", "permissive")
_FISHING_VALUE_PATTERN = "|".join(FISHING_VALUES)


# --------------------------------------------------------------------------- #
# Geometry — ray-casting point-in-polygon over a Polygon / MultiPolygon.
# Self-contained (mirrors tools/build_dnr_data.py) so this script has no
# dependency on that one and can run standalone.
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


def bbox_str(bbox):
    min_lng, min_lat, max_lng, max_lat = bbox
    return f"{min_lat},{min_lng},{max_lat},{max_lng}"


def haversine_mi(lat1, lng1, lat2, lng2):
    R = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# --------------------------------------------------------------------------- #
# Overpass queries (build-time only; broadened tag set per MIGRATION_PLAN §5).
# --------------------------------------------------------------------------- #
def fishing_query(bbox):
    b = bbox_str(bbox)
    return f"""
[out:json][timeout:180];
(
  node["leisure"="fishing"]({b});
  way["leisure"="fishing"]({b});
  node["fishing"~"^({_FISHING_VALUE_PATTERN})$"]({b});
  way["fishing"~"^({_FISHING_VALUE_PATTERN})$"]({b});
  node["sport"="fishing"]({b});
  way["sport"="fishing"]({b});
  node["man_made"="fishing_peg"]({b});
  node["leisure"="slipway"]({b});
  way["leisure"="slipway"]({b});
  way["natural"="water"]["name"]({b});
  way["landuse"="reservoir"]["name"]({b});
);
out center tags;
""".strip()


def support_query(bbox):
    """Bulk pull of on-site amenities + nearby bait/food, per §6 — one query
    per state instead of a network call per spot."""
    b = bbox_str(bbox)
    return f"""
[out:json][timeout:180];
(
  node["amenity"="toilets"]({b});
  node["amenity"="drinking_water"]({b});
  node["leisure"="playground"]({b});
  node["amenity"="parking"]({b});
  way["amenity"="parking"]({b});
  node["amenity"="shelter"]({b});
  node["shop"="fishing"]({b});
  node["amenity"="cafe"]({b});
  node["amenity"="fast_food"]({b});
  node["amenity"="restaurant"]({b});
);
out center tags;
""".strip()


def fetch_overpass(query):
    last_err = None
    for attempt in range(MAX_RETRIES):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            data = urllib.parse.urlencode({"data": query}).encode()
            req = urllib.request.Request(endpoint, data=data,
                                         headers={"User-Agent": "LetsGoFishing-spots-builder/1.0"})
            with urllib.request.urlopen(req, timeout=200) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            last_err = e
            wait = 2 ** (attempt + 1)
            print(f"    Overpass attempt {attempt + 1} failed ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"Overpass failed after {MAX_RETRIES} attempts: {last_err}")


# --------------------------------------------------------------------------- #
# Pure tag-mapping logic (unit-tested offline — no network).
# --------------------------------------------------------------------------- #
def element_center(el):
    lat = el.get("lat") if "lat" in el else (el.get("center") or {}).get("lat")
    lng = el.get("lon") if "lon" in el else (el.get("center") or {}).get("lon")
    return lat, lng


def classify_fishing_element(tags):
    """Given an OSM element's tags, decide whether it's a kid-app-relevant
    fishing spot and how to classify it. Returns a dict of derived fields, or
    None if the element should be excluded. Pure function — no I/O."""
    fishing_val = tags.get("fishing")
    access_val = tags.get("access")

    # Hard excludes (never shown), per MIGRATION_PLAN §5. `access=private/no`
    # is the general-purpose OSM way to mark private land and applies even
    # when the more specific `fishing=*` tag is absent.
    if fishing_val in ("private", "no"):
        return None
    if access_val in ("private", "no"):
        return None
    if tags.get("landuse") == "aquaculture" or tags.get("industrial") == "aquaculture":
        return None

    is_slipway = tags.get("leisure") == "slipway"
    is_pier = (tags.get("man_made") in ("pier", "jetty") and
               (fishing_val in FISHING_VALUES or tags.get("sport") == "fishing"))
    narrow_signal = (
        tags.get("leisure") == "fishing"
        or fishing_val in FISHING_VALUES
        or tags.get("sport") == "fishing"
        or tags.get("man_made") == "fishing_peg"
        or is_pier
        or is_slipway
    )
    broad_water = (
        not narrow_signal
        and (tags.get("natural") == "water" or tags.get("landuse") == "reservoir")
    )
    if not narrow_signal and not broad_water:
        return None

    name = tags.get("name")
    if broad_water and not name:
        return None  # the broad natural=water/reservoir catch requires a name

    if fishing_val in ("yes", "permissive"):
        legal_status = "public"
    elif fishing_val == "catch_and_release":
        legal_status = "catch_and_release"
    else:
        legal_status = None  # unspecified — surfaced as "not listed", not assumed public

    accessibility = "Dock" if (is_slipway or is_pier) else "Clear Bank"

    species = []
    for key in ("fish", "species"):
        if tags.get(key):
            species = [s.strip() for s in tags[key].split(";") if s.strip()]
            break

    return {
        "name": name,
        "legalStatus": legal_status,
        "accessibility": accessibility,
        "hours": tags.get("opening_hours"),
        "fee": tags.get("fee") if tags.get("fee") in ("yes", "no") else None,
        "operator": tags.get("operator"),
        "website": tags.get("website") or tags.get("url"),
        "wheelchairAccessible": tags.get("wheelchair") == "yes",
        "targetSpecies": species,
    }


def fallback_name(accessibility):
    return "Boat Ramp / Fishing Access" if accessibility == "Dock" else "Fishing Access Point"


def element_to_spot(el, abbr):
    """Pure: turn one raw Overpass element into a spot record (sans amenity
    join / DNR merge, added later). Returns None if not a relevant spot."""
    if el.get("type") == "relation":
        # Our Overpass queries only ever request node/way (see fishing_query),
        # so this never actually fires today — kept as a defensive guard in
        # case a future query addition starts pulling relations too.
        return None
    lat, lng = element_center(el)
    if lat is None or lng is None:
        return None
    tags = el.get("tags", {})
    info = classify_fishing_element(tags)
    if info is None:
        return None

    return {
        "id": f"osm-{abbr.lower()}-{el.get('type', 'node')}-{el.get('id')}",
        "name": info["name"] or fallback_name(info["accessibility"]),
        "coordinates": {"lat": round(lat, 6), "lng": round(lng, 6)},
        "legalStatus": info["legalStatus"],
        "hours": info["hours"],
        "accessibility": info["accessibility"],
        "fee": info["fee"],
        "operator": info["operator"],
        "website": info["website"],
        "wheelchairAccessible": info["wheelchairAccessible"],
        "targetSpecies": info["targetSpecies"],
        "amenities": {
            "restrooms": False, "restroomsADA": False, "changingTable": False,
            "drinkingWater": False, "playground": False, "parking": False,
            "parkingFee": False, "shelter": False,
        },
        "nearbyBait": [],
        "nearbyFood": [],
        "region": None,
        "source": "osm",
        "dnr": None,  # every spot carries this key so a consumer never needs a hasattr/`in` check
    }


# --------------------------------------------------------------------------- #
# Amenity/service categorization + spatial join (pure — unit-tested offline).
# --------------------------------------------------------------------------- #
def amenity_category(tags):
    """Pure: classify a support element's tags. Returns (scope, category); for
    "on_site" items `category` doubles as the amenities-dict field name, so
    there's exactly one place mapping OSM tags to output fields (no separate
    predicate/field-name tables that can drift out of sync)."""
    if tags.get("amenity") == "toilets":
        return ("on_site", "restrooms")
    if tags.get("amenity") == "drinking_water":
        return ("on_site", "drinkingWater")
    if tags.get("leisure") == "playground":
        return ("on_site", "playground")
    if tags.get("amenity") == "parking":
        return ("on_site", "parking")
    if tags.get("amenity") == "shelter":
        return ("on_site", "shelter")
    if tags.get("shop") == "fishing":
        return ("nearby", "bait")
    if tags.get("amenity") in ("cafe", "fast_food", "restaurant"):
        return ("nearby", "food")
    return None
    # Note: §6 also lists amenity=picnic_table / bbq / bench as candidates for
    # the on-site join; deliberately not pulled/joined yet in Phase 1 (kept to
    # the fields the merged-record schema in MIGRATION_PLAN §9 actually uses).


def support_element_to_point(el):
    """Pure: turn one raw Overpass support element into a lightweight point
    record for the spatial join, or None if irrelevant."""
    if el.get("type") == "relation":
        return None
    lat, lng = element_center(el)
    if lat is None or lng is None:
        return None
    tags = el.get("tags", {})
    cat = amenity_category(tags)
    if cat is None:
        return None
    scope, category = cat
    return {
        "scope": scope,
        "category": category,
        "lat": lat,
        "lng": lng,
        "name": tags.get("name"),
        "changingTable": tags.get("changing_table") == "yes",
        "wheelchair": tags.get("toilets:wheelchair") == "yes" or tags.get("wheelchair") == "yes",
        "fee": tags.get("fee") == "yes",
    }


def bucket_support_points(support_points):
    """Pure: group a state's support points once by (scope, category) so a
    per-spot join scans only the relevant bucket instead of the whole list —
    join_amenities/nearest_services are called once per spot, so without this
    a state with many spots and many amenity nodes re-filters the same full
    list repeatedly."""
    buckets = {}
    for p in support_points:
        buckets.setdefault((p["scope"], p["category"]), []).append(p)
    return buckets


def join_amenities(spot_coords, buckets, radius_mi=ON_SITE_RADIUS_MI):
    """Pure: fold on-site support points within radius_mi into an amenities
    dict. Unknown stays False here — the UI layer (issue #37) is responsible
    for rendering False as 'not listed' rather than a confirmed absence."""
    result = {
        "restrooms": False, "restroomsADA": False, "changingTable": False,
        "drinkingWater": False, "playground": False, "parking": False,
        "parkingFee": False, "shelter": False,
    }
    for field in ("restrooms", "drinkingWater", "playground", "parking", "shelter"):
        for p in buckets.get(("on_site", field), []):
            d = haversine_mi(spot_coords["lat"], spot_coords["lng"], p["lat"], p["lng"])
            if d > radius_mi:
                continue
            result[field] = True
            if field == "restrooms" and p["wheelchair"]:
                result["restroomsADA"] = True
            if field == "restrooms" and p["changingTable"]:
                result["changingTable"] = True
            if field == "parking" and p["fee"]:
                result["parkingFee"] = True
    return result


def nearest_services(spot_coords, buckets, category,
                      radius_mi=NEARBY_RADIUS_MI, limit=NEARBY_LIMIT):
    """Pure: nearest `limit` nearby-scope points of `category` within
    radius_mi, sorted closest-first."""
    matches = []
    for p in buckets.get(("nearby", category), []):
        d = haversine_mi(spot_coords["lat"], spot_coords["lng"], p["lat"], p["lng"])
        if d <= radius_mi:
            matches.append((d, p))
    matches.sort(key=lambda m: m[0])
    default_name = "Bait & Tackle Shop" if category == "bait" else "Food"
    return [
        {"name": p.get("name") or default_name, "distanceMi": round(d, 1)}
        for d, p in matches[:limit]
    ]


# --------------------------------------------------------------------------- #
# DNR normalization + fuzzy merge (pure — unit-tested offline). The matching
# algorithm ports enrichment.js's runtime matcher (_nameSimilarity /
# matchDNRRecord) to Python so the same rule applies at build time here and
# at runtime for any state without a merged file yet.
# --------------------------------------------------------------------------- #
_DNR_STOP_WORDS = {"lake", "park", "area", "pfa", "wma", "public", "fishing",
                    "the", "at", "of", "state", "county", "creek", "pond"}


def _name_tokens(name):
    if not name:
        return []
    cleaned = re.sub(r"[^a-z0-9\s]", " ", name.lower())
    return [t for t in cleaned.split() if t and t not in _DNR_STOP_WORDS]


def name_similarity(a, b):
    ta, tb = set(_name_tokens(a)), set(_name_tokens(b))
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    union = len(ta | tb)
    return inter / union if union else 0.0


def _dnr_id_fallback(name, abbr):
    # Mirrors enrichment.js's normalizeDNRRecord fallback exactly
    # (`${stateAbbr}-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`) so a
    # record without an explicit dnrId gets the same id at build time and at
    # runtime, instead of two different slugs for "the same" record.
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "spot").lower()).strip("-")
    return f"{abbr}-{slug}"


def normalize_dnr_record(r, abbr):
    """Pure: give every DNR record a guaranteed full shape, mirroring
    enrichment.js's normalizeDNRRecord. Without this, OSM-generated (non-
    curated) data/dnr/{ABBR}.json files — which only set a handful of fields
    (see tools/build_dnr_data.py's element_to_record) — would embed a `dnr`
    sub-object with several keys simply missing rather than defaulted, and
    any downstream consumer relying on the normalized shape would read
    undefined. Returns None if the record has no usable coordinates."""
    if not r:
        return None
    coords = r.get("coordinates") or {}
    lat, lng = coords.get("lat"), coords.get("lng")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return None
    a = r.get("amenities") or {}
    fishing = r.get("fishing") or {}
    return {
        "dnrId": r.get("dnrId") or _dnr_id_fallback(r.get("name"), abbr),
        "name": r.get("name") or "DNR Public Access",
        "state": abbr,
        "waterbody": r.get("waterbody") or r.get("name") or "",
        "county": r.get("county") or "",
        "acres": r.get("acres"),
        "status": r.get("status") or "Public",
        "operator": r.get("operator") or "",
        "phone": r.get("phone") or "",
        "coordinates": {"lat": lat, "lng": lng},
        "accessibility": r.get("accessibility") or "Clear Bank",
        "rampType": r.get("rampType") or "",
        "numLanes": r.get("numLanes"),
        "amenities": {
            "restrooms": bool(a.get("restrooms")), "restroomsADA": bool(a.get("restroomsADA")),
            "parking": bool(a.get("parking")), "parkingADA": bool(a.get("parkingADA")),
            "dockADA": bool(a.get("dockADA")), "camping": bool(a.get("camping")),
            "baitShop": bool(a.get("baitShop")), "equipmentRental": bool(a.get("equipmentRental")),
            "loanPole": bool(a.get("loanPole")), "kidsProgram": bool(a.get("kidsProgram")),
            "picnicArea": bool(a.get("picnicArea")),
        },
        "confirmedSpecies": list(r.get("confirmedSpecies") or []),
        "fees": r.get("fees") or {"parking": "Check Locally", "fishing": "License May Be Required"},
        "fishing": {
            "motorRestrictions": fishing.get("motorRestrictions") or "None listed",
            "yearRound": fishing.get("yearRound") is not False,
            "bankFishing": fishing.get("bankFishing") is not False,
            "pier": bool(fishing.get("pier")),
        },
        "moreInfo": r.get("moreInfo") or "",
        "infoLink": r.get("infoLink") or "",
    }


def match_dnr_record(spot, dnr_records, max_km=3.0):
    """Pure: best DNR record for one spot (highest name similarity >= 0.5
    among candidates within max_km), or None."""
    best, best_sim = None, 0.0
    for d in dnr_records:
        dc = d["coordinates"]
        dist_km = haversine_mi(spot["coordinates"]["lat"], spot["coordinates"]["lng"],
                                dc["lat"], dc["lng"]) * 1.60934
        if dist_km > max_km:
            continue
        sim = name_similarity(spot["name"], d.get("name"))
        if sim >= 0.5 and sim > best_sim:
            best, best_sim = d, sim
    return best


def match_dnr_records_to_spots(spots, dnr_records, max_km=3.0):
    """Pure: assign each DNR record to at most one spot — greedily, in spot
    order — so the same official DNR listing never gets embedded into two
    different OSM elements representing the same lake (e.g. a boat-ramp node
    and a separately-tagged named water body both matching one PFA record).
    Returns (index -> dnr record) for matched spots, and the set of claimed
    dnrIds so callers can find the leftover (standalone) DNR records."""
    claimed_ids = set()
    matches = {}
    for i, s in enumerate(spots):
        available = [d for d in dnr_records if d["dnrId"] not in claimed_ids]
        d = match_dnr_record(s, available, max_km=max_km)
        if d:
            matches[i] = d
            claimed_ids.add(d["dnrId"])
    return matches, claimed_ids


def merge_dnr_into_spot(spot, d):
    merged = dict(spot)
    species = list(spot.get("targetSpecies") or [])
    for s in (d.get("confirmedSpecies") or []):
        if s not in species:
            species.append(s)
    merged["targetSpecies"] = species

    amenities = dict(spot.get("amenities") or {})
    da = d.get("amenities") or {}
    if da.get("restrooms"):
        amenities["restrooms"] = True
    if da.get("restroomsADA"):
        amenities["restroomsADA"] = True
    if da.get("parking"):
        amenities["parking"] = True
    merged["amenities"] = amenities

    merged["wheelchairAccessible"] = bool(
        spot.get("wheelchairAccessible") or da.get("dockADA") or da.get("parkingADA")
    )

    if not merged.get("legalStatus"):
        merged["legalStatus"] = "public"  # DNR-listed public access implies public

    merged["dnr"] = d
    return merged


_DNR_FEE_UNKNOWN_TEXTS = {"check locally", "unknown", "n/a", "varies", "tbd"}


def _fee_from_dnr_fees(fees):
    """Pure: best-effort yes/no/None from DNR's free-text parking fee, to
    keep the top-level `fee` field's semantics (does *this* spot charge to
    fish/park) consistent between OSM- and DNR-sourced spots, without
    over-claiming precision the free-text source doesn't have. Placeholder
    text like "Check Locally" (normalize_dnr_record's own default when a
    record doesn't specify) means unspecified, not "yes there's a fee"."""
    parking = ((fees or {}).get("parking") or "").strip().lower()
    if not parking or parking in _DNR_FEE_UNKNOWN_TEXTS:
        return None
    return "no" if parking == "free" else "yes"


def dnr_to_standalone_spot(d, abbr, state_name):
    da = d.get("amenities") or {}
    return {
        "id": d["dnrId"],
        "name": d["name"],
        "coordinates": d["coordinates"],
        "legalStatus": "public",
        "hours": None,
        "accessibility": d.get("accessibility") or "Clear Bank",
        "fee": _fee_from_dnr_fees(d.get("fees")),
        "operator": d.get("operator"),
        "website": d.get("infoLink"),
        "wheelchairAccessible": bool(da.get("dockADA") or da.get("parkingADA")),
        "targetSpecies": d.get("confirmedSpecies") or [],
        "amenities": {
            "restrooms": bool(da.get("restrooms")),
            "restroomsADA": bool(da.get("restroomsADA")),
            "changingTable": False,
            "drinkingWater": False,
            "playground": False,
            "parking": bool(da.get("parking")),
            "parkingFee": False,
            "shelter": False,
        },
        "nearbyBait": [],
        "nearbyFood": [],
        "region": f"{d['county']} County, {abbr}" if d.get("county") else state_name,
        "source": "dnr",
        "dnr": d,
    }


def dedupe_spots(spots):
    """Pure: drop spots that land on (basically) the same coordinates with
    the same name — e.g. an OSM node and way tagged on the same feature, or
    two Overpass query branches matching the same element."""
    seen = set()
    out = []
    for s in spots:
        c = s["coordinates"]
        key = (round(c["lat"], 3), round(c["lng"], 3), (s["name"] or "").strip().lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


# --------------------------------------------------------------------------- #
# Build orchestration (network — not unit-tested).
# --------------------------------------------------------------------------- #
def load_dnr_records(abbr):
    path = os.path.join(DNR_DIR, f"{abbr}.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            raw = json.load(f).get("records") or []
    except Exception:
        return []
    return [r for r in (normalize_dnr_record(rec, abbr) for rec in raw) if r]


def build_state(abbr, feature):
    geom = feature["geometry"]
    state_name = feature["properties"].get("name", abbr)
    bbox = bbox_of(geom)

    print(f"[{abbr}] {state_name}: querying Overpass for fishing spots…", flush=True)
    fishing_data = fetch_overpass(fishing_query(bbox))
    time.sleep(SLEEP_BETWEEN_QUERIES)

    print(f"[{abbr}] {state_name}: querying Overpass for amenities/services…", flush=True)
    try:
        support_data = fetch_overpass(support_query(bbox))
    except RuntimeError as e:
        print(f"[{abbr}] support query failed, continuing without amenity join: {e}", flush=True)
        support_data = {"elements": []}

    spots = []
    for el in fishing_data.get("elements", []):
        s = element_to_spot(el, abbr)
        if not s:
            continue
        c = s["coordinates"]
        if not point_in_geometry(c["lng"], c["lat"], geom):
            continue  # bbox query bleeds into neighbouring states
        city = (el.get("tags") or {}).get("addr:city")
        s["region"] = f"{city}, {abbr}" if city else state_name
        spots.append(s)

    support_points = [p for p in (support_element_to_point(el) for el in support_data.get("elements", [])) if p]
    buckets = bucket_support_points(support_points)

    for s in spots:
        s["amenities"] = join_amenities(s["coordinates"], buckets)
        s["nearbyBait"] = nearest_services(s["coordinates"], buckets, "bait")
        s["nearbyFood"] = nearest_services(s["coordinates"], buckets, "food")

    dnr_records = load_dnr_records(abbr)
    dnr_matches, matched_dnr_ids = match_dnr_records_to_spots(spots, dnr_records)

    merged = []
    for i, s in enumerate(spots):
        d = dnr_matches.get(i)
        merged.append(merge_dnr_into_spot(s, d) if d else s)
    for d in dnr_records:
        if d["dnrId"] not in matched_dnr_ids:
            standalone = dnr_to_standalone_spot(d, abbr, state_name)
            # DNR-only spots benefit from the same OSM amenity/bait/food
            # proximity join as OSM-sourced spots, not just their own
            # (usually sparser) curated amenity flags.
            standalone["amenities"] = join_amenities(standalone["coordinates"], buckets)
            standalone["nearbyBait"] = nearest_services(standalone["coordinates"], buckets, "bait")
            standalone["nearbyFood"] = nearest_services(standalone["coordinates"], buckets, "food")
            merged.append(standalone)

    merged = dedupe_spots(merged)
    print(f"[{abbr}] {len(merged)} merged spots ({len(spots)} OSM, {len(dnr_records)} DNR input records, "
          f"{len(matched_dnr_ids)} matched)", flush=True)
    return state_name, merged


def rebuild_manifest():
    states = sorted(
        fn[:-5] for fn in os.listdir(SPOTS_DIR)
        if fn.endswith(".json") and fn != "index.json"
    )
    with open(MANIFEST, "w") as f:
        json.dump({
            "description": "Manifest of US states with a pre-built merged spot data file "
                            "(data/spots/{ABBR}.json = OSM + DNR + amenity/bait proximity join, "
                            "merged at build time by tools/build_spots_data.py, see "
                            "docs/MIGRATION_PLAN.md). Not yet loaded at runtime (issue #36).",
            "schemaVersion": 1,
            "states": states,
        }, f, indent=2)


def main():
    wanted = [a.upper() for a in sys.argv[1:]] if len(sys.argv) > 1 else DEFAULT_STATES

    with open(BORDERS) as f:
        borders = json.load(f)
    features = {ft["properties"]["abbr"]: ft for ft in borders["features"]
                if ft.get("properties", {}).get("abbr")}

    os.makedirs(SPOTS_DIR, exist_ok=True)
    produced = []

    for i, abbr in enumerate(wanted):
        if abbr not in features:
            print(f"[{abbr}] no border geometry — skipping", flush=True)
            continue

        try:
            state_name, merged = build_state(abbr, features[abbr])
        except RuntimeError as e:
            print(f"[{abbr}] FAILED: {e}", flush=True)
        else:
            out = {
                "state": abbr,
                "stateName": state_name,
                "source": "OpenStreetMap via Overpass (community data) + state DNR curated/generated "
                          "data (data/dnr) — see docs/MIGRATION_PLAN.md",
                "generated": time.strftime("%Y-%m-%d"),
                "count": len(merged),
                "spots": merged,
            }
            with open(os.path.join(SPOTS_DIR, f"{abbr}.json"), "w") as f:
                json.dump(out, f, separators=(",", ":"))
            produced.append(abbr)

        # Sleep between states regardless of success/failure — a failure
        # (rate limit, transient outage) is exactly when hammering the next
        # state immediately would make things worse.
        if i < len(wanted) - 1:
            time.sleep(SLEEP_BETWEEN_STATES)

    rebuild_manifest()
    print(f"\nDone. Built {len(produced)} state file(s): {', '.join(produced) if produced else '(none)'}")


if __name__ == "__main__":
    main()
