"""
Tests for AI call reviews: rubric validation, transcript parsing, evidence
grounding, scoring, the evaluation retry loop, eligibility, and the processing
pipeline end to end (with transcription and the LLM faked).

No network, no API keys and no PostgreSQL needed:
    pytest tests/test_call_reviews.py -v
"""
import json
import uuid
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from app.api import deps
from app.api.v1.endpoints import call_reviews as call_reviews_api
from app.core.config import settings
from app.core.permissions import UserRole
from app.core.timezone import utc_now
from app.db.database import get_db
from app.models.ai_outbound_call import AiOutboundCall
from app.models.appointment import Appointment
from app.models.call_log import CallDirection, CallLog, CallStatus
from app.models.call_review import CallEvaluation, CallReview, CallRubric
from app.models.customer import Customer
from app.models.dealership import Dealership
from app.models.lead import Lead
from app.models.user import User
from app.services import call_evaluation_service as evaluation
from app.services import call_review_service as reviews
from app.services import call_transcription_service as transcription


# --------------------------------------------------------------- fixtures ----

CRITERIA = [
    {"key": "opening", "name": "Opening", "weight": 20, "what_good_looks_like": "Introduces self", "what_bad_looks_like": ""},
    {"key": "objections", "name": "Objection handling", "weight": 30, "what_good_looks_like": "", "what_bad_looks_like": ""},
    {"key": "appointment", "name": "Appointment attempt", "weight": 50, "what_good_looks_like": "Offers two times", "what_bad_looks_like": ""},
]

TRANSCRIPT = [
    {"speaker": "rep", "start": 0.5, "end": 4.0, "text": "Hi, this is Maria from Premium Motors. Am I speaking with Daniel?"},
    {"speaker": "customer", "start": 4.2, "end": 7.0, "text": "Yes, this is Daniel."},
    {"speaker": "rep", "start": 7.5, "end": 14.0, "text": "Great! You asked about the 2022 Accord. What matters most to you in your next car?"},
    {"speaker": "customer", "start": 14.5, "end": 20.0, "text": "Honestly the monthly payment. I don't want to go over four hundred."},
    {"speaker": "rep", "start": 20.5, "end": 29.0, "text": "That makes sense. We have a few options in that range. Could you come in Thursday at five or Saturday at eleven?"},
    {"speaker": "customer", "start": 29.5, "end": 33.0, "text": "Saturday at eleven works."},
    {"speaker": "rep", "start": 33.5, "end": 38.0, "text": "Perfect, I'll text you the address and see you Saturday at eleven."},
]


def llm_output(**overrides):
    """A well-formed model response for TRANSCRIPT + CRITERIA."""
    data = {
        "summary": "Rep introduced herself, asked about priorities and booked a Saturday visit.",
        "category_scores": [
            {"key": "opening", "score": 90, "rationale": "Clear intro.",
             "evidence": [{"quote": "this is Maria from Premium Motors", "timestamp_seconds": 999}]},
            {"key": "objections", "not_applicable": True, "score": None, "rationale": "No objections raised.", "evidence": []},
            {"key": "appointment", "score": 80, "rationale": "Offered two times.",
             "evidence": [{"quote": "Could you come in Thursday at five or Saturday at eleven?", "timestamp_seconds": 20.5}]},
        ],
        "strengths": [
            {"text": "Offered two specific times.", "evidence": [{"quote": "Thursday at five or Saturday at eleven", "timestamp_seconds": 20}]},
        ],
        "improvements": [
            # Fabricated quote: this observation must be dropped
            {"text": "Was rude about price.", "evidence": [{"quote": "that is not my problem", "timestamp_seconds": 15}]},
            # Claim about something that did NOT happen: no quote possible, must be kept
            {"text": "Did not ask about a trade-in.", "evidence": []},
        ],
        "missed_appointment_opportunities": [],
        "customer_objections": [],
        "coaching_suggestions": [{"text": "Ask about a trade-in before offering times.", "evidence": []}],
        "call_outcome": "appointment_booked",
    }
    data.update(overrides)
    return json.dumps(data)


