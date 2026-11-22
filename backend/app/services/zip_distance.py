"""Drive time from a US ZIP to a store.

The minutes are a driving route to the store's street address. A straight line
at highway speed was much too short: 30071 to Gwinnett Place Ford is about
12 minutes on the road, not 4.
"""
from __future__ import annotations

from typing import Optional

import httpx

_geo_cache: dict[str, Optional[tuple[float, float, str]]] = {}
_route_cache: dict[tuple[float, float, float, float], tuple[float, float]] = {}

_ARCGIS = (
    "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates"
)
_OSRM = "https://router.project-osrm.org/route/v1/driving"


def zip5(value: Optional[str]) -> Optional[str]:
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if len(digits) < 5:
        return None
    return digits[:5]


def miles_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math

    radius = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def round_drive_minutes(minutes: float) -> int:
    return max(1, int(round(minutes)))


def parse_osrm_route(payload: dict) -> Optional[tuple[float, float]]:
    """Return (miles, minutes) from an OSRM route response."""
    routes = payload.get("routes") or []
    if not routes:
        return None
    try:
        meters = float(routes[0]["distance"])
        seconds = float(routes[0]["duration"])
    except (TypeError, ValueError, KeyError):
        return None
    if meters < 0 or seconds < 0:
        return None
    return meters / 1609.344, seconds / 60.0


def store_location_query(
    address: Optional[str],
    city: Optional[str],
    state: Optional[str],
    postal_code: Optional[str],
) -> Optional[str]:
    """Showroom street, or the store ZIP. A city name alone is not a destination."""
    street = (address or "").strip()
    postal = zip5(postal_code)
    if street:
        if postal and postal not in street:
            extra = [part.strip() for part in (city, state, postal) if part and str(part).strip() and str(part).strip() not in street]
            return ", ".join([street, *extra])
        return street
    if not postal:
        return None
    parts = [part.strip() for part in (city, state, postal) if part and str(part).strip()]
    return ", ".join(parts)


def fallback_drive(straight_miles: float) -> tuple[int, int]:
    """Used only when the road router is down. Roads are longer and slower than a 65 mph line."""
    road_miles = straight_miles * 1.25
    minutes = round_drive_minutes(road_miles / 30.0 * 60.0)
    shown_miles = max(1, round(road_miles)) if road_miles >= 0.5 else 0
    return shown_miles, minutes


async def lookup_zip(postal: Optional[str]) -> Optional[tuple[float, float, str]]:
    code = zip5(postal)
    if code is None:
        return None
    cache_key = f"zippopotam:{code}"
    if cache_key in _geo_cache:
        return _geo_cache[cache_key]
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(f"https://api.zippopotam.us/us/{code}")
    except httpx.HTTPError:
        _geo_cache[cache_key] = None
        return None
    if response.status_code != 200:
        _geo_cache[cache_key] = None
        return None
    places = response.json().get("places") or []
    if not places:
        _geo_cache[cache_key] = None
        return None
    place = places[0]
    try:
        found = (
            float(place["latitude"]),
            float(place["longitude"]),
            f"{place.get('place name', '')}, {place.get('state abbreviation', '')}".strip(" ,"),
        )
    except (TypeError, ValueError, KeyError):
        _geo_cache[cache_key] = None
        return None
    _geo_cache[cache_key] = found
    return found


async def _geocode(client: httpx.AsyncClient, query: str) -> Optional[tuple[float, float, str]]:
    key = " ".join(query.lower().split())
    if key in _geo_cache:
        return _geo_cache[key]
    try:
        response = await client.get(
            _ARCGIS,
            params={
                "f": "json",
                "singleLine": query,
                "maxLocations": 1,
                "countryCode": "USA",
            },
        )
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    candidates = response.json().get("candidates") or []
    if not candidates or float(candidates[0].get("score") or 0) < 80:
        _geo_cache[key] = None
        return None
    hit = candidates[0]
    try:
        found = (
            float(hit["location"]["y"]),
            float(hit["location"]["x"]),
            str(hit.get("address") or query),
        )
    except (TypeError, ValueError, KeyError):
        _geo_cache[key] = None
        return None
    _geo_cache[key] = found
    return found


async def locate(
    client: httpx.AsyncClient,
    query: str,
    postal_fallback: Optional[str] = None,
) -> Optional[tuple[float, float, str]]:
    found = await _geocode(client, query)
    if found is not None:
        return found
    return await lookup_zip(postal_fallback)


def _route_key(origin: tuple[float, float], dest: tuple[float, float]) -> tuple[float, float, float, float]:
    return (round(origin[0], 4), round(origin[1], 4), round(dest[0], 4), round(dest[1], 4))


async def driving_leg(
    client: httpx.AsyncClient,
    origin: tuple[float, float],
    dest: tuple[float, float],
) -> tuple[int, int]:
    """Road miles and minutes. Falls back to a slow road estimate if routing fails."""
    key = _route_key(origin, dest)
    cached = _route_cache.get(key)
    if cached is not None:
        miles, minutes = cached
        return _shown_miles(miles), round_drive_minutes(minutes)

    url = f"{_OSRM}/{origin[1]},{origin[0]};{dest[1]},{dest[0]}"
    try:
        response = await client.get(url, params={"overview": "false"})
        parsed = parse_osrm_route(response.json()) if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        parsed = None
    if parsed is not None:
        _route_cache[key] = parsed
        return _shown_miles(parsed[0]), round_drive_minutes(parsed[1])
    return fallback_drive(miles_between(origin[0], origin[1], dest[0], dest[1]))


def _shown_miles(miles: float) -> int:
    return max(1, round(miles)) if miles >= 0.5 else 0
