from app.services.zip_distance import miles_between, minutes_at_drive_speed, zip5


def test_zip5_keeps_the_first_five_digits():
    assert zip5("30349-1234") == "30349"
    assert zip5("3034") is None


def test_an_hour_at_65_mph_is_about_65_miles():
    assert minutes_at_drive_speed(65) == 60
    assert minutes_at_drive_speed(0.2) == 1


def test_atlanta_to_duluth_is_a_short_drive():
    # Downtown Atlanta to Duluth is roughly 25 miles as the crow flies.
    miles = miles_between(33.749, -84.388, 34.002, -84.144)
    assert 15 < miles < 35
    assert 15 <= minutes_at_drive_speed(miles) <= 40
