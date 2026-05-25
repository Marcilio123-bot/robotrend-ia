"""
Robotrend IA — SofaScore (RapidAPI) | Endpoints de busca
========================================================

Funções:
    search(q, type_="all", page=0)   → GET /search
    auto_complete(query)             → GET /auto-complete

Cada função tem variante assíncrona prefixada por `a`:
    asearch, aauto_complete.
"""

from __future__ import annotations

from typing import Any

from .client import get_client


# Tipos válidos comumente aceitos pelo endpoint /search.
# Mantemos como tupla pública para validações futuras.
VALID_SEARCH_TYPES: tuple[str, ...] = (
    "all",
    "teams",
    "players",
    "events",
    "tournaments",
    "categories",
)


def _validate_page(page: int) -> int:
    if page < 0:
        raise ValueError("page deve ser ≥ 0")
    return page


# ----------------------------------------------------------------
# síncrono
# ----------------------------------------------------------------
def search(q: str, type_: str = "all", page: int = 0) -> dict[str, Any]:
    """
    Busca livre. `type_` aceita: all, teams, players, events, tournaments, categories.
    """
    if not q or not q.strip():
        raise ValueError("parâmetro `q` é obrigatório")
    return get_client().request(
        "/search",
        params={"q": q.strip(), "type": type_, "page": _validate_page(page)},
    )


def auto_complete(query: str) -> dict[str, Any]:
    """Sugestões enquanto o usuário digita (autocomplete de busca)."""
    if not query or not query.strip():
        raise ValueError("parâmetro `query` é obrigatório")
    return get_client().request(
        "/auto-complete", params={"query": query.strip()}
    )


# ----------------------------------------------------------------
# assíncrono
# ----------------------------------------------------------------
async def asearch(q: str, type_: str = "all", page: int = 0) -> dict[str, Any]:
    if not q or not q.strip():
        raise ValueError("parâmetro `q` é obrigatório")
    return await get_client().arequest(
        "/search",
        params={"q": q.strip(), "type": type_, "page": _validate_page(page)},
    )


async def aauto_complete(query: str) -> dict[str, Any]:
    if not query or not query.strip():
        raise ValueError("parâmetro `query` é obrigatório")
    return await get_client().arequest(
        "/auto-complete", params={"query": query.strip()}
    )