# -------------------------------------------------------- rubric editing ----

class TestRubricValidation:
    def test_valid_rubric_is_normalised(self):
        out = evaluation.validate_rubric_criteria(
            [{"name": "  Opening  ", "weight": "40"}, {"name": "Close for the visit!", "weight": 60}]
        )
        assert [c["name"] for c in out] == ["Opening", "Close for the visit!"]
        assert [c["key"] for c in out] == ["opening", "close_for_the_visit"]
        assert [c["weight"] for c in out] == [40.0, 60.0]

    def test_existing_key_survives_a_rename(self):
        out = evaluation.validate_rubric_criteria([{"key": "opening", "name": "Greeting & intro", "weight": 100}])
        assert out[0]["key"] == "opening"

    def test_duplicate_names_get_distinct_keys(self):
        out = evaluation.validate_rubric_criteria([{"name": "Tone", "weight": 50}, {"name": "Tone", "weight": 50}])
        assert out[0]["key"] != out[1]["key"]

    @pytest.mark.parametrize(
        "criteria, message",
        [
            ([], "at least one"),
            ([{"name": "A", "weight": 60}, {"name": "B", "weight": 30}], "add up to 100"),
            ([{"name": "", "weight": 100}], "needs a name"),
            ([{"name": "A", "weight": "lots"}], "numeric weight"),
            ([{"name": "A", "weight": 0}, {"name": "B", "weight": 100}], "between 1 and 100"),
            ([{"name": f"C{i}", "weight": 1} for i in range(13)], "at most"),
        ],
    )
    def test_invalid_rubrics_are_rejected_with_a_readable_message(self, criteria, message):
        with pytest.raises(evaluation.RubricValidationError, match=message):
            evaluation.validate_rubric_criteria(criteria)

    def test_guidance_length_is_capped(self):
        assert evaluation.validate_guidance("  never quote price  ") == "never quote price"
        assert evaluation.validate_guidance("") is None
        with pytest.raises(evaluation.RubricValidationError):
            evaluation.validate_guidance("x" * 5000)

    def test_manager_wording_reaches_the_prompt_verbatim(self):
        messages = evaluation.build_messages(TRANSCRIPT, CRITERIA, "Never quote price over the phone.", "outbound")
        user = messages[1]["content"]
        assert "Offers two times" in user
        assert "Never quote price over the phone." in user
        assert 'key: "appointment"' in user and "weight: 50%" in user
        assert "[20.5s] REP:" in user


# ---------------------------------------------------------- transcription ----

def deepgram_response(channels=2):
    return {
        "metadata": {"channels": channels},
        "results": {
            "utterances": [
                {"start": 4.21, "end": 7.0, "channel": 1, "speaker": 1, "transcript": "Yes, this is Daniel."},
                {"start": 0.52, "end": 4.0, "channel": 0, "speaker": 0, "transcript": "Hi, this is Maria."},
                {"start": 8.0, "end": 8.5, "channel": 0, "speaker": 0, "transcript": "   "},
            ]
        },
    }


class TestTranscriptParsing:
    def test_outbound_first_channel_is_the_rep(self):
        out = transcription.parse_deepgram_response(deepgram_response(), CallDirection.OUTBOUND)
        assert [(u["speaker"], u["start"]) for u in out] == [("rep", 0.52), ("customer", 4.21)]

    def test_inbound_first_channel_is_the_customer(self):
        out = transcription.parse_deepgram_response(deepgram_response(), CallDirection.INBOUND)
        assert [u["speaker"] for u in out] == ["customer", "rep"]

    def test_mono_audio_does_not_guess_who_the_rep_is(self):
        out = transcription.parse_deepgram_response(deepgram_response(channels=1), CallDirection.OUTBOUND)
        assert [u["speaker"] for u in out] == ["speaker_0", "speaker_1"]

    def test_empty_response(self):
        assert transcription.parse_deepgram_response({}, CallDirection.OUTBOUND) == []

    def test_word_count(self):
        assert transcription.transcript_word_count(TRANSCRIPT[:2]) == 16


