import pytest

from app.services.ai_db_query import QueryRejected, validate_select


def test_a_select_is_allowed():
    sql = validate_select("SELECT count(*) FROM leads WHERE outcome = 'converted'")
    assert sql.lower().startswith("select")


def test_a_write_is_refused():
    with pytest.raises(QueryRejected):
        validate_select("DELETE FROM leads")
    with pytest.raises(QueryRejected):
        validate_select("SELECT 1; DROP TABLE leads")


def test_last_saturday_is_computed_from_today():
    from datetime import datetime, timezone

    from app.services.ai_db_query import business_clock

    # Monday 23 Nov 2026, 16:30 UTC is still Monday morning in New York.
    now = datetime(2026, 11, 23, 16, 30, tzinfo=timezone.utc)
    clock = business_clock("America/New_York", now)
    assert "2026-11-23" in clock
    assert "Last Saturday was 2026-11-21." in clock
    assert "2023" not in clock
    assert "AT TIME ZONE 'America/New_York'" in clock


def test_secrets_are_refused():
    with pytest.raises(QueryRejected):
        validate_select("SELECT password_hash FROM users")
    with pytest.raises(QueryRejected):
        validate_select("SELECT * FROM dealership_twilio_configs")
