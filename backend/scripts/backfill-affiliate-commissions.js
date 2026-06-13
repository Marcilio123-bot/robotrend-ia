/**
 * Robotrend IA — Backfill de comissões de afiliados
 *
 * Recupera comissões para usuários PREMIUM ativados via Mercado Pago
 * que possuem indicação (affiliate_referrals) mas não têm linha em
 * affiliate_commissions.
 *
 * CLI:
 *   node backend/scripts/backfill-affiliate-commissions.js
 *   node backend/scripts/backfill-affiliate-commissions.js --dry-run
 *
 * API:
 *   POST /api/admin/backfill-affiliate-commissions
 *   Body opcional: { "dryRun": true }
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Carrega .env da raiz do projeto (mesmo padrão do server.js).
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath, override: false });
}

const db = require('../database');
const { getPlan } = require('../plans');
const { logger } = require('../logger');
const log = logger.child({ module: 'backfill-affiliate-commissions' });

/**
 * Busca candidatos: PREMIUM + provider mercadopago + referral + sem comissão.
 */
async function findCandidates() {
  if (!db.isPostgres()) {
    throw new Error('Backfill requer PostgreSQL (DATABASE_URL). Modo in-memory não suportado.');
  }

  const pool = db.getPool();
  const { rows } = await pool.query(
    `SELECT
       u.id          AS user_id,
       u.email,
       u.plan,
       s.provider    AS subscription_provider,
       s.external_id AS payment_external_id,
       s.started_at  AS subscription_started_at,
       r.affiliate_id
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     JOIN affiliate_referrals r ON r.user_id = u.id
     WHERE LOWER(COALESCE(s.provider, '')) = 'mercadopago'
       AND UPPER(COALESCE(u.plan, 'FREE')) IN ('PREMIUM','VIP','PRO','SEMESTRAL','ANUAL')
       AND COALESCE(u.blocked, false) = false
       AND NOT EXISTS (
         SELECT 1 FROM affiliate_commissions c WHERE c.user_id = u.id
       )
     ORDER BY s.started_at ASC`
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    plan: String(r.plan || 'PREMIUM').toUpperCase(),
    subscriptionProvider: r.subscription_provider,
    paymentExternalId: r.payment_external_id,
    subscriptionStartedAt: r.subscription_started_at,
    affiliateId: r.affiliate_id,
  }));
}

/**
 * Resolve valor pago: payments (paid ou qualquer) → fallback preço do plano.
 */
async function resolveAmountPaid(userId, plan) {
  const pool = db.getPool();
  const { rows } = await pool.query(
    `SELECT amount_brl, status, external_id, created_at
       FROM payments
      WHERE user_id = $1 AND LOWER(COALESCE(provider, '')) = 'mercadopago'
      ORDER BY
        CASE WHEN status = 'paid' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1`,
    [userId]
  );
  if (rows[0]) {
    const amt = Number(rows[0].amount_brl);
    if (Number.isFinite(amt) && amt > 0) {
      return { amount: amt, source: `payments(${rows[0].status})`, paymentRow: rows[0] };
    }
  }
  const fallback = Number(getPlan(plan)?.priceBRL) || 0;
  return { amount: fallback, source: 'plan_price_fallback', paymentRow: null };
}

/**
 * Executa o backfill.
 * @param {{ dryRun?: boolean }} opts
 */