# ----------------------------------------------------- grounding + scoring ----

class TestGroundingAndScoring:
    def test_overall_score_is_weighted_and_skips_not_applicable(self):
        out = evaluation.parse_and_ground(llm_output(), TRANSCRIPT, CRITERIA)
        # opening 90 @ 20, appointment 80 @ 50, objections N/A -> (1800 + 4000) / 70
        assert out["overall_score"] == 82.9
        objections = next(c for c in out["category_scores"] if c["key"] == "objections")
        assert objections["not_applicable"] is True and objections["score"] is None

    def test_no_applicable_criteria_gives_no_score(self):
        assert evaluation.compute_overall_score([{"weight": 100, "score": None, "not_applicable": True}]) is None

    def test_timestamps_come_from_the_transcript_not_the_model(self):
        out = evaluation.parse_and_ground(llm_output(), TRANSCRIPT, CRITERIA)
        opening = next(c for c in out["category_scores"] if c["key"] == "opening")
        assert opening["evidence"] == [
            {"quote": "this is Maria from Premium Motors", "timestamp_seconds": 0.5, "speaker": "rep"}
        ]

    def test_fabricated_quotes_are_dropped_but_absence_claims_are_kept(self):
        out = evaluation.parse_and_ground(llm_output(), TRANSCRIPT, CRITERIA)
        texts = [i["text"] for i in out["result"]["improvements"]]
        assert texts == ["Did not ask about a trade-in."]
        assert out["result"]["grounding"] == {"quotes_total": 4, "quotes_verified": 3, "observations_dropped": 1}

    def test_quote_matching_ignores_case_and_punctuation(self):
        assert evaluation.locate_quote("SATURDAY at eleven works", TRANSCRIPT) == 5
        assert evaluation.locate_quote("I never said this", TRANSCRIPT) is None

    def test_ai_outcome_is_recorded_separately(self):
        out = evaluation.parse_and_ground(llm_output(), TRANSCRIPT, CRITERIA)
        assert out["ai_call_outcome"] == "appointment_booked"
        assert "call_outcome" not in out["result"]

    @pytest.mark.parametrize(
        "raw",
        [
            "not json",
            llm_output(call_outcome="sold_a_car"),
            llm_output(category_scores=[{"key": "opening", "score": 90}]),  # missing rubric keys
            llm_output(category_scores=[
                {"key": "opening", "score": 150}, {"key": "objections", "score": 1}, {"key": "appointment", "score": 1},
            ]),
        ],
    )
    def test_malformed_output_is_rejected(self, raw):
        with pytest.raises(ValueError):  # pydantic.ValidationError subclasses ValueError
            evaluation.parse_and_ground(raw, TRANSCRIPT, CRITERIA)


