"""
Robotrend IA — SofaScore (RapidAPI) | Endpoint de esportes
==========================================================

Funções:
    list_sports(country_code="GB")  → GET /sports/list
    alist_sports(country_code="GB") → versão assíncrona
"""

from __future__ import annotations

from typing import Any

from .client import get_client


def _normalize_country(code: str) -> str:
    code = (code or "").strip().upper()
    if len(code) != 2 or not code.isalpha():
        raise ValueError("countryCode deve ser ISO alpha-2 (ex.: GB, BR, US)")
    return code


def list_sports(country_code: str = "GB") -> dict[str, Any]:
    """
    Lista todos os esportes disponíveis para o país.
    `country_code` em formato ISO 3166-1 alpha-2 (GB, BR, US, …).
    """
    return get_client().request(
        "/sports/list", params={"countryCode": _normalize_country(country_code)}
    )


async def alist_sports(country_code: str = "GB") -> dict[str, Any]:
    return await get_client().arequest(
        "/sports/list", params={"countryCode": _normalize_country(country_code)}
    )
