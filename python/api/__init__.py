"""
Robotrend IA — Pacote `api`
===========================

Wrapper Python sobre a SofaScore via RapidAPI.

Use:
    from api import (
        list_live_categories,
        list_categories,
        search,
        auto_complete,
        list_sports,
        SofaScoreClient,
        SofaScoreAPIError,
        get_client,
        as_json,
    )

Para uso assíncrono (FastAPI / aiohttp / asyncio):
    from api import (
        alist_live_categories,
        alist_categories,
        asearch,
        aauto_complete,
        alist_sports,
    )
"""

from .client import (
    QuotaInfo,
    SofaScoreAPIError,
    SofaScoreClient,
    get_client,
    load_env,
    reset_client,
)
from .categories import (
    alist_categories,
    alist_live_categories,
    list_categories,
    list_live_categories,
)
from .search import (
    VALID_SEARCH_TYPES,
    aauto_complete,
    asearch,
    auto_complete,
    search,
)
from .sports import alist_sports, list_sports


def as_json(result: dict, *, indent: int = 2) -> str:
    """Atalho para `SofaScoreClient.as_json(result)`."""
    return SofaScoreClient.as_json(result, indent=indent)


__all__ = [
    # cliente / core
    "SofaScoreClient",
    "SofaScoreAPIError",
    "QuotaInfo",
    "get_client",
    "reset_client",
    "load_env",
    "as_json",
    # categorias
    "list_live_categories",
    "list_categories",
    "alist_live_categories",
    "alist_categories",
    # busca
    "search",
    "auto_complete",
    "asearch",
    "aauto_complete",
    "VALID_SEARCH_TYPES",
    # esportes
    "list_sports",
    "alist_sports",
]