class TestEvaluateTranscript:
    @pytest.fixture(autouse=True)
    def _key(self, monkeypatch):
        monkeypatch.setattr(settings, "openai_api_key", "test-key")

    async def test_happy_path_records_model_and_prompt_version(self, monkeypatch):
        async def fake_llm(messages):
            return llm_output()

        monkeypatch.setattr(evaluation, "_call_llm", fake_llm)
        out = await evaluation.evaluate_transcript(TRANSCRIPT, CRITERIA, None, "outbound")
        assert out["overall_score"] == 82.9
        assert out["llm_model"] == settings.call_review_model
        assert out["prompt_version"] == evaluation.PROMPT_VERSION

    async def test_invalid_output_is_retried_once_with_the_error(self, monkeypatch):
        calls = []

        async def fake_llm(messages):
            calls.append(messages)
            return "oops" if len(calls) == 1 else llm_output()

        monkeypatch.setattr(evaluation, "_call_llm", fake_llm)
        out = await evaluation.evaluate_transcript(TRANSCRIPT, CRITERIA)
        assert out["overall_score"] == 82.9
        assert len(calls) == 2
        assert "rejected" in calls[1][-1]["content"]

    async def test_two_invalid_outputs_fail_cleanly(self, monkeypatch):
        async def fake_llm(messages):
            return "{}"

        monkeypatch.setattr(evaluation, "_call_llm", fake_llm)
        with pytest.raises(evaluation.EvaluationError, match="invalid evaluation twice"):
            await evaluation.evaluate_transcript(TRANSCRIPT, CRITERIA)

    async def test_provider_error_does_not_leak_details(self, monkeypatch):
        async def fake_llm(messages):
            raise RuntimeError("secret transcript text in error")

        monkeypatch.setattr(evaluation, "_call_llm", fake_llm)
        with pytest.raises(evaluation.EvaluationError) as e:
            await evaluation.evaluate_transcript(TRANSCRIPT, CRITERIA)
        assert "secret" not in str(e.value)

    async def test_missing_api_key(self, monkeypatch):
        monkeypatch.setattr(settings, "openai_api_key", "")
        with pytest.raises(evaluation.EvaluationError, match="OPENAI_API_KEY"):
            await evaluation.evaluate_transcript(TRANSCRIPT, CRITERIA)


# ------------------------------------------------------------ eligibility ----

def make_call(**kw) -> CallLog:
    now = utc_now()
    defaults = dict(
        id=uuid.uuid4(),
        twilio_call_sid=f"CA{uuid.uuid4().hex}",
        direction=CallDirection.OUTBOUND,
        from_number="+15550000001",
        to_number="+15550000002",
        status=CallStatus.COMPLETED,
        started_at=now - timedelta(minutes=10),
        answered_at=now - timedelta(minutes=10),
        ended_at=now - timedelta(minutes=7),
        duration_seconds=180,
        recording_url="https://example.blob.core.windows.net/call-recordings/x.wav",
        recording_duration_seconds=180,
        meta_data={},
        activity_logged=False,
        requires_lead_details=False,
        user_id=uuid.uuid4(),
        lead_id=uuid.uuid4(),
        created_at=now,
        updated_at=now,
    )
    defaults.update(kw)
    return CallLog(**defaults)


class TestEligibility:
    def test_normal_completed_call_is_eligible(self):
        assert reviews.ineligibility_reason(make_call()) is None

    @pytest.mark.parametrize(
        "overrides, reason",
        [
            (dict(recording_url=None), "no_recording"),
            (dict(status=CallStatus.NO_ANSWER), "not_completed"),
            (dict(outcome="voicemail"), "voicemail"),
            (dict(recording_duration_seconds=12, duration_seconds=12), "too_short"),
            (dict(direction=CallDirection.INBOUND, answered_at=None, answered_by=None), "not_answered"),
        ],
    )
    def test_ineligible_calls(self, overrides, reason):
        assert reviews.ineligibility_reason(make_call(**overrides)) == reason

    def test_ai_bot_calls_are_never_reviewed(self):
        assert reviews.ineligibility_reason(make_call(), is_ai_call=True) == "ai_outbound_call"


# ---------------------------------------------------- pipeline (with a DB) ----

