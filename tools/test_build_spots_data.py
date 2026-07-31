#!/usr/bin/env python3
"""
test_build_spots_data.py — offline unit tests for the pure logic in
tools/build_spots_data.py (tag mapping, spatial join, DNR merge). No network
access required or used; safe to run anywhere, including CI without Overpass
reachability.

Usage:
    python3 tools/test_build_spots_data.py
    python3 -m unittest tools.test_build_spots_data   (run from repo root)
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_spots_data as b  # noqa: E402


class ClassifyFishingElementTests(unittest.TestCase):
    def test_leisure_fishing_named(self):
        info = b.classify_fishing_element({"leisure": "fishing", "name": "Town Pond"})
        self.assertIsNotNone(info)
        self.assertEqual(info["name"], "Town Pond")
        self.assertEqual(info["accessibility"], "Clear Bank")

    def test_leisure_fishing_unnamed_kept(self):
        # Narrow-signal tags don't require a name (fallback label applies later).
        info = b.classify_fishing_element({"leisure": "fishing"})
        self.assertIsNotNone(info)
        self.assertIsNone(info["name"])

    def test_fishing_yes_is_public(self):
        info = b.classify_fishing_element({"fishing": "yes"})
        self.assertEqual(info["legalStatus"], "public")

    def test_fishing_permissive_is_public(self):
        info = b.classify_fishing_element({"fishing": "permissive"})
        self.assertEqual(info["legalStatus"], "public")

    def test_fishing_catch_and_release(self):
        info = b.classify_fishing_element({"fishing": "catch_and_release", "leisure": "fishing"})
        self.assertEqual(info["legalStatus"], "catch_and_release")

    def test_fishing_private_hard_excluded(self):
        self.assertIsNone(b.classify_fishing_element({"fishing": "private", "leisure": "fishing"}))

    def test_fishing_no_hard_excluded(self):
        self.assertIsNone(b.classify_fishing_element({"fishing": "no", "leisure": "fishing"}))

    def test_access_private_hard_excluded_even_without_fishing_tag(self):
        # A pond marked private via the general-purpose access=* tag (no
        # fishing=private) must still be excluded — kids shouldn't be
        # steered onto land they'd need to trespass to reach.
        self.assertIsNone(b.classify_fishing_element({"leisure": "fishing", "access": "private"}))

    def test_access_no_hard_excluded(self):
        self.assertIsNone(b.classify_fishing_element({"leisure": "fishing", "access": "no"}))

    def test_aquaculture_excluded(self):
        self.assertIsNone(b.classify_fishing_element({"leisure": "fishing", "landuse": "aquaculture"}))
        self.assertIsNone(b.classify_fishing_element({"leisure": "fishing", "industrial": "aquaculture"}))

    def test_slipway_is_dock_no_name_required(self):
        info = b.classify_fishing_element({"leisure": "slipway"})
        self.assertIsNotNone(info)
        self.assertEqual(info["accessibility"], "Dock")

    def test_pier_with_fishing_signal_is_dock(self):
        info = b.classify_fishing_element({"man_made": "pier", "fishing": "yes"})
        self.assertIsNotNone(info)
        self.assertEqual(info["accessibility"], "Dock")

    def test_pier_without_fishing_signal_excluded(self):
        # A plain pier (no fishing/sport signal) isn't a fishing spot on its own.
        self.assertIsNone(b.classify_fishing_element({"man_made": "pier"}))

    def test_broad_named_water_kept(self):
        info = b.classify_fishing_element({"natural": "water", "name": "Clearwater Lake"})
        self.assertIsNotNone(info)
        self.assertEqual(info["accessibility"], "Clear Bank")
        self.assertIsNone(info["legalStatus"])  # no fishing=* tag -> unspecified, not assumed public

    def test_broad_unnamed_water_excluded(self):
        self.assertIsNone(b.classify_fishing_element({"natural": "water"}))

    def test_named_reservoir_kept(self):
        info = b.classify_fishing_element({"landuse": "reservoir", "name": "Big Reservoir", "fishing": "yes"})
        self.assertIsNotNone(info)
        self.assertEqual(info["accessibility"], "Clear Bank")
        self.assertEqual(info["legalStatus"], "public")

    def test_irrelevant_tags_excluded(self):
        self.assertIsNone(b.classify_fishing_element({"shop": "bakery", "name": "Donuts"}))

    def test_species_parsed(self):
        info = b.classify_fishing_element({"leisure": "fishing", "fish": "Bass; Bluegill ;Crappie"})
        self.assertEqual(info["targetSpecies"], ["Bass", "Bluegill", "Crappie"])

    def test_unspecified_legal_status_not_assumed_public(self):
        # leisure=fishing with no fishing=* tag at all — status should be
        # unknown, not silently assumed public (issue #34's spirit).
        info = b.classify_fishing_element({"leisure": "fishing", "name": "Mystery Pond"})
        self.assertIsNone(info["legalStatus"])


class ElementToSpotTests(unittest.TestCase):
    def test_relation_excluded(self):
        el = {"type": "relation", "id": 1, "lat": 33.5, "lon": -84.4, "tags": {"leisure": "fishing"}}
        self.assertIsNone(b.element_to_spot(el, "GA"))

    def test_node_becomes_spot(self):
        el = {"type": "node", "id": 42, "lat": 33.5, "lon": -84.4,
              "tags": {"leisure": "fishing", "name": "Test Pond"}}
        spot = b.element_to_spot(el, "GA")
        self.assertIsNotNone(spot)
        self.assertEqual(spot["id"], "osm-ga-node-42")
        self.assertEqual(spot["coordinates"], {"lat": 33.5, "lng": -84.4})
        self.assertEqual(spot["source"], "osm")
        self.assertIsNone(spot["dnr"])  # uniform key present even when there's no DNR data

    def test_way_uses_center(self):
        el = {"type": "way", "id": 7, "center": {"lat": 34.0, "lon": -83.9},
              "tags": {"leisure": "slipway"}}
        spot = b.element_to_spot(el, "GA")
        self.assertIsNotNone(spot)
        self.assertEqual(spot["coordinates"], {"lat": 34.0, "lng": -83.9})
        self.assertEqual(spot["name"], "Boat Ramp / Fishing Access")

    def test_missing_coordinates_excluded(self):
        el = {"type": "node", "id": 1, "tags": {"leisure": "fishing"}}
        self.assertIsNone(b.element_to_spot(el, "GA"))


class AmenityCategoryTests(unittest.TestCase):
    def test_toilets_on_site(self):
        self.assertEqual(b.amenity_category({"amenity": "toilets"}), ("on_site", "restrooms"))

    def test_bait_shop_nearby(self):
        self.assertEqual(b.amenity_category({"shop": "fishing"}), ("nearby", "bait"))

    def test_food_nearby(self):
        for v in ("cafe", "fast_food", "restaurant"):
            self.assertEqual(b.amenity_category({"amenity": v}), ("nearby", "food"))

    def test_irrelevant_returns_none(self):
        self.assertIsNone(b.amenity_category({"amenity": "bank"}))


def _support_point(scope, category, lat, lng, **overrides):
    p = {"scope": scope, "category": category, "lat": lat, "lng": lng,
         "name": None, "changingTable": False, "wheelchair": False, "fee": False}
    p.update(overrides)
    return p


class SpatialJoinTests(unittest.TestCase):
    SPOT = {"lat": 33.7490, "lng": -84.3880}

    def test_restrooms_within_radius_flagged(self):
        buckets = b.bucket_support_points([_support_point("on_site", "restrooms", 33.7495, -84.3885)])
        result = b.join_amenities(self.SPOT, buckets)
        self.assertTrue(result["restrooms"])

    def test_restrooms_outside_radius_not_flagged(self):
        buckets = b.bucket_support_points([_support_point("on_site", "restrooms", 34.5, -85.5)])
        result = b.join_amenities(self.SPOT, buckets)
        self.assertFalse(result["restrooms"])

    def test_changing_table_flows_through_restrooms(self):
        buckets = b.bucket_support_points(
            [_support_point("on_site", "restrooms", 33.7491, -84.3881, changingTable=True)])
        result = b.join_amenities(self.SPOT, buckets)
        self.assertTrue(result["restrooms"])
        self.assertTrue(result["changingTable"])

    def test_ada_flows_through_restrooms(self):
        buckets = b.bucket_support_points(
            [_support_point("on_site", "restrooms", 33.7491, -84.3881, wheelchair=True)])
        result = b.join_amenities(self.SPOT, buckets)
        self.assertTrue(result["restroomsADA"])

    def test_parking_fee_flows_through_parking(self):
        buckets = b.bucket_support_points(
            [_support_point("on_site", "parking", 33.7491, -84.3881, fee=True)])
        result = b.join_amenities(self.SPOT, buckets)
        self.assertTrue(result["parking"])
        self.assertTrue(result["parkingFee"])

    def test_no_uniform_false_positive(self):
        # A spot with zero nearby amenity nodes must get all-False, not a
        # copy-pasted "everything present" default (today's bug being fixed).
        result = b.join_amenities(self.SPOT, b.bucket_support_points([]))
        self.assertFalse(any(result.values()))

    def test_nearest_bait_sorted_and_limited(self):
        points = [
            _support_point("nearby", "bait", 33.80, -84.40, name="Far Bait"),
            _support_point("nearby", "bait", 33.75, -84.389, name="Close Bait"),
            _support_point("nearby", "food", 33.75, -84.389, name="Diner"),
        ]
        result = b.nearest_services(self.SPOT, b.bucket_support_points(points), "bait")
        self.assertEqual(result[0]["name"], "Close Bait")
        self.assertTrue(all(r["name"] != "Diner" for r in result))

    def test_nearest_services_respects_radius(self):
        points = [_support_point("nearby", "bait", 40.0, -90.0, name="Too Far")]
        result = b.nearest_services(self.SPOT, b.bucket_support_points(points), "bait")
        self.assertEqual(result, [])

    def test_bucket_support_points_groups_by_scope_and_category(self):
        points = [
            _support_point("on_site", "restrooms", 1, 2),
            _support_point("on_site", "restrooms", 3, 4),
            _support_point("nearby", "bait", 5, 6),
        ]
        buckets = b.bucket_support_points(points)
        self.assertEqual(len(buckets[("on_site", "restrooms")]), 2)
        self.assertEqual(len(buckets[("nearby", "bait")]), 1)


class NormalizeDnrRecordTests(unittest.TestCase):
    def test_missing_coordinates_rejected(self):
        self.assertIsNone(b.normalize_dnr_record({"name": "X"}, "GA"))

    def test_fills_defaults_for_sparse_osm_generated_record(self):
        # tools/build_dnr_data.py's element_to_record only sets a handful of
        # fields (no camping/baitShop/etc.) — normalize must still produce
        # the full guaranteed shape enrichment.js's runtime consumer expects.
        sparse = {
            "dnrId": "osm-ga-node-1",
            "name": "Some Ramp",
            "coordinates": {"lat": 33.5, "lng": -84.5},
            "accessibility": "Dock",
        }
        norm = b.normalize_dnr_record(sparse, "GA")
        self.assertIsNotNone(norm)
        self.assertFalse(norm["amenities"]["camping"])
        self.assertFalse(norm["amenities"]["baitShop"])
        self.assertEqual(norm["fees"]["parking"], "Check Locally")
        self.assertTrue(norm["fishing"]["yearRound"])

    def test_dnr_id_fallback_matches_enrichment_js_slug_format(self):
        # enrichment.js: `${stateAbbr}-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`
        record = {"name": "Joe's Pond (North)", "coordinates": {"lat": 1, "lng": 2}}
        norm = b.normalize_dnr_record(record, "GA")
        self.assertEqual(norm["dnrId"], "GA-joe-s-pond-north")

    def test_explicit_dnr_id_preserved(self):
        record = {"dnrId": "ga-marben-pfa", "name": "Marben", "coordinates": {"lat": 1, "lng": 2}}
        norm = b.normalize_dnr_record(record, "GA")
        self.assertEqual(norm["dnrId"], "ga-marben-pfa")


class DnrMergeTests(unittest.TestCase):
    def test_name_similarity_matches_variant_spelling(self):
        sim = b.name_similarity("Lake Allatoona", "Allatoona Lake")
        self.assertGreater(sim, 0.5)

    def test_name_similarity_unrelated_low(self):
        sim = b.name_similarity("Lake Allatoona", "Marben Public Fishing Area")
        self.assertLess(sim, 0.5)

    def test_match_dnr_record_within_radius_and_similar_name(self):
        spot = {"name": "Marben Lake", "coordinates": {"lat": 33.4715, "lng": -83.7185}}
        dnr = [{"dnrId": "ga-marben-pfa", "name": "Marben Public Fishing Area",
                "coordinates": {"lat": 33.4716, "lng": -83.7186}, "confirmedSpecies": ["Bluegill"],
                "amenities": {"restrooms": True}}]
        match = b.match_dnr_record(spot, dnr)
        self.assertIsNotNone(match)
        self.assertEqual(match["dnrId"], "ga-marben-pfa")

    def test_match_dnr_record_too_far_rejected(self):
        spot = {"name": "Marben Lake", "coordinates": {"lat": 33.4715, "lng": -83.7185}}
        dnr = [{"dnrId": "ga-marben-pfa", "name": "Marben Public Fishing Area",
                "coordinates": {"lat": 34.9, "lng": -83.0}}]
        self.assertIsNone(b.match_dnr_record(spot, dnr))

    def test_match_dnr_records_to_spots_does_not_double_assign(self):
        # Two different OSM elements near the same PFA (e.g. a slipway node
        # and a separately-tagged named water body) must not both claim the
        # same DNR record.
        spots = [
            {"name": "Marben Lake Ramp", "coordinates": {"lat": 33.4715, "lng": -83.7185}},
            {"name": "Marben Lake", "coordinates": {"lat": 33.4717, "lng": -83.7187}},
        ]
        dnr = [{"dnrId": "ga-marben-pfa", "name": "Marben Public Fishing Area",
                "coordinates": {"lat": 33.4716, "lng": -83.7186}}]
        matches, claimed = b.match_dnr_records_to_spots(spots, dnr)
        self.assertEqual(len(matches), 1)
        self.assertEqual(claimed, {"ga-marben-pfa"})

    def test_merge_dnr_into_spot_unions_species_and_amenities(self):
        spot = {"name": "Marben Lake", "coordinates": {"lat": 33.4715, "lng": -83.7185},
                "targetSpecies": ["Bass"], "amenities": {"restrooms": False, "parking": False},
                "legalStatus": None, "wheelchairAccessible": False}
        d = {"dnrId": "ga-marben-pfa", "confirmedSpecies": ["Bass", "Bluegill"],
             "amenities": {"restrooms": True, "parking": True, "dockADA": True}}
        merged = b.merge_dnr_into_spot(spot, d)
        self.assertEqual(sorted(merged["targetSpecies"]), ["Bass", "Bluegill"])
        self.assertTrue(merged["amenities"]["restrooms"])
        self.assertTrue(merged["amenities"]["parking"])
        self.assertTrue(merged["wheelchairAccessible"])
        self.assertEqual(merged["dnr"], d)
        self.assertEqual(merged["legalStatus"], "public")

    def test_merge_preserves_explicit_legal_status(self):
        spot = {"name": "X", "coordinates": {"lat": 0, "lng": 0}, "targetSpecies": [],
                "amenities": {}, "legalStatus": "catch_and_release", "wheelchairAccessible": False}
        merged = b.merge_dnr_into_spot(spot, {"dnrId": "x", "amenities": {}})
        self.assertEqual(merged["legalStatus"], "catch_and_release")

    def test_dnr_to_standalone_spot_shape(self):
        d = b.normalize_dnr_record({
            "dnrId": "ga-x", "name": "X PFA", "coordinates": {"lat": 1, "lng": 2},
            "accessibility": "Dock", "confirmedSpecies": ["Crappie"], "county": "Jasper",
            "amenities": {"restrooms": True, "parking": True, "dockADA": True},
            "fees": {"parking": "Free", "fishing": "GA License Required"},
            "operator": "Georgia DNR", "infoLink": "https://example.com",
        }, "GA")
        spot = b.dnr_to_standalone_spot(d, "GA", "Georgia")
        self.assertEqual(spot["id"], "ga-x")
        self.assertEqual(spot["source"], "dnr")
        self.assertEqual(spot["legalStatus"], "public")
        self.assertIsNone(spot["hours"])
        self.assertEqual(spot["fee"], "no")  # DNR parking fee "Free" -> no fee
        self.assertEqual(spot["operator"], "Georgia DNR")
        self.assertEqual(spot["website"], "https://example.com")
        self.assertTrue(spot["wheelchairAccessible"])
        self.assertTrue(spot["amenities"]["restrooms"])
        self.assertTrue(spot["amenities"]["parking"])
        self.assertEqual(spot["targetSpecies"], ["Crappie"])
        self.assertEqual(spot["nearbyBait"], [])
        self.assertEqual(spot["region"], "Jasper County, GA")

    def test_dnr_to_standalone_spot_fee_when_not_free(self):
        d = b.normalize_dnr_record(
            {"name": "Y", "coordinates": {"lat": 1, "lng": 2}, "fees": {"parking": "$5/day"}}, "GA")
        spot = b.dnr_to_standalone_spot(d, "GA", "Georgia")
        self.assertEqual(spot["fee"], "yes")

    def test_dnr_to_standalone_spot_fee_unknown_when_unspecified(self):
        d = b.normalize_dnr_record({"name": "Z", "coordinates": {"lat": 1, "lng": 2}}, "GA")
        spot = b.dnr_to_standalone_spot(d, "GA", "Georgia")
        self.assertIsNone(spot["fee"])


class StatusNoticeTests(unittest.TestCase):
    def test_applies_matching_notice(self):
        spot = {"id": "ga-lake-allatoona", "statusNotice": None}
        notices = {"ga-lake-allatoona": {"message": "Ramp closed", "severity": "closure"}}
        merged = b.apply_status_notice(spot, notices)
        self.assertEqual(merged["statusNotice"], {"message": "Ramp closed", "severity": "closure"})

    def test_no_match_leaves_spot_unchanged(self):
        spot = {"id": "osm-ga-node-1", "statusNotice": None}
        merged = b.apply_status_notice(spot, {"ga-lake-allatoona": {"message": "x", "severity": "closure"}})
        self.assertIsNone(merged["statusNotice"])
        self.assertEqual(merged, spot)

    def test_empty_notices_dict_is_noop(self):
        spot = {"id": "osm-ga-node-1", "statusNotice": None}
        merged = b.apply_status_notice(spot, {})
        self.assertIsNone(merged["statusNotice"])


class DedupeTests(unittest.TestCase):
    def test_exact_duplicate_removed(self):
        spots = [
            {"name": "Town Pond", "coordinates": {"lat": 33.5, "lng": -84.4}},
            {"name": "Town Pond", "coordinates": {"lat": 33.5, "lng": -84.4}},
        ]
        self.assertEqual(len(b.dedupe_spots(spots)), 1)

    def test_distinct_spots_kept(self):
        spots = [
            {"name": "Town Pond", "coordinates": {"lat": 33.5, "lng": -84.4}},
            {"name": "Other Pond", "coordinates": {"lat": 33.6, "lng": -84.5}},
        ]
        self.assertEqual(len(b.dedupe_spots(spots)), 2)


class GeometryTests(unittest.TestCase):
    SQUARE = {"type": "Polygon", "coordinates": [[[-85, 33], [-85, 34], [-84, 34], [-84, 33], [-85, 33]]]}

    def test_point_inside_polygon(self):
        self.assertTrue(b.point_in_geometry(-84.5, 33.5, self.SQUARE))

    def test_point_outside_polygon(self):
        self.assertFalse(b.point_in_geometry(-80.0, 33.5, self.SQUARE))

    def test_bbox_of_polygon(self):
        self.assertEqual(b.bbox_of(self.SQUARE), (-85, 33, -84, 34))

    def test_haversine_zero_distance(self):
        self.assertAlmostEqual(b.haversine_mi(33.5, -84.5, 33.5, -84.5), 0.0)

    def test_haversine_known_distance(self):
        # Atlanta to Athens, GA is roughly 55-80 miles as the crow flies.
        d = b.haversine_mi(33.7490, -84.3880, 33.9519, -83.3576)
        self.assertGreater(d, 55)
        self.assertLess(d, 80)


if __name__ == "__main__":
    unittest.main(verbosity=2)
