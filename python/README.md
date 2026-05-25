# SofaScore (RapidAPI) — Cliente Python para Robotrend IA

Módulo Python **production-ready** que consome a SofaScore via RapidAPI.
Roda lado a lado com o backend Node já existente
(`backend/services/sofascoreProvider.js`) e foi desenhado para alimentar
o pipeline de **apostas esportivas ao vivo** e futuras automações.

## Estrutura

```
python/
├── api/
│   ├── __init__.py        # exporta a API pública do pacote
│   ├── client.py          # SofaScoreClient + headers + timeout + logs + erros
│   ├── categories.py      # /categories/list-live e /categories/list
│   ├── search.py          # /search e /auto-complete
│   └── sports.py          # /sports/list
├── logs/                  # logs rotativos (sofascore.log)
├── main.py                # CLI com menu interativo
├── install.py             # auto-instala requests + python-dotenv
├── requirements.txt
├── .env.example
├── .env                   # local — já coberto pelo .gitignore raiz
└── README.md
```

## Setup rápido

```powershell
cd python
python install.py                 # instala requests + python-dotenv
copy .env.example .env            # Linux/macOS: cp .env.example .env
# edite .env e troque MINHA_KEY pela sua RAPIDAPI_KEY real
python main.py                    # menu interativo
```

Ou roda direto sem menu:

```powershell
python main.py 1          # categorias ao vivo
python main.py 2          # listar categorias
python main.py 3          # search
python main.py 4          # auto-complete
python main.py 5          # sports/list
python main.py smoke      # roda todos em sequência
```

## Endpoints implementados

| # | Método Python                                   | Endpoint                  | Params default          |
|---|--------------------------------------------------|---------------------------|--------------------------|
| 1 | `list_live_categories(sport)`                    | `/categories/list-live`   | `sport=football`         |
| 2 | `list_categories(sport)`                         | `/categories/list`        | `sport=football`         |
| 3 | `search(q, type_, page)`                         | `/search`                 | `type=all`, `page=0`     |
| 4 | `auto_complete(query)`                           | `/auto-complete`          | —                        |
| 5 | `list_sports(country_code)`                      | `/sports/list`            | `countryCode=GB`         |

Todas as funções têm variantes **assíncronas** com o prefixo `a`:
`alist_live_categories`, `alist_categories`, `asearch`,
`aauto_complete`, `alist_sports`. Não exige nova dependência —
são wrappers sobre `asyncio.to_thread`.

## Uso programático

### Síncrono

```python
from api import list_live_categories, search, as_json

result = list_live_categories(sport="football")
print(result["status_code"])                  # 200
print(result["quota"].requests_remaining)     # ex.: 487
print(as_json(result))                        # JSON formatado

hit = search("messi", type_="players", page=0)
print(hit["data"])
```

### Assíncrono (FastAPI, aiohttp, asyncio puro)

```python
import asyncio
from api import alist_live_categories, asearch

async def main():
    live, hit = await asyncio.gather(
        alist_live_categories("football"),
        asearch("real madrid", type_="teams"),
    )
    print(live["data"], hit["data"])

asyncio.run(main())
```

## Padrão de resposta

Toda função devolve o mesmo dict, qualquer endpoint:

```python
{
    "ok": True,
    "status_code": 200,
    "path": "/categories/list-live",
    "params": {"sport": "football"},
    "data": { ... payload cru do RapidAPI/SofaScore ... },
    "quota": QuotaInfo(requests_limit=500, requests_remaining=487, requests_reset=86400),
    "headers": { ... headers HTTP ... },
}
```

`QuotaInfo` é serializável:

```python
result["quota"].to_dict()
# {"requests_limit": 500, "requests_remaining": 487, "requests_reset": 86400}

result["quota"].is_exhausted   # True se restou 0
result["quota"].summary()      # string p/ log
```

## Tratamento de erros

Todas as falhas viram `SofaScoreAPIError`, com `status_code`, `path` e
`response_text` (primeiros 500 chars). Casos cobertos:

| Situação                       | HTTP   | Mensagem                                   |
|--------------------------------|--------|--------------------------------------------|
| Sem chave / chave placeholder  | -      | `RAPIDAPI_KEY não configurada`             |
| Chave inválida / plano errado  | 401/403| `Acesso negado…`                           |
| Limite estourado               | 429    | `Limite atingido…` + snapshot da quota     |
| Outro erro HTTP                | 4xx/5xx| `HTTP {code} em GET /path: {trecho}`       |
| Timeout                        | -      | `Timeout após {n}s em GET /path`           |
| Falha de conexão               | -      | `Falha de conexão em GET /path: …`         |
| Resposta não-JSON              | 2xx    | `Resposta não-JSON em GET /path: …`        |

## Configuração via `.env`

| Variável              | Default                       | Descrição                                |
|-----------------------|--------------------------------|------------------------------------------|
| `RAPIDAPI_KEY`        | —                              | **Obrigatória**. Sua chave da RapidAPI.  |
| `RAPIDAPI_HOST`       | `sofascore.p.rapidapi.com`     | Host do endpoint                         |
| `SOFASCORE_TIMEOUT`   | `15`                           | Timeout HTTP em segundos                 |
| `SOFASCORE_LOG_LEVEL` | `INFO`                         | DEBUG / INFO / WARNING / ERROR           |
| `SOFASCORE_LOG_FILE`  | `python/logs/sofascore.log`    | Arquivo do log rotativo (1MB × 3)        |

## Logs

`api/client.py` configura um logger chamado `sofascore` com dois
handlers: console + arquivo rotativo (`logs/sofascore.log`, 1 MB,
3 backups). Cada requisição emite:

```
2026-05-25 14:11:03 [INFO] sofascore: GET /categories/list-live params={'sport': 'football'}
2026-05-25 14:11:03 [INFO] sofascore: ← 200 /categories/list-live quota: 487/500 requisições restantes (reset em 86400s)
```

## Integração com o resto do Robotrend

* **Apostas ao vivo**: combine `list_live_categories` (para descobrir
  ligas com jogos ativos) + os pollers em
  `backend/workers/liveFootballPoller.js` para enriquecer fixtures
  com dados de várias fontes.
* **Sinal por quota**: `result["quota"].requests_remaining` pode
  alimentar o `backend/services/quotaMonitor.js` decidindo
  failover entre providers.
* **Pipelines async**: use as variantes `a*` em workers FastAPI/aiohttp
  sem adicionar dependência HTTP.
* **Linha de produção**: mantenha `RAPIDAPI_KEY` em segredo
  (Docker secret / Render env vars / Railway vars). O cliente recusa
  rodar com o placeholder `MINHA_KEY` por segurança.
