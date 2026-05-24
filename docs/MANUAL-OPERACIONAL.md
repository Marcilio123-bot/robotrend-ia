# Robotrend IA v5.0.0 — Manual operacional

## Links locais (após `npm start` / `INICIAR.bat`)
- Frontend principal: http://localhost:3010/
- Login: http://localhost:3010/login.html
- Registro: http://localhost:3010/register.html
- Pricing: http://localhost:3010/pricing.html
- Admin: http://localhost:3010/admin.html
- Quality: http://localhost:3010/quality.html
- Results: http://localhost:3010/results.html
- Backtest: http://localhost:3010/backtest.html
- API health: http://localhost:3010/api/health
- Healthz (probe): http://localhost:3010/healthz
- Readyz (probe): http://localhost:3010/readyz
- WebSocket: ws://localhost:3010/socket.io/?EIO=4&transport=websocket

## Credenciais bootstrap (dev)
- Email: `admin@robotrend.local`
- Senha: `admin123`

> Em produção, fail-fast bloqueia `admin123` e exige senha forte via `BOOTSTRAP_ADMIN_PASSWORD`.

## Comandos

| Ação | Comando |
|------|---------|
| Instalar deps | `npm install` |
| Iniciar (prod-like) | `npm start` |
| Iniciar (dev + watch) | `npm run dev` |
| Iniciar (Windows duplo-clique) | `INICIAR.bat` |
| Parar | `Ctrl+C` no terminal |
| Smoke test local | `npm run smoke` |
| Smoke test remoto | `npm run smoke -- https://seu_dominio.com` |
| Backup local | `npm run backup:phase1` |
| Gerar secrets | `npm run secrets:generate` |
| Docker up | `npm run docker:up` |
| Docker down | `npm run docker:down` |
| Docker logs | `npm run docker:logs` |
| PM2 start | `npm run pm2:start` |
| PM2 stop | `npm run pm2:stop` |

## Logs
- Arquivo diário: `logs/YYYY-MM-DD.log` (JSON estruturado)
- Acompanhar em tempo real (Windows):
  `Get-Content logs/2026-05-21.log -Wait -Tail 50`
- PM2: `pm2 logs robotrend-ia`
- Docker: `npm run docker:logs`

## Reiniciar
| Cenário | Comando |
|---------|---------|
| Dev (Ctrl+C → restart) | `npm start` |
| Dev com watch | já reinicia sozinho via `nodemon` |
| Docker | `npm run docker:down && npm run docker:up` |
| PM2 | `pm2 reload robotrend-ia --update-env` |

## Atualizar local
```powershell
cd C:\sites\Robotrend
# 1. editar arquivos em backend/ ou frontend/
# 2. salvar
# 3. reiniciar:
#    dev:   nodemon reinicia sozinho
#    prod:  Ctrl+C e npm start
# 4. validar:
npm run smoke
```

## Atualizar produção
### Docker
```bash
cd /opt/robotrend
git pull
npm run docker:down
npm run docker:up
npm run docker:logs
npm run smoke -- https://seu_dominio.com
```

### PM2
```bash
cd /opt/robotrend
git pull
npm ci --omit=dev
pm2 reload robotrend-ia --update-env
pm2 logs robotrend-ia
```

### Render / Railway / Fly
- Push para `main` → auto-deploy
- Render: aba "Logs"; Railway: `railway logs`; Fly: `fly logs`
- Pós-deploy: `npm run smoke -- https://seu_dominio.com`

## Validações em runtime (testadas)
| Item | Status |
|------|--------|
| Banco (in-memory dev / Postgres prod) | OK |
| Login admin → JWT + cookie Secure/HttpOnly/SameSite=Strict | OK |
| `/api/auth/me`, `/api/signals`, `/api/stats`, `/api/admin/overview`, `/api/metrics` | OK |
| `POST /api/signals/test` | OK |
| WebSocket (Socket.IO polling handshake → `sid` + upgrade `websocket`) | OK |
| Persistência (sinais gravados via `db.saveSignal` no `bot.js`) | OK |
| Admin overview retorna `users`, `paidUsers`, `signals`, `payments`, `revenue` | OK |

## Endpoints REST (39)
Lista completa em `README.md` seção "Endpoints REST".

## Estrutura final
```
Robotrend/
├── backend/    (26 módulos)
├── frontend/   (17 arquivos + PWA)
├── deploy/     (Docker, Compose, Nginx, PM2, Render, Railway, Fly)
├── scripts/    (backup, secrets, smoke, ws-probe, win/)
├── docs/       (FASE1, FASE2, DEPLOY-PRODUCAO, MANUAL-OPERACIONAL)
├── logs/       (gitignored)
├── package.json
├── .env / .env.example / .env.production / .env.staging
├── INSTALAR.bat
├── INICIAR.bat
└── README.md
```
