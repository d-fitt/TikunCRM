"""Partner store profile rules. No database."""
import asyncio

import pytest

from app.services.partner_dashboard_service import range_position
from app.services.partner_profile_service import (
    ProfileError,
    normalize_emails,
    slug_platform,
    validate_monthly_range,
)
from app.services.partner_routing_service import route_lead_safely


def test_monthly_range_accepts_a_band() -> None:
    validate_monthly_range(40, 80)
    validate_monthly_range(None, None)


def test_monthly_range_rejects_a_partial_or_reversed_band() -> None:
    with pytest.raises(ProfileError):
        validate_monthly_range(40, None)
    with pytest.raises(ProfileError):
        validate_monthly_range(80, 40)


def test_recipient_emails_are_normalized_once() -> None:
    assert normalize_emails([" Desk@Store.com ", "desk@store.com"]) == ["desk@store.com"]


def test_recipient_email_must_look_like_an_email() -> None:
    with pytest.raises(ProfileError):
        normalize_emails(["not-an-email"])


def test_platform_list_values_become_slugs() -> None:
    assert slug_platform("Facebook Marketplace") == "facebook_marketplace"


def test_range_position() -> None:
    assert range_position(20, 40, 80) == "below"
    assert range_position(52, 40, 80) == "in_range"
    assert range_position(90, 40, 80) == "above"
    assert range_position(10, None, None) is None


def test_automatic_routing_does_not_assign() -> None:
    assert asyncio.run(route_lead_safely(None, None)) == []