async function runBackfill({ dryRun = false } = {}) {
  if (!db.isPostgres() && (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging')) {
    throw new Error('Backfill exige PostgreSQL em produção/staging.');
  }

  const candidates = await findCandidates();
  const report = {
    dryRun,
    scanned: candidates.length,
    created: 0,
    skipped: 0,
    errors: 0,
    items: [],
  };

  for (const row of candidates) {
    const item = {
      userId: row.userId,
      email: row.email,
      plan: row.plan,
      affiliateId: row.affiliateId,
      paymentExternalId: row.paymentExternalId,
      status: 'pending',
      commissionAmount: null,
      message: '',
    };

    try {
      const affiliate = await db.getAffiliateById(row.affiliateId);
      if (!affiliate) {
        item.status = 'skipped';
        item.message = 'afiliado não encontrado';
        report.skipped++;
        report.items.push(item);
        continue;
      }
      if (!affiliate.active) {
        item.status = 'skipped';
        item.message = `afiliado inativo (code=${affiliate.code})`;
        report.skipped++;
        report.items.push(item);
        continue;
      }

      const externalId = row.paymentExternalId
        ? String(row.paymentExternalId)
        : `backfill-sub-${row.userId}`;

      // Idempotência: já existe comissão para este payment_external_id?
      if (externalId && db.isPostgres()) {
        const pool = db.getPool();
        const ex = await pool.query(
          `SELECT id FROM affiliate_commissions WHERE payment_external_id = $1 LIMIT 1`,
          [externalId]
        );
        if (ex.rows.length) {
          item.status = 'skipped';
          item.message = `comissão já existe para payment_external_id=${externalId}`;
          report.skipped++;
          report.items.push(item);
          continue;
        }
      }

      const { amount, source } = await resolveAmountPaid(row.userId, row.plan);
      const pct = Number(affiliate.commissionPct) || 0;
      const commissionAmount = Math.floor((amount * pct / 100) * 100) / 100;

      item.paymentExternalId = externalId;
      item.amountPaid = amount;
      item.amountSource = source;
      item.commissionPct = pct;
      item.commissionAmount = commissionAmount;
      item.affiliateCode = affiliate.code;

      if (dryRun) {
        item.status = 'dry_run';
        item.message = `criaria comissão R$ ${commissionAmount.toFixed(2)} (${pct}% de R$ ${amount.toFixed(2)})`;
        report.items.push(item);
        continue;
      }

      const commission = await db.recordAffiliateCommission({
        affiliateId: affiliate.id,
        userId: row.userId,
        paymentExternalId: externalId,
        plan: row.plan,
        amountPaid: amount,
        commissionPct: pct,
      });

      if (commission) {
        item.status = 'created';
        item.commissionId = commission.id;
        item.commissionAmount = commission.commissionAmount;
        item.message = `comissão criada R$ ${Number(commission.commissionAmount).toFixed(2)}`;
        report.created++;
      } else {
        item.status = 'skipped';
        item.message = 'recordAffiliateCommission retornou null';
        report.skipped++;
      }
    } catch (err) {
      item.status = 'error';
      item.message = err.message;
      report.errors++;
      log.warn('backfill item falhou', { userId: row.userId, err: err.message });
    }

    report.items.push(item);
  }

  log.info('backfill concluído', {
    dryRun, scanned: report.scanned, created: report.created,
    skipped: report.skipped, errors: report.errors,
  });

  return report;
}

// CLI direto
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  (async () => {
    try {
      await db.init();
      const report = await runBackfill({ dryRun });
      console.log('\n=== RELATÓRIO BACKFILL COMISSÕES ===');
      console.log(`Modo:        ${dryRun ? 'DRY-RUN (nenhuma escrita)' : 'EXECUÇÃO REAL'}`);
      console.log(`Encontradas: ${report.scanned} candidata(s)`);
      console.log(`Criadas:     ${report.created}`);
      console.log(`Ignoradas:   ${report.skipped}`);
      console.log(`Erros:       ${report.errors}`);
      console.log('\nDetalhes:');
      for (const it of report.items) {
        console.log(
          `  [${it.status}] ${it.email} | plan=${it.plan} | afiliado=${it.affiliateCode || it.affiliateId}` +
          ` | ext=${it.paymentExternalId || '—'} | comissão=${it.commissionAmount != null ? 'R$ ' + Number(it.commissionAmount).toFixed(2) : '—'}` +
          ` | ${it.message}`
        );
      }
      process.exit(report.errors > 0 ? 1 : 0);
    } catch (e) {
      console.error('Backfill falhou:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { runBackfill, findCandidates };