@compiles(JSONB, "sqlite")
def _jsonb_as_json_on_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
async def db(tmp_path, monkeypatch):
    """Throwaway SQLite database holding just the tables the pipeline touches."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    tables = [
        m.__table__
        for m in (
            CallLog, CallRubric, CallReview, CallEvaluation, AiOutboundCall, Appointment,
            User, Customer, Lead, Dealership,
        )
    ]
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: CallLog.metadata.create_all(c, tables=tables))
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as session:
        session.add(CallRubric(version=1, status="active", name="Test rubric", criteria=CRITERIA))
        await session.commit()
        yield session
    await engine.dispose()


@pytest.fixture
def fakes(monkeypatch):
    """Replace the two external services and count how often each is used."""
    counters = {"transcribe": 0, "llm": 0}
    monkeypatch.setattr(settings, "openai_api_key", "test-key")

    async def fake_transcribe(db, call_log):
        counters["transcribe"] += 1
        return TRANSCRIPT

    async def fake_llm(messages):
        counters["llm"] += 1
        return llm_output()

    monkeypatch.setattr(transcription, "transcribe_call", fake_transcribe)
    monkeypatch.setattr(evaluation, "_call_llm", fake_llm)
    return counters


async def _add_call(db, **kw) -> CallLog:
    call = make_call(**kw)
    db.add(call)
    await db.commit()
    return call


async def _current_eval(db, review_id):
    rows = (
        await db.execute(
            select(CallEvaluation).where(CallEvaluation.review_id == review_id).order_by(CallEvaluation.created_at)
        )
    ).scalars().all()
    return rows, [r for r in rows if r.is_current]


class TestPipeline:
    async def test_call_is_transcribed_scored_and_linked(self, db, fakes):
        call = await _add_call(db)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()

        assert await reviews.process_review(db, review.id) == "completed"

        await db.refresh(review)
        assert review.status == "completed"
        assert review.transcript == TRANSCRIPT
        assert review.transcript_provider == "deepgram"
        # Linked to the lead, rep and call it came from
        assert (review.lead_id, review.rep_user_id, review.call_log_id) == (call.lead_id, call.user_id, call.id)

        rows, current = await _current_eval(db, review.id)
        assert len(rows) == 1 and len(current) == 1
        ev = current[0]
        assert ev.overall_score == 82.9
        assert ev.rubric_version == 1
        assert ev.llm_model == settings.call_review_model
        assert ev.prompt_version == evaluation.PROMPT_VERSION
        assert ev.ai_call_outcome == "appointment_booked"

    async def test_finished_review_is_not_processed_twice(self, db, fakes):
        call = await _add_call(db)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()
        await reviews.process_review(db, review.id)

        assert await reviews.process_review(db, review.id) == "not_claimed"
        assert fakes == {"transcribe": 1, "llm": 1}

    async def test_rescoring_reuses_transcript_and_keeps_history(self, db, fakes):
        call = await _add_call(db)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()
        await reviews.process_review(db, review.id)

        # Manager publishes rubric v2, then re-runs this call
        for r in (await db.execute(select(CallRubric))).scalars().all():
            r.status = "archived"
        db.add(CallRubric(version=2, status="active", name="v2", criteria=CRITERIA))
        await db.commit()

        assert await reviews.process_review(db, review.id, force=True) == "completed"
        assert fakes == {"transcribe": 1, "llm": 2}  # audio was not transcribed again
        rows, current = await _current_eval(db, review.id)
        assert [r.rubric_version for r in rows] == [1, 2]
        assert [r.rubric_version for r in current] == [2]

    async def test_transcription_failure_is_recorded_then_retried(self, db, fakes, monkeypatch):
        call = await _add_call(db)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()

        async def broken(db, call_log):
            raise transcription.TranscriptionError("Transcription provider error (HTTP 503)")

        monkeypatch.setattr(transcription, "transcribe_call", broken)
        assert await reviews.process_review(db, review.id) == "failed"
        await db.refresh(review)
        assert (review.status, review.attempts) == ("failed", 1)
        assert review.error == "Transcription provider error (HTTP 503)"

        async def fixed(db, call_log):
            return TRANSCRIPT

        monkeypatch.setattr(transcription, "transcribe_call", fixed)
        assert await reviews.process_review(db, review.id) == "completed"
        await db.refresh(review)
        assert (review.status, review.attempts, review.error) == ("completed", 2, None)

    async def test_unexpected_errors_store_only_the_error_type(self, db, fakes, monkeypatch):
        call = await _add_call(db)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()

        async def boom(db, call_log):
            raise RuntimeError("customer said their card number is 4111...")

        monkeypatch.setattr(transcription, "transcribe_call", boom)
        assert await reviews.process_review(db, review.id) == "failed"
        await db.refresh(review)
        assert review.error == "Unexpected error (RuntimeError)"

    async def test_short_and_silent_calls_are_skipped_without_using_ai(self, db, fakes, monkeypatch):
        short = await _add_call(db, recording_duration_seconds=8, duration_seconds=8)
        review = await reviews.get_or_create_review(db, short)
        await db.commit()
        assert await reviews.process_review(db, review.id) == "skipped"
        await db.refresh(review)
        assert review.skip_reason == "too_short"
        assert fakes == {"transcribe": 0, "llm": 0}

        async def nearly_silent(db, call_log):
            return [{"speaker": "rep", "start": 0, "end": 1, "text": "Hello? Hello?"}]

        monkeypatch.setattr(transcription, "transcribe_call", nearly_silent)
        silent = await _add_call(db)
        review2 = await reviews.get_or_create_review(db, silent)
        await db.commit()
        assert await reviews.process_review(db, review2.id) == "skipped"
        await db.refresh(review2)
        assert review2.skip_reason == "too_little_speech"
        assert fakes["llm"] == 0

    async def test_ai_bot_call_is_skipped(self, db, fakes):
        call = await _add_call(db)
        db.add(AiOutboundCall(lead_id=call.lead_id, status="completed", call_log_id=call.id))
        review = await reviews.get_or_create_review(db, call)
        await db.commit()
        assert await reviews.process_review(db, review.id) == "skipped"
        await db.refresh(review)
        assert review.skip_reason == "ai_outbound_call"

    async def test_no_active_rubric_fails_with_instructions(self, db, fakes):
        for r in (await db.execute(select(CallRubric))).scalars().all():
            r.status = "archived"
        call = await _add_call(db)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()
        assert await reviews.process_review(db, review.id) == "failed"
        await db.refresh(review)
        assert "No active scoring rubric" in review.error


class TestCrmOutcome:
    """The real outcome comes from CRM data, never from the AI's score."""

    async def _appointment(self, db, call, created_at):
        db.add(
            Appointment(
                lead_id=call.lead_id,
                title="Showroom visit",
                scheduled_at=utc_now() + timedelta(days=2),
                created_at=created_at,
                updated_at=created_at,
            )
        )
        await db.commit()

    async def test_appointment_created_during_the_call_counts(self, db):
        call = await _add_call(db)
        await self._appointment(db, call, call.started_at + timedelta(minutes=2))
        outcome = await reviews.get_crm_outcome(db, call)
        assert outcome["appointment_booked"] is True
        assert outcome["appointment"]["status"] == "scheduled"

    async def test_appointment_from_before_the_call_does_not_count(self, db):
        call = await _add_call(db)
        await self._appointment(db, call, call.started_at - timedelta(days=1))
        assert (await reviews.get_crm_outcome(db, call))["appointment_booked"] is False

    async def test_call_without_a_lead_is_unknown_not_false(self, db):
        call = await _add_call(db, lead_id=None)
        assert (await reviews.get_crm_outcome(db, call))["appointment_booked"] is None


