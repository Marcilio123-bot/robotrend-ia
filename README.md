# 🤖 Robotrend IA · v5.0.0 SaaS · Bet365 Edition

**Plataforma profissional de sinais esportivos** com autenticação, planos SaaS (FREE/VIP/PREMIUM), pagamentos (Stripe + Mercado Pago + PIX), painel admin, PWA, Docker e ML-ready.

> Stack: Node.js · Express · Socket.io · Tailwind · PostgreSQL · JWT · bcrypt · helmet · Stripe · Mercado Pago · Service Worker

---

## 🚀 Quickstart (1 minuto)

```bash
cd C:\sites\Robotrend
npm install
npm start
```

Acesse: **http://localhost:3010**

Admin pré-criado: `admin@robotrend.local` / `admin123` (troque em produção!)

---

## ✨ Novidades v5.0.0 SaaS

### FASE 1 — Hardening (produção)
- `backend/startup-check.js` — fail-fast: PG obrigatório, JWT/SESSION fortes, sem `DEMO_MODE`, sem senha `admin123`
- `ALLOWED_ORIGINS` — CORS e Socket.IO restritos (sem `origin: '*'`)
- `.env.production` / `.env.staging` / `.env.example` atualizados
- `npm run secrets:generate` — gera JWT, SESSION e POSTGRES_PASSWORD
- `npm run backup:phase1` — backup local sem `node_modules`

## ✨ Recursos v3–v5 SaaS

### 🔐 Autenticação completa
- Login / registro / logout
- JWT (token via header / cookie / query)
- bcryptjs (pure-JS, sem build nativo)
- Recuperação de senha com token TTL 30 min
- Rate-limit em rotas de auth (10 req/min)
- Admin bootstrap automático no boot

### 💳 SaaS multi-tier
- **FREE** — 3 sinais/dia, live + BTTS básico
- **VIP** (R$ 49,90/mês) — 30 sinais/dia, pré-live, Over 2.5, alertas Telegram
- **PREMIUM** (R$ 199,99/mês — promo de R$ 499,99) — sinais ilimitados, API REST, histórico 1 ano
- Middleware `requireFeature('prelive')` e `dailySignalLimiter` automáticos

### 💰 Pagamentos
- **Stripe** (assinatura recorrente)
- **Mercado Pago** (Pix/Boleto/Cartão)
- **PIX estático** (BR Code gerado sem provider, com QR via qrserver.com)
- Webhooks em `/api/payments/webhook/{mp,stripe}`
- Modo mock para dev (ativa plano sem cobrar)

### 👑 Admin Panel
- Overview com KPIs (usuários, pagantes, receita, sinais, winrate)
- Lista de usuários com edição inline (plano/role)
- Lista de pagamentos
- Lista de sinais recentes
- Rota protegida por `requireAdmin`

