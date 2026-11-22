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


def test_secrets_are_refused():
    with pytest.raises(QueryRejected):
        validate_select("SELECT password_hash FROM users")
    with pytest.raises(QueryRejected):
        validate_select("SELECT * FROM dealership_twilio_configs")
