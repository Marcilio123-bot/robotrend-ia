/**
 * Diagnóstico read-only do fluxo de comissão de um afiliado.
 *
 * Uso (PowerShell):
 *   $env:DATABASE_URL = "postgresql://USER:SENHA@dpg-xxx-a.oregon-postgres.render.com/robotrend"
 *   node scripts/diag-afiliado.js MARCELOE9C8
 *
 * Apenas SELECTs. Não escreve nada no banco. A senha nunca é impressa.
 */
'use strict';

const { Pool } = require('pg');

const CODE = (process.argv[2] || 'MARCELOE9C8').toUpperCase();
const url = (process.env.DATABASE_URL || '').trim();

if (!url) {
  console.error('ERRO: defina DATABASE_URL antes de rodar (External Database URL do Render).');
  process.exit(1);
}

// SSL automático para hosts gerenciados (Render exige).
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
  } catch {
    return '(URL inválida)';
  }
}

(async () => {
  console.log('Conectando em:', maskUrl(url), '| ssl:', needsSsl ? 'on' : 'off');
  console.log('Afiliado code:', CODE);
  console.log('='.repeat(70));

  try {
    // 0) Afiliado existe?
    const aff = await pool.query(
      `SELECT id, code, name, email, commission_pct, active, created_at
         FROM affiliates WHERE UPPER(code) = $1`,
      [CODE]
    );
    if (!aff.rows.length) {
      console.log(`Nenhum afiliado com code=${CODE}. Verifique o código.`);
      return;
    }
    console.log('AFILIADO:');
    console.table(aff.rows);
    const affiliateId = aff.rows[0].id;

    // 1) Indicados + plano atual
    const refs = await pool.query(
      `SELECT u.id AS user_id, u.email, u.plan AS plano_atual,
              u.subscription_status, u.blocked, u.expires_at, r.created_at AS indicado_em
         FROM affiliate_referrals r
         JOIN users u ON u.id = r.user_id
        WHERE r.affiliate_id = $1
        ORDER BY r.created_at DESC`,
      [affiliateId]
    );
    console.log('\nINDICADOS:');
    console.table(refs.rows);

    // 2/3) Pagamentos desses indicados
    const pays = await pool.query(
      `SELECT p.user_id, p.provider, p.amount_brl, p.plan, p.status,
              p.external_id, p.created_at
         FROM payments p
        WHERE p.user_id IN (
              SELECT r.user_id FROM affiliate_referrals r WHERE r.affiliate_id = $1)
        ORDER BY p.created_at DESC`,
      [affiliateId]
    );
    console.log('\nPAGAMENTOS DOS INDICADOS:');
    console.table(pays.rows);

    // 4) Comissões do afiliado
    const comms = await pool.query(
      `SELECT id, user_id, payment_external_id, plan, amount_paid,
              commission_pct, commission_amount, status, created_at, paid_at
         FROM affiliate_commissions
        WHERE affiliate_id = $1
        ORDER BY created_at DESC`,
      [affiliateId]
    );
    console.log('\nCOMISSOES:');
    console.table(comms.rows);

    // 5) Consolidado (a mesma query do diagnóstico)
    const joined = await pool.query(
      `SELECT u.id AS user_id, u.email, u.plan AS plano_atual,
              a.commission_pct, a.active AS afiliado_ativo,
              p.plan AS plano_pago, p.amount_brl AS valor_pago,
              p.status AS status_pagamento, p.external_id,
              c.id AS commission_id, c.commission_amount
         FROM affiliates a
         JOIN affiliate_referrals r ON r.affiliate_id = a.id
         JOIN users u ON u.id = r.user_id
         LEFT JOIN payments p ON p.user_id = u.id AND p.status = 'paid'
         LEFT JOIN affiliate_commissions c ON c.user_id = u.id
        WHERE UPPER(a.code) = $1`,
      [CODE]
    );
    console.log('\nCONSOLIDADO (query do diagnóstico):');
    console.table(joined.rows);

    // Conclusão automática
    console.log('\n' + '='.repeat(70));
    console.log('CONCLUSAO AUTOMATICA:');
    for (const row of joined.rows) {
      const temPagamento = !!row.status_pagamento;
      const temExternal = !!row.external_id;
      const temComissao = row.commission_id != null;
      const pct = Number(row.commission_pct || 0);
      const afiliadoAtivo = row.afiliado_ativo;
      let cenario;
      if (temComissao && Number(row.commission_amount) > 0) {
        cenario = '5) Comissao existe (>0) — problema apenas de exibicao';
      } else if (temComissao && Number(row.commission_amount) === 0) {
        cenario = '4) Comissao criada com valor ZERADO (commission_pct=0 no pagamento)';
      } else if (!temPagamento) {
        cenario = '1) Premium SEM pagamento paid → upgrade manual (master.js:60) ou renovacao (subscription.js:324)';
      } else if (temPagamento && temExternal && !afiliadoAtivo) {
        cenario = '3) Pagamento OK mas afiliado INATIVO no registro (affiliates.js:115)';
      } else if (temPagamento && temExternal && !temComissao) {
        cenario = '2) Pagamento paid + external_id, mas SEM comissao (codigo nao rodou / pre-550f1f0 / afiliado inativo na epoca)';
      } else {
        cenario = 'Indeterminado — revisar manualmente';
      }
      console.log(`- user=${row.email} | plano_pago=${row.plano_pago || '—'} | valor=${row.valor_pago || '—'} | external_id=${row.external_id || '—'} | pct=${pct} | comissao=${row.commission_amount ?? '—'} => ${cenario}`);
    }
  } catch (e) {
    console.error('FALHA na consulta:', e.code || '', e.message);
  } finally {
    await pool.end();
  }
})();
