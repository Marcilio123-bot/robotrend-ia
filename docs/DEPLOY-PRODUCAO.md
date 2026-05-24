# Robotrend IA v5 — Deploy de Produção

## Pré-requisitos
- [ ] Domínio com DNS apontando para o servidor
- [ ] Conta no provider (Render / Railway / Fly / VPS)
- [ ] Postgres 16+ acessível
- [ ] Secrets gerados (`C:\sites\Robotrend_BACKUP_2026-05-21\secrets.generated.json`)
- [ ] Senha admin forte (≥ 16 chars)

## Variáveis obrigatórias (fail-fast vai bloquear se faltar)
```
NODE_ENV=production
DATABASE_URL=postgres://...
JWT_SECRET=<64 hex>
SESSION_SECRET=<32 hex>
BOOTSTRAP_ADMIN_PASSWORD=<forte>
ALLOWED_ORIGINS=https://seu_dominio.com
DEMO_MODE=false
```

## Render.com
1. Conectar repo no dashboard
2. Aplicar blueprint `deploy/render.yaml` (cria web + Postgres)
3. Preencher secrets (todos com `sync: false`)
4. Deploy automático em push para `main`
5. Validar `/healthz` e `/readyz`

## Railway
1. New Project → Deploy from GitHub
2. Apontar build para `deploy/railway.json`
3. Add Postgres plugin → liga `DATABASE_URL` automaticamente
4. Setar demais secrets em Variables
5. Deploy

## Fly.io
```bash
fly launch --copy-config --config deploy/fly.toml --no-deploy
fly postgres create --name robotrend-pg
fly postgres attach robotrend-pg
fly secrets set JWT_SECRET=... SESSION_SECRET=... ALLOWED_ORIGINS=https://...
fly deploy -c deploy/fly.toml
```

## VPS (Docker Compose + nginx + Let's Encrypt)
```bash
cd /opt
git clone <repo> robotrend && cd robotrend
cp .env.production .env
# editar .env com secrets reais
nano .env
mkdir -p deploy/certs
sudo certbot certonly --standalone -d seu_dominio.com -d www.seu_dominio.com
sudo cp /etc/letsencrypt/live/seu_dominio.com/fullchain.pem deploy/certs/
sudo cp /etc/letsencrypt/live/seu_dominio.com/privkey.pem deploy/certs/
# editar deploy/nginx.conf trocando seu_dominio.com
npm run docker:up
npm run docker:logs
```

## VPS (PM2 sem Docker)
```bash
npm ci --omit=dev
npm run pm2:start
pm2 save && pm2 startup
```

## Smoke test pós-deploy
```bash
node scripts/smoke-test.js https://seu_dominio.com
```

## Checklist DEPLOY final
- [ ] `/healthz` retorna 200
- [ ] `/readyz` retorna 200 (Postgres conectado)
- [ ] `/api/health` mostra `version: "5.0.0"`, `demo: false`, `postgres: true`
- [ ] Login com admin funciona
- [ ] WebSocket conecta (DevTools → Network → ws)
- [ ] HTTPS obrigatório (HTTP redireciona)
- [ ] CORS bloqueia origem não-listada
- [ ] Rate-limit ativo (>120 req/min → 429)
- [ ] Logs estruturados sendo gravados
- [ ] Backup do Postgres agendado

## Checklist BACKUP
- [ ] `scripts/backup-postgres.sh` no cron diário 03:00
- [ ] Retenção 30 dias local
- [ ] Cópia semanal para S3/B2/R2
- [ ] `.env.production` em cofre (1Password/Bitwarden/SOPS)
- [ ] `secrets.generated.json` em cofre + apagado da máquina local
- [ ] Snapshot do volume `pgdata` semanal
- [ ] Restore drill mensal em staging

## Rollback
```bash
# Docker
docker compose -f deploy/docker-compose.yml down
git checkout <commit-anterior>
npm run docker:up

# PM2
pm2 reload robotrend-ia --update-env
```

## Riscos críticos resolvidos
- ✅ JWT_SECRET forte obrigatório
- ✅ admin123 bloqueado em produção
- ✅ DEMO_MODE bloqueado em produção
- ✅ PostgreSQL obrigatório (sem in-memory silencioso)
- ✅ CORS restrito por ALLOWED_ORIGINS
- ✅ Socket.IO com mesmo allow-list
- ✅ Senha Postgres via variável (sem hardcode)

## Pendentes (não-bloqueantes)
- [ ] Email transacional (Resend/SendGrid)
- [ ] CSP sem `unsafe-inline` (remover Tailwind CDN, fazer build)
- [ ] Testes automatizados (jest/vitest)
- [ ] CI: `npm audit` + lint + smoke-test
- [ ] Logrotate ou Pino transport para logs/
