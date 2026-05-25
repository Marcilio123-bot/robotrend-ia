"""
Robotrend IA — Cliente HTTP base para SofaScore (RapidAPI)
===========================================================

Centraliza tudo que NÃO deveria ser repetido em cada endpoint:

    * Sessão `requests.Session` com keep-alive
    * Headers reutilizáveis (lidos de variáveis de ambiente)
    * Timeout configurável
    * Logging para console + arquivo (logs/sofascore.log)
    * Tratamento padronizado de erros → SofaScoreAPIError
    * Parsing dos headers de quota do RapidAPI
    * Resposta padronizada em dict (status_code + data + quota + headers)
    * Wrapper assíncrono via `asyncio.to_thread` (sem nova dependência)

Cada módulo de endpoint (`categories.py`, `search.py`, `sports.py`)
apenas chama `get_client().request(path, params=...)`.

Variáveis de ambiente reconhecidas (todas opcionais menos a chave):

    RAPIDAPI_KEY        → obrigatória
    RAPIDAPI_HOST       → default: sofascore.p.rapidapi.com
    SOFASCORE_TIMEOUT   → segundos, default 15
    SOFASCORE_LOG_LEVEL → DEBUG | INFO | WARNING | ERROR (default INFO)
    SOFASCORE_LOG_FILE  → caminho do arquivo de log (default logs/sofascore.log)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

try:
    import requests
    from requests import Response, Session
    from requests.exceptions import (
        ConnectionError as RequestsConnectionError,
        HTTPError,
        JSONDecodeError,
        RequestException,
        Timeout,
    )
except ImportError as exc:
    raise SystemExit(
        "Dependência ausente: `requests`. Rode `python install.py` "
        "ou `pip install -r requirements.txt` antes de usar este módulo."
    ) from exc

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None  # type: ignore[assignment]


# ============================================================
# .env loader — usa python-dotenv quando disponível, fallback manual
# ============================================================

_PKG_DIR = Path(__file__).resolve().parent
_PROJECT_DIR = _PKG_DIR.parent  # python/
_ENV_PATH = _PROJECT_DIR / ".env"
_DEFAULT_LOG_FILE = _PROJECT_DIR / "logs" / "sofascore.log"


def _manual_load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def load_env(path: str | Path | None = None) -> None:
    """Carrega variáveis do .env localizado em `python/.env` (ou `path`)."""
    target = Path(path) if path else _ENV_PATH
    if load_dotenv is not None:
        load_dotenv(dotenv_path=target, override=False)
    else:
        _manual_load_env(target)


# ============================================================
# Logging — console + arquivo rotativo
# ============================================================

def _build_logger() -> logging.Logger:
    log = logging.getLogger("sofascore")
    if getattr(log, "_robotrend_initialized", False):
        return log

    level = os.getenv("SOFASCORE_LOG_LEVEL", "INFO").upper()
    log.setLevel(level)
    log.propagate = False

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    log.addHandler(console)

    log_file = Path(os.getenv("SOFASCORE_LOG_FILE", str(_DEFAULT_LOG_FILE)))
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_file, maxBytes=1_000_000, backupCount=3, encoding="utf-8"
        )
        file_handler.setFormatter(fmt)
        log.addHandler(file_handler)
    except OSError:
        # filesystem read-only? seguimos só com console
        log.warning("não foi possível abrir log file %s — usando só console", log_file)

    log._robotrend_initialized = True  # type: ignore[attr-defined]
    return log


# ============================================================
# Modelos
# ============================================================

class SofaScoreAPIError(RuntimeError):
    """Erro genérico do cliente. `status_code` pode ser None em falhas de rede."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response_text: str | None = None,
        path: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_text = response_text
        self.path = path


@dataclass
class QuotaInfo:
    """Snapshot do estado da quota RapidAPI lido dos headers da resposta."""

    requests_limit: int | None = None
    requests_remaining: int | None = None
    requests_reset: int | None = None  # segundos até reset
    raw: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_headers(cls, headers: dict[str, str]) -> "QuotaInfo":
        def _int(name: str) -> int | None:
            value = headers.get(name)
            try:
                return int(value) if value is not None else None
            except (TypeError, ValueError):
                return None

        return cls(
            requests_limit=_int("x-ratelimit-requests-limit"),
            requests_remaining=_int("x-ratelimit-requests-remaining"),
            requests_reset=_int("x-ratelimit-requests-reset"),
            raw={k: v for k, v in headers.items() if k.lower().startswith("x-")},
        )

    @property
    def is_exhausted(self) -> bool:
        return self.requests_remaining is not None and self.requests_remaining <= 0

    def summary(self) -> str:
        if self.requests_limit is None and self.requests_remaining is None:
            return "quota: (header não exposto pelo provider)"
        return (
            f"quota: {self.requests_remaining}/{self.requests_limit} requisições restantes"
            + (f" (reset em {self.requests_reset}s)" if self.requests_reset else "")
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "requests_limit": self.requests_limit,
            "requests_remaining": self.requests_remaining,
            "requests_reset": self.requests_reset,
        }


# ============================================================
# Cliente HTTP — singleton compartilhado
# ============================================================

