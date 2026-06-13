/**
 * Robotrend IA — Sistema de Afiliados / Revendedores
 *
 *  Master (requireAuth + requireAdmin):
 *    GET    /api/master/affiliates              → lista afiliados + estatísticas
 *    POST   /api/master/affiliates              → cadastra afiliado (cria conta de acesso)
 *    GET    /api/master/affiliates-overview     → agregados do dashboard
 *    GET    /api/master/affiliates/:id          → detalhe (stats, comissões, pagamentos)
 *    PATCH  /api/master/affiliates/:id          → altera comissão %, nome, ativo
 *    POST   /api/master/affiliates/:id/pay      → marca comissões pendentes como pagas
 *
 *  Afiliado (requireAuth + requireAffiliate):
 *    GET    /api/affiliate/me                    → painel do próprio afiliado
 *
 *  Cálculo automático: comissão = valor_pago × (percentual_do_afiliado / 100),
 *  usando o percentual VIGENTE no momento do pagamento. O Master pode alterar
 *  o percentual a qualquer momento — pagamentos futuros usam o novo valor.
 */

'use strict';

const crypto = require('crypto');
const auth = require('./auth');
const { logger } = require('./logger');
const log = logger.child({ module: 'affiliates' });

const MASTER_ROLES = new Set(['master', 'admin', 'owner', 'super_admin']);

/** Senha inicial para conta de afiliado (evita require circular com payments.js). */
function generateInitialPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const buf = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function sanitizeText(v, max = 80) {
  return String(v ?? '').replace(/[<>]/g, '').trim().slice(0, max);
}

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Extrai os dados de recebimento PIX de um afiliado + status de configuração. */
function payoutInfoOf(aff) {
  const holder = aff?.payoutHolder || null;
  const bank = aff?.payoutBank || null;
  const pixKey = aff?.payoutPixKey || null;
  return {
    holder,
    bank,
    pixKey,
    updatedAt: aff?.payoutUpdatedAt || null,
    configured: !!(holder && bank && pixKey),
  };
}

/** Normaliza um percentual: aceita qualquer valor >= 0 (10, 15.5, 30, 50...). */
function normalizePct(v) {
  const n = Number(v);
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/** Slug curto a partir do nome, para compor o código de indicação. */
function slugify(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8) || 'AFF';
}

/** Gera um código de indicação único (base no nome + sufixo aleatório). */
async function generateUniqueCode(db, name) {
  const base = slugify(name);
  for (let i = 0; i < 12; i++) {
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase(); // 4 chars
    const code = `${base}${suffix}`;
    const exists = await db.getAffiliateByCode(code);
    if (!exists) return code;
  }
  // fallback altamente improvável
  return `AFF${Date.now().toString(36).toUpperCase()}`;
}

function buildReferralLink(req, code) {
  try {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) return `${proto}://${host}/register.html?ref=${encodeURIComponent(code)}`;
  } catch (_) {}
  return `/register.html?ref=${encodeURIComponent(code)}`;
}

/* ============================================================
   HELPER — registra comissão a partir de um pagamento aprovado.
   Chamado pelo payments.js após confirmar um pagamento 'paid'.
   Idempotente por payment_external_id (reentrega não duplica).
   ============================================================ */
async function recordAffiliateCommissionForPayment(db, { userId, externalId, plan, amount }) {
  try {
    if (!userId) {
      log.debug('comissão ignorada — userId ausente', { externalId });
      return null;
    }
    const referral = await db.getReferralByUserId(userId);
    if (!referral || !referral.affiliateId) {
      log.debug('comissão ignorada — cliente sem indicação', { userId, externalId });
      return null;
    }
    const affiliate = await db.getAffiliateById(referral.affiliateId);
    if (!affiliate || !affiliate.active) {
      log.warn('comissão ignorada — afiliado inativo ou inexistente', {
        userId, affiliateId: referral.affiliateId, externalId,
      });
      return null;
    }
    const pct = Number(affiliate.commissionPct) || 0;
    const commission = await db.recordAffiliateCommission({
      affiliateId: affiliate.id,
      userId,
      paymentExternalId: externalId || null,
      plan: plan || null,
      amountPaid: Number(amount) || 0,
      commissionPct: pct,
    });
    if (commission) {
      log.info('comissão de afiliado registrada', {
        affiliateId: affiliate.id, userId, amount, pct,
        commissionAmount: commission.commissionAmount, externalId,
      });
    }
    return commission;
  } catch (err) {
    // Comissão nunca pode quebrar o fluxo de pagamento.
    log.warn('recordAffiliateCommissionForPayment falhou', { err: err.message, userId, externalId });
    return null;
  }
}

