from datetime import datetime, timezone

from app.models.customer import Customer
from app.services import sms_consent_service as c
from app.services.sms_broadcast_service import in_send_window
from zoneinfo import ZoneInfo


def _customer(**kw) -> Customer:
    cust = Customer(first_name="Ana", phone="+14045550100")
    cust.sms_opted_out = False
    cust.sms_inquiry_consent = None
    cust.sms_promo_consent = None
    for k, v in kw.items():
        setattr(cust, k, v)
    return cust


def test_english_stop_is_left_to_twilio():
    cust = _customer(sms_promo_consent=True)
    kind, reply = c.apply_inbound_keyword(cust, "STOP", "STOP")
    assert kind == c.KEYWORD_OPT_OUT and reply is None
    assert cust.sms_opted_out is True


def test_spanish_stop_gets_crm_reply():
    cust = _customer()
    kind, reply = c.apply_inbound_keyword(cust, "  Parar. ", None)
    assert kind == c.KEYWORD_OPT_OUT
    assert cust.sms_opted_out is True
    assert "START" in reply


def test_sentence_with_stop_is_not_a_keyword():
    cust = _customer()
    assert c.apply_inbound_keyword(cust, "stop by tomorrow?", None) == (None, None)
    assert cust.sms_opted_out is False


def test_yes_reply_does_not_resubscribe_active_customer():
    cust = _customer(sms_promo_consent=False)
    assert c.apply_inbound_keyword(cust, "Yes", None) == (None, None)
    assert cust.sms_promo_consent is False


def test_start_resubscribes_after_opt_out():
    cust = _customer(sms_opted_out=True)
    kind, reply = c.apply_inbound_keyword(cust, "START", "START")
    assert kind == c.KEYWORD_OPT_IN and reply is None
    assert cust.sms_opted_out is False and cust.sms_promo_consent is True


def test_spanish_start_sends_confirmation():
    cust = _customer(sms_opted_out=True)
    _, reply = c.apply_inbound_keyword(cust, "comenzar", None)
    assert reply == c.promo_confirmation_message()


def test_send_rules():
    opted_out = _customer(sms_opted_out=True, sms_promo_consent=True, sms_inquiry_consent=True)
    assert c.send_block_reason(opted_out, c.CATEGORY_CONVERSATION)
    assert c.send_block_reason(opted_out, c.CATEGORY_COMPLIANCE) is None

    promo_ok = _customer(sms_promo_consent=True, sms_inquiry_consent=True)
    assert c.send_block_reason(promo_ok, c.CATEGORY_PROMOTIONAL, promo_enabled=False)
    assert c.send_block_reason(promo_ok, c.CATEGORY_PROMOTIONAL, promo_enabled=True) is None

    inquiry_only = _customer(sms_inquiry_consent=True, sms_promo_consent=False)
    assert c.send_block_reason(inquiry_only, c.CATEGORY_PROMOTIONAL, promo_enabled=True)
    assert c.send_block_reason(inquiry_only, c.CATEGORY_AUTO_FIRST) is None

    unknown = _customer()
    assert c.send_block_reason(unknown, c.CATEGORY_AUTO_FIRST)
    assert c.send_block_reason(unknown, c.CATEGORY_CONVERSATION) is None


def test_form_consent_columns():
    assert c.consent_from_columns({}) == (True, True, "lead_form")
    cols = {"acepto_mensajes_sms": "true", "acepto_ofertas_promocionales": ""}
    assert c.consent_from_columns(cols) == (True, False, "lead_form_checkbox")


def test_promotional_body_gets_brand_and_stop():
    body = c.prepare_promotional_body("Hola {nombre}, 10% de descuento este fin de semana.")
    assert body.startswith(f"{c.brand()}:") and "STOP" in body
    assert c.personalize(body, "Luis").startswith(f"{c.brand()}: Hola Luis,")
    assert c.personalize(body, None).startswith(f"{c.brand()}: Hola,")


def test_only_brand_links_allowed():
    assert c.disallowed_link_hosts("Vea carvamonos.com/ofertas y https://www.carvamonos.com") == []
    assert c.disallowed_link_hosts("Clic bit.ly/abc") == ["bit.ly"]


def test_segments():
    assert c.segment_count("a" * 160) == 1
    assert c.segment_count("a" * 161) == 2
    assert c.segment_count("á" * 70) == 1
    assert c.segment_count("ó" * 71) == 2


def test_promo_send_window():
    ny = ZoneInfo("America/New_York")
    assert in_send_window(ny, datetime(2026, 11, 27, 14, 0, tzinfo=timezone.utc))
    assert not in_send_window(ny, datetime(2026, 11, 28, 2, 0, tzinfo=timezone.utc))