# ---------------------------------------------------------------- the API ----

@pytest.fixture
def api(db, monkeypatch):
    """The call-reviews router on a bare app, with auth and the DB swapped for test doubles."""
    app = FastAPI()
    app.include_router(call_reviews_api.router, prefix="/call-reviews")
    state = SimpleNamespace(user=SimpleNamespace(id=uuid.uuid4(), role=UserRole.DEALERSHIP_ADMIN), queued=[])

    async def _db():
        yield db

    async def _user():
        return state.user

    async def _queue(call_log_id, **kw):
        state.queued.append((call_log_id, kw))

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[deps.get_current_active_user] = _user
    monkeypatch.setattr(reviews, "process_call_review_background", _queue)
    state.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    state.as_role = lambda role, user_id=None: setattr(
        state, "user", SimpleNamespace(id=user_id or uuid.uuid4(), role=role)
    )
    return state


def _draft(weights=(20, 30, 50), **kw):
    body = {
        "name": "Tuned rubric",
        "criteria": [
            {"key": "opening", "name": "Opening", "weight": weights[0], "what_good_looks_like": "Smile in the voice"},
            {"key": "objections", "name": "Objection handling", "weight": weights[1]},
            {"key": "appointment", "name": "Ask for the visit", "weight": weights[2]},
        ],
        "guidance": "Never quote price over the phone.",
    }
    body.update(kw)
    return body


