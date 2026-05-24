/**
 * Robotrend IA — Pagamentos
 *
 *   - Stripe (assinatura recorrente)
 *   - Mercado Pago (PIX/Checkout)
 *   - PIX estático (BR Code) — gera QR sem provider
 *
 * Em modo DEV (sem chaves) gera links/mocks para teste do fluxo.
 */

'use strict';

const crypto = require('crypto');
const { getPlan } = require('./plans');
const auth = require('./auth');
const onboarding = require('./onboarding');
const mp = require('./services/mercadopago');
const { logger } = require('./logger');
const log = logger.child({ module: 'payments' });

let Stripe;
try { Stripe = require('stripe'); } catch (e) { Stripe = null; }

const stripeClient = Stripe && process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* ============================================================
   APP_URL — usado nas back_urls e notification_url do checkout
   PUBLIC_URL é mantido como fallback (compat com env antigo)
   ============================================================ */
function appUrl() {
  try {
    const { resolvePublicBaseUrl, envString } = require('./startup-check');
    const resolved = resolvePublicBaseUrl();
    if (resolved) return resolved;
    const app = envString('APP_URL');
    const pub = envString('PUBLIC_URL');
    if (app) return app;
    if (pub) return pub;
  } catch (_) { /* fallback abaixo */ }
  const app = (process.env.APP_URL || '').trim();
  const pub = (process.env.PUBLIC_URL || '').trim();
  const render = (process.env.RENDER_EXTERNAL_URL || '').trim();
  return app || pub || render || 'http://localhost:3010';
}

/**
 * Mercado Pago exige que back_urls.success seja uma URL PÚBLICA acessível
 * quando auto_return='approved' é definido. Em localhost/IPs privados o MP
 * retorna: "auto_return invalid. back_url.success must be defined".
 *
 * Esta função retorna true se a APP_URL é pública (HTTPS + domínio público).
 */
function isPublicAppUrl() {
  const url = appUrl();
  try {
    const u = new URL(url);
    // Bloqueia localhost, 127.x, 0.0.0.0, IPs privados conhecidos
    if (
      u.hostname === 'localhost' ||
      u.hostname === '0.0.0.0' ||
      u.hostname.startsWith('127.') ||
      u.hostname.startsWith('192.168.') ||
      u.hostname.startsWith('10.') ||
      u.hostname.startsWith('172.16.') ||
      /\.local$/i.test(u.hostname)
    ) {
      return false;
    }
    // MP exige HTTPS para auto_return em produção
    if (u.protocol !== 'https:') return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Constrói back_urls + auto_return compatíveis com Mercado Pago.
 * Em ambientes locais (sem HTTPS público), omite auto_return — caso contrário,
 * o MP recusa a criação da preference.
 */
function buildBackUrls(extra = '') {
  const base = appUrl();
  return {
    success: `${base}/billing/success${extra}`,
    pending: `${base}/billing/pending${extra}`,
    failure: `${base}/billing/failure${extra}`,
  };
}

/* ============================================================
   STRIPE — checkout session p/ assinatura
   ============================================================ */
async function createStripeCheckout({ user, plan, _planOverride }) {
  const def = _planOverride || getPlan(plan);
  if (!stripeClient) {
    return mockCheckout('stripe', user, def);
  }
  const priceId = plan === 'VIP'
    ? process.env.STRIPE_PRICE_VIP
    : process.env.STRIPE_PRICE_PREMIUM;
  if (!priceId) throw new Error('STRIPE_PRICE_* não configurado');

  const session = await stripeClient.checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { userId: user.id, plan },
    success_url: `${process.env.PUBLIC_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${process.env.PUBLIC_URL}/pricing.html?canceled=1`,
  });
  return { provider: 'stripe', url: session.url, externalId: session.id };
}

/* ============================================================
   MERCADO PAGO — preferência de pagamento (Pix/Boleto/Cartão)
   ============================================================ */
async function createMercadoPagoCheckout({ user, plan, _planOverride }) {
  const def = _planOverride || getPlan(plan);
  if (!mp.enabled) {
    return mockCheckout('mercadopago', user, def);
  }
  const pref = mp.preference();
  const base = appUrl();
  const body = {
    items: [{
      title: `Robotrend ${def.label}`,
      quantity: 1,
      unit_price: Number(def.priceBRL),
      currency_id: 'BRL',
    }],
    payer: { email: user.email },
    back_urls: buildBackUrls('?provider=mp'),
    external_reference: `${user.id}:${plan}`,
    notification_url: `${base}/api/payments/webhook`,
    statement_descriptor: 'ROBOTREND IA',
  };
  // auto_return só funciona com URLs PÚBLICAS HTTPS — em dev/local omitir
  // evita o erro "auto_return invalid. back_url.success must be defined".
  if (isPublicAppUrl()) {
    body.auto_return = 'approved';
  }
  const created = await pref.create({ body });
  return { provider: 'mercadopago', url: created.init_point, externalId: created.id };
}

/* ============================================================
   PIX ESTÁTICO — BR Code (sem provider necessário)
   ============================================================ */