/* ============================================================
   ROUTES
   ============================================================ */
function buildAffiliateRoutes(app, db, requireAuth, requireAdmin, requireAffiliate) {
  /* ---------------- MASTER ---------------- */
  const masterGuard = [requireAuth(db), requireAdmin];

  /** Monta o payload de um afiliado com estatísticas + link. */
  async function affiliatePublic(req, aff) {
    const stats = await db.affiliateStats(aff.id);
    return {
      ...aff,
      link: buildReferralLink(req, aff.code),
      stats,
    };
  }

  app.get('/api/master/affiliates', ...masterGuard, async (req, res) => {
    try {
      const affiliates = await db.listAffiliates(1000);
      const withStats = await Promise.all(affiliates.map((a) => affiliatePublic(req, a)));
      res.json({ ok: true, affiliates: withStats });
    } catch (e) {
      log.error('listar afiliados falhou', { err: e.message });
      res.status(500).json({ ok: false, error: e.message, affiliates: [] });
    }
  });

  app.get('/api/master/affiliates-overview', ...masterGuard, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const overview = await db.affiliatesOverview();
      res.json({ ok: true, overview });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/master/affiliates', ...masterGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const name = sanitizeText(body.name, 80);
      const email = String(body.email ?? '').trim().toLowerCase();
      const pct = normalizePct(body.commissionPct);

      if (!name) return res.status(400).json({ ok: false, error: 'NAME_REQUIRED' });
      if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
      if (pct == null) return res.status(400).json({ ok: false, error: 'INVALID_COMMISSION' });

      // Conta de acesso do afiliado: reusa user existente ou cria um novo.
      let user = await db.findUserByEmail(email);
      let initialPassword = null;

      if (user) {
        if (MASTER_ROLES.has(String(user.role || '').toLowerCase())) {
          return res.status(409).json({ ok: false, error: 'EMAIL_IS_ADMIN' });
        }
        const already = await db.getAffiliateByUserId(user.id);
        if (already) return res.status(409).json({ ok: false, error: 'ALREADY_AFFILIATE' });
        user = await db.updateUser(user.id, { role: 'affiliate' });
      } else {
        initialPassword = body.password && String(body.password).length >= 6
          ? String(body.password)
          : generateInitialPassword();
        const passwordHash = await auth.hashPassword(initialPassword);
        user = await db.createUser({
          email,
          name: name || email.split('@')[0],
          passwordHash,
          plan: 'FREE',
          role: 'affiliate',
        });
      }

      const code = await generateUniqueCode(db, name);
      const affiliate = await db.createAffiliate({
        userId: user.id,
        name,
        email,
        code,
        commissionPct: pct,
        active: true,
      });

      log.info('afiliado cadastrado', { adminId: req.user.id, affiliateId: affiliate.id, code, pct });
      const payload = await affiliatePublic(req, affiliate);
      res.status(201).json({
        ok: true,
        affiliate: payload,
        access: {
          email,
          password: initialPassword, // só presente quando a conta foi criada agora
          loginUrl: '/login.html',
        },
      });
    } catch (e) {
      log.error('cadastrar afiliado falhou', { err: e.message });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/master/affiliates/:id', ...masterGuard, async (req, res) => {
    try {
      const aff = await db.getAffiliateById(req.params.id);
      if (!aff) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      const [stats, commissions, payouts] = await Promise.all([
        db.affiliateStats(aff.id),
        db.listCommissions({ affiliateId: aff.id, limit: 500 }),
        db.listPayouts(aff.id, 200),
      ]);
      res.json({
        ok: true,
        affiliate: { ...aff, link: buildReferralLink(req, aff.code) },
        stats,
        payoutInfo: payoutInfoOf(aff),
        commissions,
        payouts,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/master/affiliates/:id', ...masterGuard, async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (typeof body.name === 'string') patch.name = sanitizeText(body.name, 80);
      if (body.commissionPct != null) {
        const pct = normalizePct(body.commissionPct);
        if (pct == null) return res.status(400).json({ ok: false, error: 'INVALID_COMMISSION' });
        patch.commissionPct = pct;
      }
      if (typeof body.active === 'boolean') patch.active = body.active;
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'NOTHING_TO_UPDATE' });

      const affiliate = await db.updateAffiliate(req.params.id, patch);
      if (!affiliate) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      log.info('afiliado atualizado', { adminId: req.user.id, id: affiliate.id, patch });
      const payload = await affiliatePublic(req, affiliate);
      res.json({ ok: true, affiliate: payload });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/master/affiliates/:id/pay', ...masterGuard, async (req, res) => {
    try {
      const aff = await db.getAffiliateById(req.params.id);
      if (!aff) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      const note = sanitizeText((req.body || {}).note, 200) || null;
      const result = await db.payAffiliateCommissions(aff.id, {
        note,
        createdBy: req.user.id,
      });
      if (!result.count) {
        return res.status(400).json({ ok: false, error: 'NO_PENDING_COMMISSIONS' });
      }
      log.info('comissões pagas', { adminId: req.user.id, affiliateId: aff.id, amount: result.amount, count: result.count });
      res.json({ ok: true, ...result, payoutInfo: payoutInfoOf(aff) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ---------------- AFILIADO ---------------- */
  app.get('/api/affiliate/me', requireAuth(db), requireAffiliate, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const aff = await db.getAffiliateByUserId(req.user.id);
      if (!aff) return res.status(404).json({ ok: false, error: 'NOT_AN_AFFILIATE' });
      const [stats, commissions, payouts] = await Promise.all([
        db.affiliateStats(aff.id),
        db.listCommissions({ affiliateId: aff.id, limit: 300 }),
        db.listPayouts(aff.id, 100),
      ]);
      res.json({
        ok: true,
        affiliate: {
          id: aff.id,
          name: aff.name,
          code: aff.code,
          commissionPct: aff.commissionPct,
          active: aff.active,
          link: buildReferralLink(req, aff.code),
        },
        stats,
        balanceAvailable: stats.pending,
        payoutInfo: payoutInfoOf(aff),
        commissions,
        payouts,
      });
    } catch (e) {
      log.error('painel do afiliado falhou', { err: e.message });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /api/affiliate/payout — afiliado cadastra/edita os PRÓPRIOS dados PIX.
   * Apenas titular, banco e chave PIX. O afiliado só altera o próprio registro
   * (resolvido por req.user.id), nunca o de outro afiliado.
   */
  app.post('/api/affiliate/payout', requireAuth(db), requireAffiliate, async (req, res) => {
    try {
      const aff = await db.getAffiliateByUserId(req.user.id);
      if (!aff) return res.status(404).json({ ok: false, error: 'NOT_AN_AFFILIATE' });

      const body = req.body || {};
      const holder = sanitizeText(body.holder, 80);
      const bank = sanitizeText(body.bank, 60);
      const pixKey = sanitizeText(body.pixKey, 140);

      if (!holder) return res.status(400).json({ ok: false, error: 'HOLDER_REQUIRED' });
      if (!bank) return res.status(400).json({ ok: false, error: 'BANK_REQUIRED' });
      if (!pixKey) return res.status(400).json({ ok: false, error: 'PIX_KEY_REQUIRED' });

      const updated = await db.updateAffiliatePayoutInfo(aff.id, { holder, bank, pixKey });
      log.info('dados PIX do afiliado atualizados', { affiliateId: aff.id });
      res.json({ ok: true, payoutInfo: payoutInfoOf(updated) });
    } catch (e) {
      log.error('atualizar dados PIX falhou', { err: e.message });
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { buildAffiliateRoutes, recordAffiliateCommissionForPayment };
