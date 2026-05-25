"""
Robotrend IA — SofaScore (RapidAPI) | Endpoints de categorias
=============================================================

Funções:
    list_live_categories(sport="football")  → GET /categories/list-live
    list_categories(sport="football")       → GET /categories/list

Cada função tem variante assíncrona prefixada por `a`:
    alist_live_categories, alist_categories.

Todas devolvem o dict padronizado do cliente
(`ok, status_code, path, params, data, quota, headers`).
"""

from __future__ import annotations

from typing import Any

from .client import get_client


# ----------------------------------------------------------------
# síncrono
# ----------------------------------------------------------------
def list_live_categories(sport: str = "football") -> dict[str, Any]:
    """Categorias com partidas ao vivo agora."""
    return get_client().request(
        "/categories/list-live", params={"sport": sport}
    )


def list_categories(sport: str = "football") -> dict[str, Any]:
    """Todas as categorias (ligas-mãe / países) suportadas pelo esporte."""
    return get_client().request(
        "/categories/list", params={"sport": sport}
    )


# ----------------------------------------------------------------
# assíncrono
# ----------------------------------------------------------------
async def alist_live_categories(sport: str = "football") -> dict[str, Any]:
    return await get_client().arequest(
        "/categories/list-live", params={"sport": sport}
    )


async def alist_categories(sport: str = "football") -> dict[str, Any]:
    return await get_client().arequest(
        "/categories/list", params={"sport": sport}
    )