class SofaScoreClient:
    """
    Cliente HTTP único reutilizado por todos os módulos de endpoint.
    Use `get_client()` para obter a instância singleton — não instancie
    manualmente fora de testes.
    """

    BASE_URL = "https://sofascore.p.rapidapi.com"
    _PLACEHOLDERS = {"", "MINHA_KEY", "SUA_CHAVE_AQUI", "your_rapidapi_key_here"}

    def __init__(
        self,
        api_key: str | None = None,
        api_host: str | None = None,
        timeout: float | None = None,
        session: Session | None = None,
    ) -> None:
        load_env()
        self.logger = _build_logger()

        self.api_key = (api_key or os.getenv("RAPIDAPI_KEY", "")).strip()
        self.api_host = (api_host or os.getenv("RAPIDAPI_HOST", "sofascore.p.rapidapi.com")).strip()
        self.timeout = float(timeout if timeout is not None else os.getenv("SOFASCORE_TIMEOUT", "15"))

        if self.api_key in self._PLACEHOLDERS:
            raise SofaScoreAPIError(
                "RAPIDAPI_KEY não configurada. Edite python/.env e coloque sua chave real."
            )

        self.session = session or requests.Session()
        self.session.headers.update(self._default_headers())

    # ----------------------------------------------------------------
    # headers reutilizáveis
    # ----------------------------------------------------------------
    def _default_headers(self) -> dict[str, str]:
        return {
            "x-rapidapi-key": self.api_key,
            "x-rapidapi-host": self.api_host,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    # ----------------------------------------------------------------
    # request síncrono
    # ----------------------------------------------------------------
    def request(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """
        Faz um GET e devolve dict padronizado:
            { ok, status_code, path, params, data, quota, headers }
        Levanta `SofaScoreAPIError` em qualquer falha.
        """
        url = f"{self.BASE_URL}{path}"
        merged_headers = self._default_headers()
        if extra_headers:
            merged_headers.update(extra_headers)

        self.logger.info("GET %s params=%s", path, params or {})
        try:
            response: Response = self.session.get(
                url, params=params, headers=merged_headers, timeout=self.timeout
            )
        except Timeout as exc:
            self.logger.error("timeout em GET %s após %ss", path, self.timeout)
            raise SofaScoreAPIError(
                f"Timeout após {self.timeout}s em GET {path}", path=path
            ) from exc
        except RequestsConnectionError as exc:
            self.logger.error("falha de conexão em GET %s: %s", path, exc)
            raise SofaScoreAPIError(
                f"Falha de conexão em GET {path}: {exc}", path=path
            ) from exc
        except RequestException as exc:
            self.logger.error("erro HTTP genérico em GET %s: %s", path, exc)
            raise SofaScoreAPIError(
                f"Erro HTTP em GET {path}: {exc}", path=path
            ) from exc

        quota = QuotaInfo.from_headers(response.headers)
        self.logger.info(
            "← %s %s %s", response.status_code, path, quota.summary()
        )

        if response.status_code in (401, 403):
            raise SofaScoreAPIError(
                f"Acesso negado (HTTP {response.status_code}). "
                "Verifique sua RAPIDAPI_KEY e a inscrição no plano correto.",
                status_code=response.status_code,
                response_text=response.text[:500],
                path=path,
            )
        if response.status_code == 429:
            raise SofaScoreAPIError(
                f"Limite atingido (HTTP 429). {quota.summary()}",
                status_code=429,
                response_text=response.text[:500],
                path=path,
            )
        try:
            response.raise_for_status()
        except HTTPError as exc:
            raise SofaScoreAPIError(
                f"HTTP {response.status_code} em GET {path}: {response.text[:200]}",
                status_code=response.status_code,
                response_text=response.text[:500],
                path=path,
            ) from exc

        try:
            data: Any = response.json()
        except (JSONDecodeError, ValueError) as exc:
            raise SofaScoreAPIError(
                f"Resposta não-JSON em GET {path}: {response.text[:200]}",
                status_code=response.status_code,
                response_text=response.text[:500],
                path=path,
            ) from exc

        return {
            "ok": True,
            "status_code": response.status_code,
            "path": path,
            "params": params or {},
            "data": data,
            "quota": quota,
            "headers": dict(response.headers),
        }

    # ----------------------------------------------------------------
    # request assíncrono — sem nova dependência
    # ----------------------------------------------------------------
    async def arequest(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """
        Wrapper assíncrono sobre `request()`. Útil para integrar com
        pipelines async (FastAPI, aiohttp workers, etc.) sem trazer
        uma dependência HTTP adicional.
        """
        return await asyncio.to_thread(
            self.request, path, params=params, extra_headers=extra_headers
        )

    # ----------------------------------------------------------------
    # serialização auxiliar
    # ----------------------------------------------------------------
    @staticmethod
    def as_json(result: dict[str, Any], *, indent: int = 2) -> str:
        """Serializa um result removendo objetos não-JSON (QuotaInfo etc.)."""
        clone = dict(result)
        quota = clone.get("quota")
        if isinstance(quota, QuotaInfo):
            clone["quota"] = quota.to_dict()
        return json.dumps(clone, indent=indent, ensure_ascii=False, sort_keys=True)

    def close(self) -> None:
        try:
            self.session.close()
        except Exception:  # noqa: BLE001
            pass


# ============================================================
# Singleton — todos os módulos chamam get_client()
# ============================================================

_singleton: SofaScoreClient | None = None


def get_client() -> SofaScoreClient:
    """Devolve a instância única do cliente, criando-a no primeiro uso."""
    global _singleton
    if _singleton is None:
        _singleton = SofaScoreClient()
    return _singleton


def reset_client() -> None:
    """Descarta o singleton (útil para tests / hot-reload de .env)."""
    global _singleton
    if _singleton is not None:
        _singleton.close()
        _singleton = None
