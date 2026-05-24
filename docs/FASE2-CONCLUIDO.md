# FASE 2 — Reorganização de pastas (concluída)

## Movido para `deploy/`
- `Dockerfile` → `deploy/Dockerfile` (build context: raiz `..`)
- `docker-compose.yml` → `deploy/docker-compose.yml`
- `nginx.conf` → `deploy/nginx.conf`
- `ecosystem.config.js` → `deploy/ecosystem.config.js`
- `deploy/certs/README.txt` — instruções TLS

## Movido para `scripts/win/`
- `INSTALAR.bat` → `scripts/win/INSTALAR.bat`
- `INICIAR.bat` → `scripts/win/INICIAR.bat`

## Atalhos na raiz (compatibilidade)
- `INSTALAR.bat` → chama `scripts\win\INSTALAR.bat`
- `INICIAR.bat` → chama `scripts\win\INICIAR.bat`

## Novos scripts npm
| Script | Comando |
|--------|---------|
| `docker:up` | compose build + up |
| `docker:down` | compose down |
| `docker:logs` | logs do app |
| `pm2:start` | PM2 com deploy/ecosystem.config.js |
| `pm2:stop` | para robotrend-ia |

## Árvore final
```
Robotrend/
├── backend/
├── frontend/
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── ecosystem.config.js
│   ├── nginx.conf
│   └── certs/
├── scripts/
│   ├── backup-phase1.js
│   ├── generate-secrets.js
│   ├── apply-secrets-to-env.js
│   └── win/
├── docs/
├── logs/
├── package.json
├── .env / .env.example
├── INSTALAR.bat
└── INICIAR.bat
```

## FASE 3 (próxima)
- `render.yaml` / Railway
- checklist produção final
- validação SSL + domínio real