class TestRubricApi:
    async def test_edit_publish_cycle_creates_a_new_version(self, api):
        r = await api.client.get("/call-reviews/rubric")
        assert r.status_code == 200
        assert r.json()["active"]["version"] == 1 and r.json()["draft"] is None and r.json()["can_edit"] is True

        r = await api.client.put("/call-reviews/rubric/draft", json=_draft(change_note="Tighter on the close"))
        assert r.status_code == 200 and r.json()["status"] == "draft" and r.json()["version"] is None

        # Saving a draft changes nothing about how calls are scored
        r = await api.client.get("/call-reviews/rubric")
        assert r.json()["active"]["version"] == 1 and r.json()["draft"]["name"] == "Tuned rubric"

        r = await api.client.post("/call-reviews/rubric/draft/publish")
        assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["status"] == "active"

        r = await api.client.get("/call-reviews/rubric")
        body = r.json()
        assert body["active"]["version"] == 2 and body["draft"] is None
        assert body["active"]["guidance"] == "Never quote price over the phone."
        assert body["active"]["criteria"][0]["what_good_looks_like"] == "Smile in the voice"

        r = await api.client.get("/call-reviews/rubric/versions")
        assert [(v["version"], v["status"]) for v in r.json()] == [(2, "active"), (1, "archived")]

    async def test_weights_must_total_100(self, api):
        r = await api.client.put("/call-reviews/rubric/draft", json=_draft(weights=(20, 30, 40)))
        assert r.status_code == 422
        assert "add up to 100 (currently 90)" in r.json()["detail"]

    async def test_draft_can_be_discarded(self, api):
        await api.client.put("/call-reviews/rubric/draft", json=_draft())
        assert (await api.client.delete("/call-reviews/rubric/draft")).status_code == 204
        assert (await api.client.get("/call-reviews/rubric")).json()["draft"] is None
        assert (await api.client.post("/call-reviews/rubric/draft/publish")).status_code == 404

    async def test_only_managers_can_change_the_rubric(self, api):
        api.as_role(UserRole.SALESPERSON)
        assert (await api.client.put("/call-reviews/rubric/draft", json=_draft())).status_code == 403
        assert (await api.client.post("/call-reviews/rubric/draft/publish")).status_code == 403
        test_body = {"review_ids": [str(uuid.uuid4())], **_draft()}
        assert (await api.client.post("/call-reviews/rubric/test", json=test_body)).status_code == 403
        r = await api.client.get("/call-reviews/rubric")
        assert r.status_code == 200 and r.json()["can_edit"] is False

    async def test_trying_a_draft_on_real_calls_stores_nothing(self, api, db, fakes):
        call = await _add_call(db)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()
        await reviews.process_review(db, review.id)

        r = await api.client.post(
            "/call-reviews/rubric/test", json={"review_ids": [str(review.id)], **_draft(weights=(50, 30, 20))}
        )
        assert r.status_code == 200
        result = r.json()["results"][0]
        assert result["current"]["overall_score"] == 82.9  # 20/30/50 weights
        assert result["draft"]["overall_score"] == 87.1  # 50/30/20 weights, same call
        rows, _ = await _current_eval(db, review.id)
        assert len(rows) == 1  # nothing saved by the test run


