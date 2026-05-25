"""
Robotrend IA — Demo CLI: SofaScore (RapidAPI) com menu interativo
==================================================================

Menu de teste pronto para integrar com apostas esportivas ao vivo.
Cobre todos os endpoints implementados em `api/`:

    1) Categorias ao vivo  /categories/list-live
    2) Listar categorias    /categories/list
    3) Buscar (search)      /search
    4) Auto-complete        /auto-complete
    5) Listar esportes      /sports/list
    6) Smoke test (roda todos em sequência)
    0) Sair

Execução:
    python main.py                 # menu interativo
    python main.py 1               # roda direto a opção 1 (não-interativo)
    python main.py smoke           # roda o smoke test
"""

from __future__ import annotations

import sys
import traceback

try:
    from api import (
        SofaScoreAPIError,
        as_json,
        auto_complete,
        list_categories,
        list_live_categories,
        list_sports,
        search,
    )
except SystemExit:
    print("[main] dependência ausente — rodando install.py …")
    from install import ensure_dependencies

    ensure_dependencies()
    from api import (  # type: ignore[no-redef]
        SofaScoreAPIError,
        as_json,
        auto_complete,
        list_categories,
        list_live_categories,
        list_sports,
        search,
    )


# ============================================================
# helpers de impressão
# ============================================================

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_RUNTIME = 3
BAR = "=" * 64


def _header(title: str) -> None:
    print(f"\n{BAR}\n{title}\n{BAR}")


def _print_result(result: dict) -> None:
    quota = result["quota"]
    print(f"status_code : {result['status_code']}")
    print(f"endpoint    : GET {result['path']}")
    print(f"params      : {result['params']}")
    print(quota.summary())
    if quota.is_exhausted:
        print("[AVISO] quota esgotada — próximas chamadas vão devolver 429.")
    print("\n--- JSON formatado ---")
    print(as_json(result))


def _safe(call) -> int:
    """Executa um callable, captura SofaScoreAPIError com saída amigável."""
    try:
        result = call()
    except SofaScoreAPIError as exc:
        print(f"\n[ERRO API] {exc}")
        if exc.status_code is not None:
            print(f"  status_code: {exc.status_code}")
        if exc.response_text:
            print(f"  resposta   : {exc.response_text}")
        return EXIT_RUNTIME
    except ValueError as exc:
        print(f"\n[ERRO ENTRADA] {exc}")
        return EXIT_RUNTIME
    except KeyboardInterrupt:
        print("\n[interrompido pelo usuário]")
        return EXIT_RUNTIME
    except Exception as exc:  # noqa: BLE001
        print(f"\n[ERRO INESPERADO] {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return EXIT_RUNTIME

    _print_result(result)
    return EXIT_OK


# ============================================================
# inputs interativos com defaults sensatos
# ============================================================

def _ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or default


# ============================================================
# ações do menu
# ============================================================

def action_live_categories() -> int:
    sport = _ask("Esporte", "football")
    _header(f"1) Categorias ao vivo — sport={sport}")
    return _safe(lambda: list_live_categories(sport=sport))


def action_categories() -> int:
    sport = _ask("Esporte", "football")
    _header(f"2) Listar categorias — sport={sport}")
    return _safe(lambda: list_categories(sport=sport))


def action_search() -> int:
    q = _ask("Termo de busca", "messi")
    type_ = _ask("Tipo (all|teams|players|events|tournaments|categories)", "all")
    page_str = _ask("Página", "0")
    try:
        page = int(page_str)
    except ValueError:
        print("[ERRO ENTRADA] página deve ser um número")
        return EXIT_RUNTIME
    _header(f"3) Search — q={q!r} type={type_} page={page}")
    return _safe(lambda: search(q=q, type_=type_, page=page))


def action_autocomplete() -> int:
    query = _ask("Query (autocomplete)", "cris")
    _header(f"4) Auto-complete — query={query!r}")
    return _safe(lambda: auto_complete(query=query))


def action_sports() -> int:
    country = _ask("countryCode (ISO-2)", "GB")
    _header(f"5) Sports list — countryCode={country}")
    return _safe(lambda: list_sports(country_code=country))


def action_smoke() -> int:
    """Roda todos os endpoints com defaults — útil pra validar credencial/quota."""
    print("\n>>> SMOKE TEST: rodando todos os endpoints com defaults\n")
    steps = [
        ("list_live_categories(football)", lambda: list_live_categories("football")),
        ("list_categories(football)",      lambda: list_categories("football")),
        ("search(messi, all, 0)",          lambda: search("messi", "all", 0)),
        ("auto_complete(cris)",            lambda: auto_complete("cris")),
        ("list_sports(GB)",                lambda: list_sports("GB")),
    ]
    failures = 0
    for label, call in steps:
        _header(label)
        if _safe(call) != EXIT_OK:
            failures += 1
    _header("Resumo smoke test")
    print(f"OK     : {len(steps) - failures}/{len(steps)}")
    print(f"FAIL   : {failures}/{len(steps)}")
    return EXIT_OK if failures == 0 else EXIT_RUNTIME


ACTIONS = {
    "1": ("Categorias ao vivo  (/categories/list-live)", action_live_categories),
    "2": ("Listar categorias   (/categories/list)",       action_categories),
    "3": ("Buscar (search)     (/search)",                action_search),
    "4": ("Auto-complete       (/auto-complete)",         action_autocomplete),
    "5": ("Listar esportes     (/sports/list)",           action_sports),
    "6": ("Smoke test (roda todos)",                       action_smoke),
    "smoke": ("Smoke test (alias)",                        action_smoke),
}


# ============================================================
# loop interativo
# ============================================================

def menu_loop() -> int:
    while True:
        _header("Robotrend IA — SofaScore (RapidAPI)")
        for key, (label, _) in ACTIONS.items():
            if key.isdigit():
                print(f"  {key}) {label}")
        print("  0) Sair")
        try:
            choice = input("\nEscolha uma opção: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\nAté logo.")
            return EXIT_OK

        if choice in {"0", "q", "quit", "exit"}:
            print("Até logo.")
            return EXIT_OK
        action = ACTIONS.get(choice)
        if not action:
            print(f"[!] opção inválida: {choice!r}")
            continue
        action[1]()


# ============================================================
# entrypoint
# ============================================================

def main(argv: list[str]) -> int:
    if len(argv) > 1:
        choice = argv[1].strip().lower()
        action = ACTIONS.get(choice)
        if not action:
            print(f"opção inválida: {choice!r}. Opções: {', '.join(ACTIONS)}")
            return EXIT_CONFIG
        return action[1]()
    return menu_loop()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except SofaScoreAPIError as exc:
        print(f"[ERRO CONFIG] {exc}")
        print("Edite python/.env e configure RAPIDAPI_KEY.")
        sys.exit(EXIT_CONFIG)