### 🧠 IA ML-ready
- **Pesos por liga** (Premier League 1.08 · Libertadores 0.97 · etc)
- **Pesos por minuto** (60-74' = janela de ouro, multiplicador 1.12)
- **Anti-Fake-Pressure** (detecta picos artificiais sem chutes/escanteios)
- **Confiabilidade da partida** (matchReliability 0.2–1.0)
- **Autotune** do SIGNAL_MIN_SCORE conforme winrate histórico
- Pronto para substituir por modelo treinado (lightgbm/onnx)

### 🛡️ Segurança
- helmet (CSP customizado para Tailwind CDN + Google Fonts)
- express-rate-limit (120 req/min geral, 10/min auth)
- Validação leve embutida (sem libs externas)
- Sanitização básica
- HTTPS-ready via nginx

### 📲 PWA
- `manifest.json` com ícones SVG
- Service Worker com cache offline + push API
- Install prompt nativo (botão "📲 Instalar")
- Notificações desktop + push

### 🐳 Deploy (`deploy/`)
- `deploy/Dockerfile` (multi-stage, node:20-alpine)
- `deploy/docker-compose.yml` (app + postgres + nginx)
- `deploy/ecosystem.config.js` (PM2)
- `deploy/nginx.conf` (SSL + WebSocket)
- `deploy/certs/` (fullchain.pem + privkey.pem)

---

## 📂 Estrutura completa

```
Robotrend/
├── backend/
│   ├── server.js          ← Express + Socket.io + bootstrap admin
│   ├── auth.js            ← JWT + bcryptjs + register/login/reset
│   ├── plans.js           ← FREE/VIP/PREMIUM + middlewares
│   ├── payments.js        ← Stripe + MP + PIX + webhooks
│   ├── admin.js           ← rotas admin (users, payments, signals)
│   ├── ml.js              ← weights/liga, anti-fake, autotune
│   ├── security.js        ← helmet + rate-limit + validação
│   ├── database.js        ← users, subs, payments, signals (PG + memória)
│   ├── bot.js             ← orquestrador (live + prelive + ML)
│   ├── analyzer.js        ← motor IA (score + risco + odd)
│   ├── corners.js         ← escanteios + momentum + HOT/WARM/COLD/DANGER
│   ├── btts.js            ← BTTS + Over 2.5 + histórico visual
│   ├── live.js            ← scanner ao vivo (demo + API-Football)
│   ├── prelive.js         ← scanner pré-live (BTTS)
│   └── telegram.js        ← mensagens ultra premium
├── frontend/
│   ├── index.html         ← painel principal (auth-protected)
│   ├── login.html         ← login
│   ├── register.html      ← cadastro
│   ├── forgot.html        ← esqueci a senha
│   ├── reset.html         ← redefinir senha
│   ├── pricing.html       ← planos + checkout (Stripe/MP/PIX)
│   ├── admin.html         ← painel admin
│   ├── manifest.json      ← PWA manifest
│   ├── service-worker.js  ← cache offline + push
│   ├── style.css          ← tokens CSS + temas dark/light + glassmorphism
│   └── js/
│       ├── auth.js        ← lib auth client (token, login, register)
│       ├── dashboard.js   ← realtime + tema + som + notif
│       ├── admin.js       ← admin client
│       └── pwa.js         ← SW registration + install prompt
├── .env.example           ← template dev
├── .env.production        ← template produção (gitignored)
├── .env.staging           ← template staging (gitignored)
├── package.json           ← v5.0.0
├── README.md              ← este arquivo
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── ecosystem.config.js
│   ├── nginx.conf
│   └── certs/
├── scripts/
│   ├── backup-phase1.js
│   ├── generate-secrets.js
│   └── win/INSTALAR.bat, INICIAR.bat
├── INSTALAR.bat / INICIAR.bat  ← atalhos na raiz
├── docs/FASE1-PLANO.md
└── .dockerignore / .gitignore
```

---

## 🔌 Endpoints REST

### Públicos
| Método | Rota | Descrição |
|---|---|---|
| GET  | `/api/health` | status servidor |
| GET  | `/api/matches` | partidas live (snapshot) |
| GET  | `/api/plans` | lista de planos |
| POST | `/api/auth/register` | criar conta |
| POST | `/api/auth/login` | autenticar |
| POST | `/api/auth/logout` | encerrar sessão |
| POST | `/api/auth/forgot` | solicitar reset |
| POST | `/api/auth/reset` | redefinir senha com token |

### Autenticados (JWT obrigatório)
| Método | Rota | Plano mínimo |
|---|---|---|
| GET  | `/api/auth/me` | qualquer |
| POST | `/api/auth/change-password` | qualquer |
| GET  | `/api/signals?limit=N` | qualquer |
| GET  | `/api/stats` | qualquer |
| GET  | `/api/prelive` | VIP |
| POST | `/api/signals/test` | qualquer |
| POST | `/api/payments/checkout` | qualquer (escolhe plan) |

### Admin
| Método | Rota |
|---|---|
| GET   | `/api/admin/overview` |
| GET   | `/api/admin/users` |
| PATCH | `/api/admin/users/:id` |
| GET   | `/api/admin/payments` |
| GET   | `/api/admin/signals` |
| POST  | `/api/signals/:id/result` (win/loss) |

---

## 🐳 Deploy Docker

### Local com docker-compose
```bash
npm run docker:up
npm run docker:logs
npm run docker:down
```
Ou: `docker compose -f deploy/docker-compose.yml --env-file .env up -d --build`
Acesse: `http://localhost:3010` ou `https://seu_dominio.com` via nginx.

### Render / Railway / Fly.io
1. Suba o repo no GitHub.
2. Configure as variáveis de ambiente.
3. Use a config Node 20+ apontando para `npm start`.

### VPS com PM2
```bash
npm install --omit=dev
npm run pm2:start
pm2 save && pm2 startup
```

### SSL com nginx + Let's Encrypt
```bash
# Coloque seus certs em deploy/certs/{fullchain,privkey}.pem
npm run docker:up
# Ou no host:
sudo certbot --nginx -d seu_dominio.com
```

---

## 🔑 Variáveis principais do `.env`

```env
# Auth
JWT_SECRET=...                      # use openssl rand -hex 64
BOOTSTRAP_ADMIN_EMAIL=admin@robotrend.local
BOOTSTRAP_ADMIN_PASSWORD=admin123

# Planos
PLAN_VIP_PRICE_BRL=49.90
PLAN_PREMIUM_PRICE_BRL=199.99
PLAN_PREMIUM_FULL_PRICE_BRL=499.99

# Pagamentos (opcionais)
STRIPE_SECRET_KEY=
MP_ACCESS_TOKEN=
PIX_KEY=

# APIs (opcionais)
API_FOOTBALL_KEY=
ODDS_API_KEY=
TELEGRAM_BOT_TOKEN=

# DB (opcional — fallback memória)
DATABASE_URL=

# IA
DEMO_MODE=true
ANTI_FAKE_PRESSURE=true
ML_AUTOTUNE=true
SIGNAL_MIN_SCORE=80
```

---

## 🗺️ Roadmap

- [ ] Email transacional real (Resend/SendGrid) para reset & welcome
- [ ] OAuth Google/Telegram login
- [ ] Backtesting histórico com export CSV
- [ ] Bot Telegram interativo (`/login`, `/myroi`)
- [ ] Multi-tenant white-label
- [ ] Push notifications via web-push (VAPID)
- [ ] Modelo lightgbm exportado para onnxruntime-node
- [ ] App mobile React Native (compartilhando API REST)
- [ ] Integração WhatsApp Business

---

**Robotrend IA · v5.0.0 SaaS · Bet365 Edition** · pronto para vender assinaturas. 🚀