function generatePixStatic({ amount, txid, key, name, city }) {
  const pad = (id, value) => {
    const len = String(value).length.toString().padStart(2, '0');
    return `${id}${len}${value}`;
  };
  const merchant = [
    pad('00', 'BR.GOV.BCB.PIX'),
    pad('01', key),
  ].join('');
  const root = [
    pad('00', '01'),
    pad('26', merchant),
    pad('52', '0000'),
    pad('53', '986'),
    pad('54', Number(amount).toFixed(2)),
    pad('58', 'BR'),
    pad('59', (name || 'ROBOTREND').slice(0, 25)),
    pad('60', (city || 'SAO PAULO').slice(0, 15)),
    pad('62', pad('05', txid || 'ROBOTREND')),
  ].join('');

  // CRC16 CCITT
  const data = root + '6304';
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  const crcHex = crc.toString(16).toUpperCase().padStart(4, '0');
  return data + crcHex;
}

function createPixPayment({ user, plan, _planOverride }) {
  const def = _planOverride || getPlan(plan);
  if (!process.env.PIX_KEY) {
    return {
      provider: 'pix',
      mock: true,
      message: 'Configure PIX_KEY no .env para gerar QR Code real.',
      amount: def.priceBRL,
    };
  }
  const txid = `RT${Date.now().toString(36).toUpperCase()}`;
  const code = generatePixStatic({
    amount: def.priceBRL,
    txid,
    key: process.env.PIX_KEY,
    name: process.env.PIX_MERCHANT_NAME,
    city: process.env.PIX_MERCHANT_CITY,
  });
  // QR via API pública (qrserver.com) — também pode-se usar lib local
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(code)}`;
  return {
    provider: 'pix',
    amount: def.priceBRL,
    plan,
    code,
    qrUrl,
    txid,
    instructions: 'Pague via PIX usando o QR Code ou copie o código.',
  };
}

/* ============================================================
   MOCK (dev sem chaves)
   ============================================================ */
function mockCheckout(provider, user, plan) {
  const fakeId = 'mock_' + crypto.randomBytes(6).toString('hex');
  return {
    provider, mock: true,
    url: `${process.env.PUBLIC_URL || ''}/billing/mock-success?provider=${provider}&plan=${plan.id}&user=${user.id}`,
    externalId: fakeId,
    amount: plan.priceBRL,
    message: `Modo MOCK — configure ${provider.toUpperCase()} keys no .env para pagamentos reais.`,
  };
}

/* ============================================================
   PROVISIONING — cria/atualiza user automaticamente após pagamento
   --------------------------------------------------
   Centraliza a lógica usada por todos os webhooks (Stripe, MP, PIX,
   /webhook/payment-success genérico). Idempotente: se já existir
   um user com aquele email, apenas atualiza o plano/role.
   ============================================================ */
function generateInitialPassword() {
  // 12 chars, mix de letras+números (legível, sem ambíguos como 0/O/l/1)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const buf = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function planToRole(plan) {
  const p = String(plan || '').toUpperCase();
  if (p === 'PREMIUM' || p === 'VIP' || p === 'PRO') return 'premium';
  return 'user';
}

/**
 * provisionUserFromPayment
 *  Cria (ou atualiza) um usuário a partir dos dados do pagamento aprovado.
 *
 * @param {object} db
 * @param {object} payload
 *   - email     (obrigatório)
 *   - plan      (FREE|VIP|PREMIUM)  default PREMIUM
 *   - name      opcional
 *   - provider  stripe|mercadopago|pix|manual
 *   - externalId  ID do pagamento no provider
 *   - amount    valor pago em BRL
 *   - status    approved (espera-se)
 *
 * @returns { created, user, password (apenas se created), subscription }
 */
async function provisionUserFromPayment(db, payload) {
  const { email, plan = 'PREMIUM', name, provider = 'manual', externalId, amount, status } = payload || {};
  if (!email) throw new Error('email obrigatório no webhook');
  if (status && status !== 'approved' && status !== 'paid' && status !== 'completed') {
    log.info('webhook ignorado — status não aprovado', { status, email });
    return { created: false, ignored: true, reason: `status=${status}` };
  }

  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const safePlan = ['FREE', 'VIP', 'PREMIUM'].includes(String(plan).toUpperCase())
    ? String(plan).toUpperCase()
    : 'PREMIUM';
  const role = planToRole(safePlan);

  let user = await db.findUserByEmail(normalizedEmail);
  let created = false;
  let initialPassword = null;

  if (!user) {
    initialPassword = generateInitialPassword();
    const passwordHash = await auth.hashPassword(initialPassword);
    user = await db.createUser({
      email: normalizedEmail,
      name: name || normalizedEmail.split('@')[0],
      passwordHash,
      plan: safePlan,
      role,
    });
    created = true;
    log.info('user provisioned via payment', {
      userId: user.id, email: normalizedEmail, plan: safePlan, provider, externalId,
    });
  } else {
    // User já existe → apenas upgrade de plano/role (não baixa nível existente)
    const patch = {};
    if (user.plan !== safePlan)            patch.plan = safePlan;
    if (user.role !== 'admin' && user.role !== role) patch.role = role;
    if (Object.keys(patch).length) {
      user = await db.updateUser(user.id, patch);
      log.info('user upgraded via payment', {
        userId: user.id, email: normalizedEmail, patch, provider, externalId,
      });
    }
  }

  // Subscription
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 dias padrão
  let subscription = null;
  try {
    subscription = await db.upsertSubscription(user.id, {
      plan: safePlan,
      provider,
      externalId: externalId || null,
      status: 'active',
      expiresAt,
    });
  } catch (err) {
    log.warn('upsertSubscription falhou', { err: err.message });
  }

  // Payment record (auditoria)
  try {
    await db.savePayment({
      userId: user.id,
      provider,
      amount: amount || 0,
      plan: safePlan,
      externalId: externalId || null,
      status: 'paid',
      raw: { ...payload, provisionedAt: new Date().toISOString() },
    });
  } catch (err) {
    log.warn('savePayment falhou', { err: err.message });
  }

  // Welcome email + tracking (não bloqueia se falhar)
  if (created) {
    onboarding.welcomeEmail({ ...user, initialPassword }).catch((err) =>
      log.warn('welcome email falhou', { err: err.message })
    );
    onboarding.track('payment_signup', {
      userId: user.id, email: user.email, plan: safePlan, provider,
    });
  } else {
    onboarding.track('payment_upgrade', {
      userId: user.id, email: user.email, plan: safePlan, provider,
    });
    // Notifica sockets abertos desse user (sem precisar deslogar/relogar)
    try {
      if (typeof _emitToUser === 'function') {
        _emitToUser(user.id, 'user:upgraded', {
          plan: safePlan,
          role,
          provider,
          at: new Date().toISOString(),
        });
      }
    } catch (_) { /* fallback silencioso */ }
  }

  const { passwordHash, resetToken, resetTokenExpires, ...safeUser } = user;
  return {
    ok: true,
    created,
    user: safeUser,
    password: created ? initialPassword : null,
    subscription,
  };
}

/* ============================================================
   IDEMPOTÊNCIA — cache em memória de payment.ids já processados
   ------------------------------------------------------------
   MP pode reentregar a mesma notificação várias vezes (timeout,
   rede, política de retries). Antes de processar, verificamos:

     1) memCache (LRU rápido) — bloqueia reentregas em segundos
     2) db.findPaymentByExternalId (durável) — sobrevive a restart

   Após confirmar `approved` com sucesso, marcamos no cache.
   ============================================================ */
const PROCESSED_PAYMENTS = new Map(); // paymentId -> processedAt(ms)
const PROCESSED_TTL_MS = 24 * 3600 * 1000; // 24h
const PROCESSED_MAX = 5000;
const INFLIGHT_PAYMENTS = new Map(); // paymentId -> Promise (lock)

function markProcessed(paymentId) {
  if (!paymentId) return;
  const key = String(paymentId);
  PROCESSED_PAYMENTS.set(key, Date.now());
  if (PROCESSED_PAYMENTS.size > PROCESSED_MAX) {
    // LRU eviction simples — descarta o mais antigo
    const oldest = PROCESSED_PAYMENTS.keys().next().value;
    PROCESSED_PAYMENTS.delete(oldest);
  }
}

function wasRecentlyProcessed(paymentId) {
  if (!paymentId) return false;
  const ts = PROCESSED_PAYMENTS.get(String(paymentId));
  if (!ts) return false;
  if (Date.now() - ts > PROCESSED_TTL_MS) {
    PROCESSED_PAYMENTS.delete(String(paymentId));
    return false;
  }
  return true;
}

/**
 * Lock por payment.id — garante que apenas UMA execução de processamento
 * roda por vez para o mesmo paymentId. Se outra entrega chegar enquanto
 * a primeira ainda roda, esperamos o resultado da primeira.
 *
 * @param {string} paymentId
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function withPaymentLock(paymentId, fn) {
  const key = String(paymentId);
  const inflight = INFLIGHT_PAYMENTS.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    try { return await fn(); }
    finally { INFLIGHT_PAYMENTS.delete(key); }
  })();
  INFLIGHT_PAYMENTS.set(key, promise);
  return promise;
}

/* ============================================================
   Closure module-level p/ permitir provisionUserFromPayment
   acessar emitToUser sem mudar assinatura.
   buildPaymentRoutes() captura app.locals.emitToUser aqui.
   ============================================================ */
let _emitToUser = null;

/* ============================================================
   ROUTES
   ============================================================ */
function buildPaymentRoutes(app, db, requireAuth) {
  // captura helper de socket emit (definido em server.js)
  _emitToUser = (uid, ev, payload) => {
    try {
      const fn = app?.locals?.emitToUser;
      if (typeof fn === 'function') return fn(uid, ev, payload);
    } catch (_) {}
    return 0;
  };
  app.get('/api/plans', (req, res) => {
    const { listPlans } = require('./plans');
    res.json({ plans: listPlans() });
  });

  // Status do gateway (útil pro frontend exibir badge "ativo"/"mock")
  app.get('/api/payments/status', (req, res) => {
    res.json({
      mercadopago: { enabled: mp.enabled, publicKey: mp.publicKey || null },
      stripe: { enabled: Boolean(stripeClient) },
      pix: { enabled: Boolean(process.env.PIX_KEY) },
      appUrl: appUrl(),
    });
  });

  /* ============================================================
     POST /api/payments/create-premium
     ------------------------------------------------------------
     Cria preference Mercado Pago para o plano Premium e retorna
     a init_point (URL do checkout). Cliente redireciona p/ ela.

     Auth: requireAuth — usuário logado obrigatório.
     external_reference: <userId> — chave que o webhook usa para
     identificar o cliente quando MP confirmar o pagamento.

     Body opcional: { plan: 'PREMIUM'|'VIP', coupon? }
     ============================================================ */
  app.post('/api/payments/create-premium', requireAuth(db), async (req, res) => {
    try {
      const user = req.user;
      const requestedPlan = (req.body?.plan || 'PREMIUM').toUpperCase();
      const plan = ['PREMIUM', 'VIP'].includes(requestedPlan) ? requestedPlan : 'PREMIUM';
      const def = getPlan(plan);

      if (!mp.enabled) {
        log.warn('create-premium chamado sem MP configurado — retornando mock');
        const m = mockCheckout('mercadopago', user, def);
        return res.json({
          ok: true,
          mock: true,
          init_point: m.url,
          provider: 'mercadopago',
          message: 'Modo MOCK: configure MP_ACCESS_TOKEN no .env para pagamentos reais.',
        });
      }

      // Aplica cupom se enviado
      let finalAmount = Number(def.priceBRL);
      let appliedCoupon = null;
      if (req.body?.coupon) {
        try {
          const beta = require('./beta');
          const r = beta.applyCoupon(req.body.coupon, plan, finalAmount);
          if (r.ok) {
            finalAmount = r.finalPrice;
            appliedCoupon = r.coupon.code;
            beta.commitCoupon(r.coupon.code);
          }
        } catch (_) { /* cupom inválido — ignora silenciosamente */ }
      }

      const base = appUrl();
      const idempotencyKey = `premium-${user.id}-${Date.now()}`;
      const pref = mp.preference();
      const prefBody = {
        items: [{
          id: `plan-${plan.toLowerCase()}`,
          title: `Plano ${def.label} - Robotrend IA`,
          description: `Assinatura mensal Robotrend IA · plano ${def.label}`,
          quantity: 1,
          unit_price: finalAmount,
          currency_id: 'BRL',
          category_id: 'services',
        }],
        payer: { email: user.email, name: user.name || undefined },
        back_urls: buildBackUrls(`?provider=mp&plan=${plan}`),
        // external_reference identifica o user no webhook (formato: userId:plan)
        external_reference: `${user.id}:${plan}`,
        notification_url: `${base}/api/payments/webhook`,
        statement_descriptor: 'ROBOTREND IA',
        metadata: {
          userId: user.id,
          plan,
          coupon: appliedCoupon || null,
        },
      };
      // auto_return só com APP_URL público HTTPS (evita erro do MP em dev/local)
      if (isPublicAppUrl()) {
        prefBody.auto_return = 'approved';
      } else {
        log.warn('APP_URL não é público HTTPS — auto_return omitido para evitar erro MP', {
          appUrl: base,
        });
      }
      const created = await pref.create({
        body: prefBody,
        requestOptions: { idempotencyKey },
      });

      // Registra payment como 'pending' para auditoria
      try {
        await db.savePayment({
          userId: user.id,
          provider: 'mercadopago',
          amount: finalAmount,
          plan,
          externalId: created.id || null,
          status: 'pending',
          raw: { preferenceId: created.id, coupon: appliedCoupon, finalAmount, originalAmount: def.priceBRL },
        });
      } catch (err) {
        log.warn('savePayment pending falhou', { err: err.message });
      }

      log.info('preference Mercado Pago criada', {
        userId: user.id, email: user.email, plan, finalAmount,
        preferenceId: created.id,
      });

      // Retorna init_point (link do checkout) + sandbox p/ testes
      res.json({
        ok: true,
        init_point: created.init_point,
        sandbox_init_point: created.sandbox_init_point,
        preferenceId: created.id,
        plan,
        amount: finalAmount,
        coupon: appliedCoupon,
      });
    } catch (err) {
      log.error('create-premium falhou', { err: err.message, stack: err.stack });
      res.status(500).json({ error: err.message || 'Falha ao criar checkout' });
    }
  });

  app.post('/api/payments/checkout', requireAuth(db), async (req, res) => {
    try {
      const { plan, provider, coupon } = req.body || {};
      if (!['VIP', 'PREMIUM'].includes(plan)) return res.status(400).json({ error: 'plan inválido' });

      const user = req.user;
      const def = getPlan(plan);
      let finalAmount = def.priceBRL;
      let appliedCoupon = null;
      if (coupon) {
        const beta = require('./beta');
        const r = beta.applyCoupon(coupon, plan, def.priceBRL);
        if (r.ok) {
          finalAmount = r.finalPrice;
          appliedCoupon = r.coupon.code;
          beta.commitCoupon(r.coupon.code);
        }
      }

      // injetar amount nas funções via env override simples
      const planWithDiscount = { ...def, priceBRL: finalAmount };

      let result;
      if (provider === 'stripe')           result = await createStripeCheckout({ user, plan, _planOverride: planWithDiscount });
      else if (provider === 'mercadopago') result = await createMercadoPagoCheckout({ user, plan, _planOverride: planWithDiscount });
      else if (provider === 'pix')         result = createPixPayment({ user, plan, _planOverride: planWithDiscount });
      else return res.status(400).json({ error: 'provider inválido (stripe|mercadopago|pix)' });

      await db.savePayment({
        userId: user.id, provider, amount: finalAmount,
        plan, externalId: result.externalId, status: 'pending',
        raw: { ...result, coupon: appliedCoupon, originalAmount: def.priceBRL },
      });

      res.json({ ...result, coupon: appliedCoupon, finalAmount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     WEBHOOK GENÉRICO — POST /webhook/payment-success
     ------------------------------------------------------------
     Endpoint unificado para qualquer integração externa
     (Mercado Pago, Stripe, PIX manual, gateway custom).

     Body esperado:
       {
         email:    "cliente@email.com",   // obrigatório
         plan:     "PREMIUM" | "VIP",
         name:     "Nome Cliente",         // opcional
         provider: "stripe" | "mercadopago" | "pix" | "manual",
         externalId: "evt_xxx",
         amount:   199.99,
         status:   "approved"              // só processa se aprovado
       }

     Segurança:
       Validado por header X-Webhook-Secret (env WEBHOOK_SECRET).
       Em dev (sem secret) aceita qualquer chamada.

     Resposta:
       { ok, created, user, password (apenas se criou), subscription }
     ============================================================ */
  app.post('/webhook/payment-success', async (req, res) => {
    try {
      const secret = process.env.WEBHOOK_SECRET;
      if (secret) {
        const got = req.headers['x-webhook-secret'] || req.query.secret;
        if (got !== secret) {
          log.warn('webhook secret mismatch', { ip: req.ip });
          return res.status(401).json({ error: 'webhook secret inválido' });
        }
      }
      const result = await provisionUserFromPayment(db, req.body || {});
      res.json(result);
    } catch (err) {
      log.error('webhook /webhook/payment-success falhou', { err: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  /* ============================================================
     WEBHOOK Mercado Pago — POST /api/payments/webhook
     ------------------------------------------------------------
     ÚNICA fonte de verdade para ativar PREMIUM. Frontend NUNCA
     decide o plano — apenas o webhook (que consulta o pagamento
     direto no Mercado Pago) pode promover o usuário.

     MP envia notificações em 2 formatos:
       1) IPN/v1:  POST  ...?topic=payment&id=12345
       2) v2:      POST com body { type:'payment', data:{ id:'12345' } }

     Fluxo:
       1. Extrai payment.id de query OU body
       2. Consulta MP API: payment.get({ id })
       3. Se status === 'approved':
          - parseia external_reference → "userId:plan"
          - busca user por id (fallback por email)
          - atualiza user.plan='PREMIUM' (ou plan recebido), user.role='premium'
          - cria subscription ativa + payment record
       4. Retorna SEMPRE HTTP 200 (MP reenvia se receber 5xx)
     ============================================================ */
  async function handleMercadoPagoWebhook(req, res) {
    // Resposta IMEDIATA (200) — MP exige < 22s e reenvia se falhar.
    // Processamos async; logamos qualquer erro mas nunca devolvemos 5xx.
    res.status(200).send('ok');

    // Extrai paymentId ANTES de qualquer lock (para usar como chave)
    let earlyPaymentId = null;
    try {
      const b = req.body || {};
      const q = req.query || {};
      earlyPaymentId = b.data?.id
        || (typeof b.resource === 'string' ? b.resource.split('/').pop() : null)
        || q.id || q['data.id']
        || (b.action && b.id);
    } catch (_) {}

    // Lock por payment.id — evita corrida quando MP envia múltiplas
    // notificações simultâneas para o mesmo pagamento.
    return withPaymentLock(earlyPaymentId || `req-${Date.now()}`, async () => {
    try {
      const body = req.body || {};
      const query = req.query || {};
      const type = body.type || query.type || query.topic;
      const paymentId =
           body.data?.id
        || body.resource?.split?.('/').pop()
        || query.id
        || query['data.id']
        || (body.action && body.id);

      log.info('webhook MP recebido', { type, paymentId, action: body.action });

      // Só nos interessam notificações de pagamento (ignora merchant_order, plan, etc)
      if (type && !String(type).startsWith('payment')) {
        log.debug('webhook MP ignorado (não-payment)', { type });
        return;
      }
      if (!paymentId) {
        log.warn('webhook MP sem paymentId', { body, query });
        return;
      }
      if (!mp.enabled) {
        log.warn('webhook MP chegou mas service desabilitado — verifique MP_ACCESS_TOKEN');
        return;
      }

      // ===== IDEMPOTÊNCIA NÍVEL 1: cache em memória =====
      if (wasRecentlyProcessed(paymentId)) {
        log.debug('webhook MP ignorado — payment já processado (cache)', { paymentId });
        return;
      }

      // ===== IDEMPOTÊNCIA NÍVEL 2: registro no DB =====
      // Se já existe um payment com status 'paid' no banco, é reentrega.
      try {
        const existing = await db.findPaymentByExternalId(paymentId, 'mercadopago');
        if (existing && existing.status === 'paid') {
          log.info('webhook MP ignorado — payment já marcado paid no DB', { paymentId });
          markProcessed(paymentId);
          return;
        }
      } catch (err) {
        log.warn('findPaymentByExternalId falhou (ignorando, segue fluxo)', { err: err.message });
      }

      // Consulta o pagamento direto no MP — ÚNICA fonte de verdade do status
      const pay = mp.payment();
      let paymentInfo;
      try {
        paymentInfo = await pay.get({ id: paymentId });
      } catch (err) {
        log.warn('MP fetch payment falhou', { paymentId, err: err.message });
        return;
      }

      const status = paymentInfo?.status;
      log.info('MP payment fetched', {
        paymentId,
        status,
        externalRef: paymentInfo?.external_reference,
        amount: paymentInfo?.transaction_amount,
      });

      if (status !== 'approved') {
        // Outros status: pending, in_process, rejected, refunded, cancelled, charged_back
        // Atualiza o registro de payment (se existir) mas NÃO promove o user.
        if (paymentInfo?.external_reference) {
          try {
            await db.savePayment({
              userId: (paymentInfo.external_reference.split(':')[0]) || null,
              provider: 'mercadopago',
              amount: paymentInfo.transaction_amount || 0,
              plan: (paymentInfo.external_reference.split(':')[1] || 'PREMIUM'),
              externalId: paymentInfo.id,
              status,
              raw: { mp: paymentInfo, webhookType: type },
            });
          } catch (_) { /* auditoria não-crítica */ }
        }
        return;
      }

      // ========== STATUS APPROVED — promove o usuário ==========
      const externalRef = paymentInfo.external_reference || '';
      const [userIdFromRef, planFromRef] = externalRef.split(':');
      const plan = (planFromRef || paymentInfo.metadata?.plan || 'PREMIUM').toUpperCase();

      // Tenta achar user por ID (mais confiável) e fallback por email
      let user = null;
      if (userIdFromRef) {
        user = await db.findUserById(userIdFromRef);
      }
      if (!user) {
        const email = paymentInfo.payer?.email || paymentInfo.metadata?.email;
        if (email) user = await db.findUserByEmail(String(email).toLowerCase());
      }

      if (!user) {
        // Usuário não existe → provisiona automaticamente (compra "ghost")
        log.warn('webhook approved mas user não encontrado — provisionando via email', {
          externalRef, email: paymentInfo.payer?.email,
        });
        const email = paymentInfo.payer?.email;
        if (!email) {
          log.error('webhook approved sem email do payer — impossível provisionar', { externalRef });
          return;
        }
        await provisionUserFromPayment(db, {
          email,
          plan,
          name: paymentInfo.payer?.first_name || null,
          provider: 'mercadopago',
          externalId: paymentInfo.id,
          amount: paymentInfo.transaction_amount,
          status: 'approved',
        });
        return;
      }

      // Usuário existe → UPGRADE PERSISTENTE (preserva admin)
      // Sempre faz updateUser, mesmo se já estiver PREMIUM, para garantir
      // que o registro reflita o último pagamento aprovado.
      const newRole = (user.role === 'admin' || user.role === 'owner')
        ? user.role
        : 'premium';
      const patch = { plan, role: newRole };
      let updatedUser;
      try {
        updatedUser = await db.updateUser(user.id, patch);
        log.info('user upgraded via webhook MP', {
          userId: user.id, email: user.email,
          before: { plan: user.plan, role: user.role },
          after: patch, paymentId,
        });
      } catch (err) {
        log.error('updateUser FALHOU no webhook — upgrade não persistiu!', {
          userId: user.id, err: err.message, paymentId,
        });
        throw err; // não marca como processado — MP vai reentregar
      }
      // Usa user atualizado nos passos seguintes
      user = updatedUser || { ...user, ...patch };

      // Subscription ativa por 30 dias
      try {
        await db.upsertSubscription(user.id, {
          plan,
          provider: 'mercadopago',
          externalId: String(paymentInfo.id),
          status: 'active',
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        });
      } catch (err) {
        log.warn('upsertSubscription falhou no webhook', { err: err.message });
      }

      // Payment record final
      try {
        await db.savePayment({
          userId: user.id,
          provider: 'mercadopago',
          amount: paymentInfo.transaction_amount || 0,
          plan,
          externalId: String(paymentInfo.id),
          status: 'paid',
          raw: {
            mp: paymentInfo,
            webhookType: type,
            confirmedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        log.warn('savePayment paid falhou', { err: err.message });
      }

      // Email de confirmação
      try {
        await onboarding.paymentReceivedEmail(user, {
          plan, amount: paymentInfo.transaction_amount,
        });
      } catch (err) {
        log.warn('email paymentReceived falhou', { err: err.message });
      }

      onboarding.track('paid', {
        userId: user.id, plan, amount: paymentInfo.transaction_amount,
        provider: 'mercadopago',
      });

      // ===== marca payment.id como totalmente processado =====
      markProcessed(paymentId);

      // ===== EMITE EVENTO REALTIME para o user específico =====
      // Frontend (auth-guard.js + dashboard.js) escuta `user:upgraded`,
      // refaz /api/auth/me e atualiza a UI sem precisar deslogar.
      try {
        const sent = _emitToUser(user.id, 'user:upgraded', {
          plan,
          role: newRole,
          paymentId: String(paymentInfo.id),
          amount: paymentInfo.transaction_amount,
          at: new Date().toISOString(),
        });
        log.info('user:upgraded emitido', { userId: user.id, plan, socketsNotified: sent });
      } catch (err) {
        log.warn('emitToUser falhou', { err: err.message });
      }

      log.info('✓ Premium ativado via webhook MP', {
        userId: user.id, email: user.email, plan, paymentId,
      });
    } catch (err) {
      // Já enviamos 200 acima — só logamos para análise posterior.
      log.error('webhook MP processing error', { err: err.message, stack: err.stack });
    }
    }); // fim withPaymentLock
  }

  app.post('/api/payments/webhook', handleMercadoPagoWebhook);
  // Alias legacy — MP foi configurado anteriormente com /webhook/mp
  app.post('/api/payments/webhook/mp', handleMercadoPagoWebhook);
  // Health-check em GET (alguns dashboards do MP fazem ping pra validar URL)
  app.get('/api/payments/webhook', (req, res) =>
    res.status(200).json({ ok: true, provider: 'mercadopago', method: 'POST-only para notificações' })
  );

  /* ============================================================
     WEBHOOK Stripe — POST /api/payments/webhook/stripe
     ------------------------------------------------------------
     Em produção: validar assinatura. Eventos relevantes:
       - checkout.session.completed   (assinatura criada)
       - invoice.paid                  (renovação)
     ============================================================ */
  app.post('/api/payments/webhook/stripe', async (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      // TODO produção: stripeClient.webhooks.constructEvent(rawBody, sig, secret)
      const event = req.body || {};
      const t = event.type;
      log.info('webhook Stripe recebido', { type: t, signed: !!sig });

      if (t === 'checkout.session.completed' || t === 'invoice.paid') {
        const session = event.data?.object || {};
        const email = session.customer_email || session.customer_details?.email;
        const plan = session.metadata?.plan || 'PREMIUM';
        await provisionUserFromPayment(db, {
          email,
          plan,
          provider: 'stripe',
          externalId: session.id || session.subscription,
          amount: (session.amount_total || session.amount_paid || 0) / 100,
          status: 'approved',
        });
      }
      res.status(200).send('ok');
    } catch (e) {
      log.error('webhook Stripe erro', { err: e.message });
      res.status(500).send(e.message);
    }
  });

  /* ============================================================
     PÁGINAS DE RETORNO DO CHECKOUT
     ------------------------------------------------------------
     MP redireciona o usuário para essas URLs após o pagamento.
     A página em si NÃO ativa o premium — só mostra status.
     A ativação SEMPRE vem pelo webhook (segurança).
     ============================================================ */
  app.get('/billing/success', (req, res) => {
    const plan = req.query.plan || 'PREMIUM';
    const paymentId = req.query.payment_id || req.query.collection_id || '';
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head>
      <meta charset="utf-8"><title>Pagamento aprovado · Robotrend IA</title>
      <link rel="stylesheet" href="/style.css">
    </head><body style="background:#07100a;color:#e6f5ec;font-family:'Plus Jakarta Sans',system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px">
      <div style="max-width:480px;text-align:center;width:100%">
        <div style="font-size:72px;line-height:1;animation:pulse 1.4s ease-in-out infinite">✅</div>
        <h1 style="color:#14b85e;font-weight:900;font-size:28px;margin:10px 0">Pagamento aprovado!</h1>
        <p id="status-text" style="color:#cfe6d8;font-size:15px;margin:8px 0">Aguardando confirmação do Mercado Pago…</p>

        <div style="margin:24px auto;width:240px;height:4px;background:#14241c;border-radius:2px;overflow:hidden">
          <div id="progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#14b85e,#00d97e);transition:width .4s ease"></div>
        </div>

        <p id="info-text" style="color:#7c9486;font-size:13px;margin:0 0 24px">
          O webhook confirma o pagamento em segundos · Plano <b style="color:#14b85e">${plan}</b>
          ${paymentId ? `<br/>ID: <code style="background:#14241c;padding:2px 6px;border-radius:4px">${paymentId}</code>` : ''}
        </p>

        <a id="cta-go" href="/?upgraded=${encodeURIComponent(plan)}"
           style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#14b85e,#00d97e);color:#03110b;border-radius:12px;text-decoration:none;font-weight:800;box-shadow:0 6px 20px rgba(20,184,94,.35)">
          Ir para o painel →
        </a>
        <p style="color:#7c9486;font-size:11px;margin-top:18px" id="footer-text">Detectaremos o upgrade automaticamente assim que chegar.</p>
      </div>
      <style>@keyframes pulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 20px rgba(20,184,94,.5))}50%{transform:scale(1.08);filter:drop-shadow(0 0 32px rgba(20,184,94,.9))}}</style>
      <script src="/js/auth.js"></script>
      <script>
      (function(){
        // Seta flag para o user-state.js iniciar polling rápido na próxima página
        try {
          localStorage.setItem('robotrend_pending_upgrade', JSON.stringify({
            plan: '${plan}',
            startedAt: Date.now(),
          }));
        } catch(_) {}

        var bar = document.getElementById('progress-bar');
        var status = document.getElementById('status-text');
        var footer = document.getElementById('footer-text');
        var cta = document.getElementById('cta-go');

        var attempts = 0;
        var maxAttempts = 30; // 30 * 4s = 2 minutos

        function poll() {
          attempts++;
          var pct = Math.min(95, (attempts / maxAttempts) * 100);
          bar.style.width = pct + '%';

          if (!window.RobotrendAuth?.getToken?.()) {
            status.textContent = 'Faça login para continuar.';
            return setTimeout(function(){ location.href = '/login.html'; }, 1500);
          }

          window.RobotrendAuth.api('/api/me/subscription').then(function(d) {
            if (d && d.isPremium) {
              bar.style.width = '100%';
              status.innerHTML = '<b style="color:#14b85e">✓ Plano ' + (d.planLabel || 'Premium') + ' ativado!</b>';
              footer.textContent = 'Redirecionando para o painel…';
              cta.style.transform = 'scale(1.05)';
              try { localStorage.removeItem('robotrend_pending_upgrade'); } catch(_) {}
              setTimeout(function(){ location.href = '/?upgraded=${encodeURIComponent(plan)}'; }, 1200);
            } else if (attempts < maxAttempts) {
              setTimeout(poll, 4000);
            } else {
              status.innerHTML = 'Pagamento aprovado, mas a confirmação está demorando.';
              footer.innerHTML = 'Você pode ir para o painel · O upgrade será aplicado assim que chegar.';
            }
          }).catch(function() {
            if (attempts < maxAttempts) setTimeout(poll, 4000);
          });
        }
        setTimeout(poll, 1500);
      })();
      </script>
    </body></html>`);
  });

  app.get('/billing/pending', (req, res) => {
    const plan = req.query.plan || 'PREMIUM';
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head>
      <meta charset="utf-8"><title>Pagamento pendente · Robotrend IA</title>
      <link rel="stylesheet" href="/style.css">
    </head><body style="display:grid;place-items:center;min-height:100vh;font-family:system-ui;text-align:center;padding:24px;background:#07100a;color:#e6f5ec">
      <div style="max-width:480px">
        <div style="font-size:72px;line-height:1">⏳</div>
        <h1 style="color:#ffb547;font-weight:900;font-size:28px;margin:10px 0">Pagamento pendente</h1>
        <p>Seu pagamento do plano <b>${plan}</b> está sendo processado.</p>
        <p style="color:#7c9486;font-size:13px">
          Se você pagou via PIX/boleto, pode levar alguns minutos.
          Assim que aprovado, seu plano será liberado automaticamente.
        </p>
        <p style="margin-top:24px"><a href="/" style="display:inline-block;padding:12px 24px;background:#14241c;color:#e6f5ec;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid #1d3328">Voltar ao painel</a></p>
      </div>
    </body></html>`);
  });

  app.get('/billing/failure', (req, res) => {
    const plan = req.query.plan || 'PREMIUM';
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head>
      <meta charset="utf-8"><title>Pagamento não aprovado · Robotrend IA</title>
      <link rel="stylesheet" href="/style.css">
    </head><body style="display:grid;place-items:center;min-height:100vh;font-family:system-ui;text-align:center;padding:24px;background:#07100a;color:#e6f5ec">
      <div style="max-width:520px">
        <div style="font-size:72px;line-height:1">❌</div>
        <h1 style="color:#ff5566;font-weight:900;font-size:28px;margin:10px 0">Pagamento não aprovado</h1>
        <p>Seu pagamento do plano <b>${plan}</b> não foi concluído.</p>
        <p style="color:#7c9486;font-size:13px;margin-top:10px">
          Isso pode acontecer por: cartão recusado, saldo insuficiente, dados incorretos
          ou cancelamento manual. Nenhum valor foi cobrado.
        </p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:24px;flex-wrap:wrap">
          <a href="/pricing.html" style="display:inline-block;padding:12px 24px;background:#14b85e;color:#03110b;border-radius:10px;text-decoration:none;font-weight:700">🔄 Tentar novamente</a>
          <a href="/" style="display:inline-block;padding:12px 24px;background:#14241c;color:#e6f5ec;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid #1d3328">Voltar ao painel</a>
        </div>
        <p style="color:#7c9486;font-size:11px;margin-top:20px">
          Precisa de ajuda? Fale com o suporte.
        </p>
      </div>
    </body></html>`);
  });

  /* ============================================================
     Mock success (dev) — usuário existente autoupgrade
     ============================================================ */
  app.get('/billing/mock-success', requireAuth(db), async (req, res) => {
    const { plan, provider } = req.query;
    if (!['VIP', 'PREMIUM'].includes(plan)) return res.status(400).send('plan inválido');
    await provisionUserFromPayment(db, {
      email: req.user.email,
      plan,
      provider: provider || 'mock',
      externalId: 'mock_' + Date.now(),
      amount: getPlan(plan).priceBRL,
      status: 'approved',
    });
    res.redirect('/?upgraded=' + plan);
  });
}

module.exports = {
  createStripeCheckout,
  createMercadoPagoCheckout,
  createPixPayment,
  generatePixStatic,
  buildPaymentRoutes,
  provisionUserFromPayment,
  generateInitialPassword,
};
