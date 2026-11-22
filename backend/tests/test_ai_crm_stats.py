from app.services.ai_crm_stats import (
    clean_filters,
    describe_filters,
    looks_like_crm_stat,
    percentage_answer,
)
from app.services.crm_content_search_service import should_auto_retrieve_crm_content


def test_a_percentage_question_is_a_database_stat():
    question = (
        "Can you tell me what percentage of the customers that have had a stip "
        "uploaded have been converted"
    )
    assert looks_like_crm_stat(question) is True
    assert should_auto_retrieve_crm_content(question) is False


def test_a_note_question_still_searches_notes():
    assert looks_like_crm_stat("What did they say about a trade-in?") is False
    assert should_auto_retrieve_crm_content("What did they say about a trade-in?") is True


def test_sold_means_converted_and_stip_stays_boolean():
    filters = clean_filters({"has_stip": "true", "outcome": "sold", "pool": "all"})
    assert filters == {"has_stip": True, "outcome": "converted", "pool": "all"}


def test_percentage_uses_the_database_counts():
    result = percentage_answer(
        12,
        40,
        {"has_stip": True, "outcome": "converted"},
        {"has_stip": True},
    )
    assert result["percentage"] == 30.0
    assert result["answer"] == "12 of 40 leads with a stip uploaded are converted (30.0%)."
    assert "a stip uploaded" in describe_filters({"has_stip": True})


def test_zero_comparison_group_has_no_percentage():
    result = percentage_answer(0, 0, {"has_stip": True}, {"has_stip": True})
    assert result["percentage"] is None
    assert "no percentage" in result["answer"]
