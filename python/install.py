"""
Auto-instalador de dependências para o cliente SofaScore (RapidAPI).

Uso:
    python install.py

Garante que `requests` e `python-dotenv` estão instalados no Python atual.
Se `requirements.txt` existir, dá preferência a ele.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

REQUIRED = [
    ("requests", "requests>=2.31.0"),
    ("dotenv", "python-dotenv>=1.0.1"),
]


def _pip_install(spec: str) -> None:
    print(f"[install] pip install {spec}")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", spec])


def ensure_dependencies() -> None:
    """Instala o que faltar. Idempotente."""
    req_file = Path(__file__).with_name("requirements.txt")
    if req_file.exists():
        print(f"[install] usando {req_file.name}")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "-r", str(req_file)]
            )
            return
        except subprocess.CalledProcessError as exc:
            print(f"[install] requirements.txt falhou ({exc}); caindo para pacotes individuais")

    for module, spec in REQUIRED:
        try:
            importlib.import_module(module)
            print(f"[install] OK: {module}")
        except ImportError:
            _pip_install(spec)


if __name__ == "__main__":
    ensure_dependencies()
    print("[install] tudo pronto. Rode: python main.py")
