/**
 * Diagnóstico read-only: origem da ativação PREMIUM de um usuário.
 *
 * Uso (PowerShell):
 *   $env:DATABASE_URL = "postgresql://USER:SENHA@dpg-xxx-a.oregon-postgres.render.com/robotrend"
 *   node scripts/diag-origem.js 6603ad0a61d20424
 *
 * Apenas SELECTs. Não escreve nada. A senha nunca é impressa.
 */
'use strict';

const { Pool } = require('pg');

const USER_ID = process.argv[2];
const url = (process.env.DATABASE_URL || '').trim();

if (!USER_ID) {
  console.error('ERRO: informe o user_id. Ex.: node scripts/diag-origem.js 6603ad0a61d20424');
  process.exit(1);
}
if (!url) {
  console.error('ERRO: defina DATABASE_URL (External Database URL do Render) antes de rodar.');
  process.exit(1);
}

const needsSsl = /sslmode=require|\.render\.com|\.aws|\.neon\.tech|\.supabase\./i.test(url)
  || String(process.env.PGSSL || '').toLowerCase() === 'true';

const pool = new Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 12_000,
});

function maskUrl(u) {
  try {
    const x = new URL(u.replace(/^postgresql:/i, 'postgres:'));
    return `postgres://${x.username}:***@${x.hostname}:${x.port || 5432}${x.pathname}`;
  } catch { return '(URL inválida)'; }
}

(async () => {
  console.log('Conectando em:', maskUrl(url), '| ssl:', needsSsl ? 'on' : 'off');
  console.log('user_id:', USER_ID);
  console.log('='.repeat(70));
  try {
    const user = await pool.query(
      `SELECT id, email, plan, role, subscription_status, expires_at, created_at, updated_at
         FROM users WHERE id = $1`, [USER_ID]);
    console.log('\nUSER:');
    console.table(user.rows);

    const sub = await pool.query(
      `SELECT user_id, plan, provider, external_id, status, started_at, expires_at
         FROM subscriptions WHERE user_id = $1`, [USER_ID]);
    console.log('\nSUBSCRIPTION:');
    console.table(sub.rows);

    const logs = await pool.query(
      `SELECT id, admin_id, admin_email, action, details, created_at
         FROM admin_logs WHERE target_user_id = $1
        ORDER BY created_at DESC`, [USER_ID]);
    console.log('\nADMIN_LOGS:');
    console.table(logs.rows.map(r => ({ ...r, details: JSON.stringify(r.details) })));

    const pays = await pool.query(
      `SELECT id, external_id, status, amount_brl, plan, provider, created_at
         FROM payments WHERE user_id = $1 ORDER BY created_at`, [USER_ID]);
    console.log('\nPAYMENTS:');
    console.table(pays.rows);

    // Conclusão automática sobre a ORIGEM
    console.log('\n' + '='.repeat(70));
    console.log('ORIGEM DA ATIVACAO:');
    const s = sub.rows[0];
    const provider = s?.provider || null;
    const hasPaidMp = pays.rows.some(p => p.provider === 'mercadopago' && p.status === 'paid');
    const adminUpdates = logs.rows.filter(r => ['user.update', 'user.renew'].includes(r.action));

    if (!s) {
      console.log('- Sem linha em subscriptions. Plano provavelmente setado direto em users (updateUser).');
    } else {
      console.log(`- subscriptions.provider = ${provider}`);
      console.log(`- subscriptions.external_id = ${s.external_id || '—'}`);
      console.log(`- subscriptions.started_at = ${s.started_at || '—'}`);
    }

    if (provider === 'mercadopago' && hasPaidMp) {
      console.log('=> Origem: PAGAMENTO Mercado Pago (webhook approved → activateSubscription em payments.js:938).');
    } else if (provider === 'manual') {
      console.log('=> Origem: UPGRADE MANUAL do Master (activateSubscription provider=manual) ou updateUser em master.js:60.');
    } else if (provider === 'admin_renewal') {
      console.log('=> Origem: RENOVACAO pelo Master (renewSubscription em subscription.js:310 → updateUser:324).');
    } else if (provider === 'trial') {
      console.log('=> Origem: TRIAL no cadastro (onboarding.applyTrial).');
    } else if (adminUpdates.length) {
      console.log('=> Origem provavel: acao admin em admin_logs:', adminUpdates.map(r => r.action + '@' + r.created_at).join(', '),
                  '→ master.js:60 (PATCH /api/master/users/:id).');
    } else {
      console.log('=> Origem indeterminada — sem provider claro e sem admin_logs. Verificar updateUser direto.');
    }

    if (adminUpdates.length) {
      console.log('\nADMIN que alterou o plano:');
      for (const r of adminUpdates) {
        console.log(`- ${r.created_at} | ${r.action} | admin=${r.admin_email || r.admin_id} | details=${JSON.stringify(r.details)}`);
      }
    } else {
      console.log('\nNenhum admin_log de user.update/user.renew → plano NAO veio de acao admin registrada.');
    }
  } catch (e) {
    console.error('FALHA na consulta:', e.code || '', e.message);
  } finally {
    await pool.end();
  }
})();
