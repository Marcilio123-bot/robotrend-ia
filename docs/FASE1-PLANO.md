# FASE 1 — Plano executado (hardening)

## Backup — CONCLUÍDO
- Script: `npm run backup:phase1` → `scripts/backup-phase1.js`
- Destino: `C:\sites\Robotrend_BACKUP_2026-05-21\`
- Exclui: `node_modules`, logs > 3 dias
- Manifest: `BACKUP_MANIFEST.txt` presente
- Secrets: `secrets.generated.json` no backup (não no repo)

## Git / `.env`
- **Verificado:** `C:\sites\Robotrend` **não é repositório git** (`fatal: not a git repository`).
- `git ls-files .env` → não aplicável localmente.
- Se o projeto estiver no GitHub, rode no clone: `git ls-files .env` e `git log --all -- .env`.

## Secrets
- Gerador: `node scripts/generate-secrets.js`
- Saída recomendada (fora do repo):
  `C:\sites\Robotrend_BACKUP_2026-05-21\secrets.generated.json`

## axios
- **MANTIDO** — usado em `backend/live.js` e `backend/prelive.js`.

## Arquivos modificados nesta fase
| Arquivo | Mudança |
|---------|---------|
| `backend/startup-check.js` | NOVO — fail-fast produção |
| `backend/server.js` | startup-check, CORS, Socket.IO, version 5.0.0 |
| `backend/database.js` | bloqueio in-memory em produção |
| `.env.example` | v5 + ALLOWED_ORIGINS + SESSION_SECRET |
| `.env.production` | NOVO (template) |
| `.env.staging` | NOVO (template) |
| `docker-compose.yml` | senha PG via env |
| `README.md` | versão 5.0.0 + FASE 1 |
| `package.json` | script `secrets:generate` |
| `.gitignore` | `.env.production`, `.env.staging`, secrets |

## Árvore proposta (FASE 2 — ainda não aplicada)
```
Robotrend/
├── backend/
├── frontend/
├── scripts/
│   ├── backup-phase1.ps1
│   └── generate-secrets.js
├── deploy/          ← FASE 2
├── docs/
│   └── FASE1-PLANO.md
├── package.json
├── .env.example
├── .env.production  (gitignored)
├── .env.staging     (gitignored)
└── docker-compose.yml
```

## Riscos antes de subir produção
1. `.env` local ainda com `admin123` — não copiar para produção.
2. CORS em dev sem `ALLOWED_ORIGINS` continua permissivo (ok).
3. Staging exige PG + secrets — igual produção.
4. `docker compose` precisa de `POSTGRES_PASSWORD` no `.env` ou export.