class TestReviewApi:
    async def _reviewed_call(self, db, rep_id):
        call = await _add_call(db, user_id=rep_id)
        review = await reviews.get_or_create_review(db, call)
        await db.commit()
        await reviews.process_review(db, review.id)
        return call, review

    async def test_detail_contains_everything_the_review_page_needs(self, api, db, fakes):
        _, review = await self._reviewed_call(db, uuid.uuid4())
        r = await api.client.get(f"/call-reviews/{review.id}")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "completed"
        assert len(body["transcript"]) == len(TRANSCRIPT)
        assert body["evaluation"]["overall_score"] == 82.9
        assert body["evaluation"]["rubric_version"] == 1
        assert body["evaluation"]["strengths"][0]["evidence"][0]["timestamp_seconds"] == 20.5
        # AI opinion and CRM fact are separate fields
        assert body["evaluation"]["ai_call_outcome"] == "appointment_booked"
        assert body["crm_outcome"]["appointment_booked"] is False

    async def test_reps_only_see_their_own_reviews(self, api, db, fakes):
        me, colleague = uuid.uuid4(), uuid.uuid4()
        _, mine = await self._reviewed_call(db, me)
        _, theirs = await self._reviewed_call(db, colleague)

        api.as_role(UserRole.SALESPERSON, me)
        listing = (await api.client.get("/call-reviews")).json()
        assert [i["id"] for i in listing["items"]] == [str(mine.id)] and listing["total"] == 1
        assert (await api.client.get(f"/call-reviews/{mine.id}")).status_code == 200
        assert (await api.client.get(f"/call-reviews/{theirs.id}")).status_code == 403
        # A rep cannot widen the list by asking for a colleague's id
        widened = (await api.client.get("/call-reviews", params={"rep_user_id": str(colleague)})).json()
        assert [i["id"] for i in widened["items"]] == [str(mine.id)]

        api.as_role(UserRole.DEALERSHIP_ADMIN)
        assert (await api.client.get("/call-reviews")).json()["total"] == 2

    async def test_manager_can_queue_a_review_on_demand(self, api, db):
        call = await _add_call(db)
        listed = (await api.client.get("/call-reviews/unreviewed-calls")).json()["items"]
        assert [i["call"]["id"] for i in listed] == [str(call.id)]

        r = await api.client.post(f"/call-reviews/calls/{call.id}/review")
        assert r.status_code == 202
        assert api.queued == [(call.id, {"force": True, "manual": True})]
        assert (await api.client.get("/call-reviews/unreviewed-calls")).json()["items"] == []

        api.as_role(UserRole.SALESPERSON)
        assert (await api.client.post(f"/call-reviews/calls/{call.id}/review")).status_code == 403

    async def test_rescore_shows_as_queued_immediately_and_keeps_the_transcript(self, api, db, fakes):
        _, review = await self._reviewed_call(db, uuid.uuid4())

        r = await api.client.post(f"/call-reviews/{review.id}/rerun")
        assert r.status_code == 202
        assert api.queued == [(review.call_log_id, {"force": True, "manual": True})]

        # Before the background job has even started, the page already sees it as in progress
        body = (await api.client.get(f"/call-reviews/{review.id}")).json()
        assert body["status"] == "pending" and body["attempts"] == 0
        assert len(body["transcript"]) == len(TRANSCRIPT)
        assert body["evaluation"]["rubric_version"] == 1  # old score stays visible meanwhile

        # ...and the queued job then re-scores without transcribing again
        await db.refresh(review)
        assert await reviews.process_review(db, review.id, force=True) == "completed"
        assert fakes == {"transcribe": 1, "llm": 2}

    async def test_automatic_review_is_off_unless_enabled(self, monkeypatch):
        """With the switch off, the webhook-triggered path must not touch the DB or any AI service."""
        monkeypatch.setattr(settings, "call_review_auto_enabled", False)
        # Would raise if it tried to open a PostgreSQL session
        await reviews.process_call_review_background(uuid.uuid4())
