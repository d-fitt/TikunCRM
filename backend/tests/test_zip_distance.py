from app.services.zip_distance import (
    fallback_drive,
    miles_between,
    parse_osrm_route,
    round_drive_minutes,
    store_location_query,
    zip5,
)


def test_zip5_keeps_the_first_five_digits():
    assert zip5("30349-1234") == "30349"
    assert zip5("3034") is None


def test_road_minutes_round_to_the_nearest_minute():
    assert round_drive_minutes(12.3) == 12
    assert round_drive_minutes(0.2) == 1


def test_osrm_route_converts_meters_and_seconds():
    parsed = parse_osrm_route({"routes": [{"distance": 1609.344, "duration": 720}]})
    assert parsed is not None
    miles, minutes = parsed
    assert round(miles, 2) == 1
    assert minutes == 12
    assert parse_osrm_route({"routes": []}) is None


def test_store_query_uses_the_street_or_the_zip():
    assert (
        store_location_query("3230 Satellite Blvd NW", "Duluth", "GA", "30096")
        == "3230 Satellite Blvd NW, Duluth, GA, 30096"
    )
    assert (
        store_location_query("1575 Mansell Rd, Alpharetta, GA 30009", "Atlanta", "GA", "30009")
        == "1575 Mansell Rd, Alpharetta, GA 30009"
    )
    assert store_location_query(None, "Atlanta", "GA", None) is None
    assert store_location_query(None, None, None, None) is None


def test_fallback_is_slower_than_a_highway_straight_line():
    # 4 straight miles used to display as 4 minutes at 65 mph.
    miles, minutes = fallback_drive(4)
    assert miles >= 4
    assert minutes >= 8


def test_atlanta_to_duluth_is_a_short_straight_line():
    miles = miles_between(33.749, -84.388, 34.002, -84.144)
    assert 15 < miles < 35
