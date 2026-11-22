"""Rules for the BDC Call next list. No database."""
from datetime import datetime, timedelta, timezone

import pytz

from app.services.bdc_work_queue_service import (
    BAND_COOLDOWN,
    BAND_DNC,
    BAND_DUE_TODAY,
    BAND_FRESH,
    BAND_MISSED,
    BAND_OVERDUE,
    BOOST,
    QueueSignals,
    next_touch_at,
    score_work_item,
)

NOW = datetime(2026, 11, 21, 18, 0, tzinfo=timezone.utc)
TZ = pytz.timezone("America/New_York")


def _signals(**kwargs) -> QueueSignals:
    created = kwargs.pop("created_at", NOW - timedelta(days=2))
    return QueueSignals(created_at=created, **kwargs)


def _score(**kwargs):
    return score_work_item(_signals(**kwargs), NOW)


class TestWorkQueueOrder:
    def test_overdue_beats_fresh(self):
        overdue = _score(
            first_contacted_at=NOW - timedelta(days=3),
            last_contacted_at=NOW - timedelta(days=3),
            overdue_at=NOW - timedelta(hours=5),
        )
        fresh = _score(created_at=NOW - timedelta(hours=1))
        assert overdue["priority_band"] == BAND_OVERDUE
        assert fresh["priority_band"] == BAND_FRESH
        assert overdue["priority_score"] > fresh["priority_score"]

    def test_recent_no_answer_sinks_below_overdue(self):
        sunk = _score(
            first_contacted_at=NOW - timedelta(minutes=30),
            last_contacted_at=NOW - timedelta(minutes=30),
            last_unsuccessful_at=NOW - timedelta(minutes=30),
            overdue_at=NOW - timedelta(hours=4),
        )
        overdue = _score(
            first_contacted_at=NOW - timedelta(days=1),
            last_contacted_at=NOW - timedelta(days=1),
            overdue_at=NOW - timedelta(hours=4),
        )
        assert sunk["priority_band"] == BAND_COOLDOWN
        assert sunk["priority_score"] < overdue["priority_score"]
        assert sunk["reason"] == "Called recently — wait before redial"

    def test_do_not_call_note_sinks_an_overdue_lead(self):
        sunk = _score(
            first_contacted_at=NOW - timedelta(days=2),
            last_contacted_at=NOW - timedelta(days=2),
            overdue_at=NOW - timedelta(hours=6),
            latest_note="Wrong number — DNC",
        )
        fresh = _score(created_at=NOW - timedelta(minutes=10))
        assert sunk["priority_band"] == BAND_DNC
        assert sunk["priority_score"] < fresh["priority_score"]
        assert "Do not call" in sunk["chips"]

    def test_missed_inbound_beats_follow_up_due_today(self):
        missed = _score(
            first_contacted_at=NOW - timedelta(days=1),
            last_contacted_at=NOW - timedelta(days=1),
            unanswered_inbound_at=NOW - timedelta(hours=1),
            due_today_at=NOW + timedelta(hours=2),
        )
        due = _score(
            first_contacted_at=NOW - timedelta(days=1),
            last_contacted_at=NOW - timedelta(days=1),
            due_today_at=NOW + timedelta(hours=2),
        )
        assert missed["priority_band"] == BAND_MISSED
        assert due["priority_band"] == BAND_DUE_TODAY
        assert missed["priority_score"] > due["priority_score"]
        assert missed["reason"] == "Missed call — not returned"

    def test_hot_note_boosts_without_jumping_a_higher_band(self):
        plain = _score(
            first_contacted_at=NOW - timedelta(days=1),
            last_contacted_at=NOW - timedelta(days=1),
            overdue_at=NOW - timedelta(hours=2),
        )
        hot = _score(
            first_contacted_at=NOW - timedelta(days=1),
            last_contacted_at=NOW - timedelta(days=1),
            overdue_at=NOW - timedelta(hours=2),
            latest_note="Hot lead, call back ASAP. He is ready.",
        )
        fresh = _score(
            created_at=NOW - timedelta(minutes=5),
            latest_note="Customer is hot and coming in",
        )
        assert hot["priority_band"] == plain["priority_band"] == BAND_OVERDUE
        assert hot["priority_score"] == plain["priority_score"] + BOOST
        assert hot["priority_score"] > fresh["priority_score"]
        assert hot["note_preview"].startswith("Hot lead")

    def test_latest_note_overrides_an_old_do_not_call_summary(self):
        scored = _score(
            created_at=NOW - timedelta(hours=3),
            summary_notes="Not interested",
            latest_note="Call back today, she is ready",
        )
        assert scored["priority_band"] == BAND_FRESH
        assert scored["priority_score"] == 400 + BOOST
        assert "Do not call" not in scored["chips"]

    def test_spanish_and_text_only_are_chips_not_a_new_rank(self):
        plain = _score(created_at=NOW - timedelta(hours=2))
        noted = _score(
            created_at=NOW - timedelta(hours=2),
            latest_note="Spanish speaker. Text only.",
        )
        assert noted["priority_band"] == plain["priority_band"] == BAND_FRESH
        assert noted["priority_score"] == plain["priority_score"]
        assert noted["chips"] == ["Spanish", "Text only"]

    def test_callback_after_a_miss_is_not_still_missed(self):
        scored = _score(
            first_contacted_at=NOW - timedelta(minutes=20),
            last_contacted_at=NOW - timedelta(minutes=20),
            unanswered_inbound_at=NOW - timedelta(hours=2),
            last_activity_at=NOW - timedelta(minutes=20),
        )
        assert scored["priority_band"] != BAND_MISSED


class TestNextTouch:
    def test_retry_before_evening_is_two_hours(self):
        local = TZ.localize(datetime(2026, 11, 21, 15, 0))
        now = local.astimezone(pytz.UTC)
        assert next_touch_at(now, "America/New_York", "retry") == now + timedelta(hours=2)

    def test_retry_after_six_is_next_morning(self):
        local = TZ.localize(datetime(2026, 11, 21, 18, 30))
        now = local.astimezone(pytz.UTC)
        nxt = next_touch_at(now, "America/New_York", "retry").astimezone(TZ)
        assert (nxt.year, nxt.month, nxt.day, nxt.hour, nxt.minute) == (2026, 11, 22, 9, 0)

    def test_spoke_is_always_next_morning(self):
        local = TZ.localize(datetime(2026, 11, 21, 10, 0))
        now = local.astimezone(pytz.UTC)
        nxt = next_touch_at(now, "America/New_York", "tomorrow").astimezone(TZ)
        assert (nxt.year, nxt.month, nxt.day, nxt.hour, nxt.minute) == (2026, 11, 22, 9, 0)
