"""Approximate drive time between US ZIP codes.

Straight-line miles, then time at 65 mph. That sits in the 60–70 mph range
and is close enough for an agent to see which store is nearest.
"""
from __future__ import annotations

import math
from typing import Optional

import httpx

DRIVE_MPH = 65
_cache: dict[str, Optional[tuple[float, float, str]]] = {}


def zip5(value: Optional[str]) -> Optional[str]:
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if len(digits) < 5:
        return None
    return digits[:5]


def miles_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def minutes_at_drive_speed(miles: float) -> int:
    """Round short trips to the minute and longer ones to five minutes."""
    raw = max(1, miles / DRIVE_MPH * 60)
    if raw < 10:
        return max(1, round(raw))
    return int(round(raw / 5.0) * 5)


async def lookup_zip(postal: Optional[str]) -> Optional[tuple[float, float, str]]:
    code = zip5(postal)
    if code is None:
        return None
    if code in _cache:
        return _cache[code]
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(f"https://api.zippopotam.us/us/{code}")
    except httpx.HTTPError:
        _cache[code] = None
        return None
    if response.status_code != 200:
        _cache[code] = None
        return None
    places = response.json().get("places") or []
    if not places:
        _cache[code] = None
        return None
    place = places[0]
    try:
        found = (
            float(place["latitude"]),
            float(place["longitude"]),
            f"{place.get('place name', '')}, {place.get('state abbreviation', '')}".strip(" ,"),
        )
    except (TypeError, ValueError, KeyError):
        _cache[code] = None
        return None
    _cache[code] = found
    return found
