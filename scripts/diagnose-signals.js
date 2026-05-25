'use strict';

/**
 * Robotrend IA — Diagnóstico do pipeline de sinais
 * ==================================================
 *
 * Uso:
 *   node scripts/diagnose-signals.js                # consulta API local
 *   node scripts/diagnose-signals.js --url=https://api.example.com
 *   node scripts/diagnose-signals.js --drops=50
 *   node scripts/diagnose-signals.js --token=ADMIN_JWT
 *
 * Bate em GET /api/football/bet-signals/debug e /api/football/signals/debug
 * (ambas requerem auth admin → passe --token=... ou use BASIC env).
 *
 * O relatório mostra o funil estágio-por-estágio:
 *   input → not-enriched → no-stats → minute-out-of-range
 *         → computed → compute-null
 *         → low-confidence → odd-out-of-range → cooldown → emitted
 *
 * Identifica automaticamente onde os jogos estão sendo descartados
 * e sugere ações (ativar TEST_MODE, baixar threshold, etc).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function parseArgs(argv) {
  const args = { url: 'http://localhost:3010', drops: 30, token: process.env.ADMIN_JWT || '' };
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function fetchJson(urlStr, { token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = lib.request(url, opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}; body: ${buf.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('timeout 15s')));
    req.end();
  });
}

const PAD = 30;
function pad(s, n = PAD) { return String(s).padEnd(n); }
function bar(label) { console.log('\n' + '='.repeat(70) + '\n' + label + '\n' + '='.repeat(70)); }

function renderFunnel(breakdown, totals) {
  const order = [
    'input', 'no-match', 'not-enriched', 'no-stats',
    'minute-out-of-range', 'computed', 'compute-null',
    'low-confidence', 'odd-out-of-range', 'cooldown', 'emitted',
  ];
  for (const stage of order) {
    const b = breakdown[stage] || { count: 0, pct: 0 };
    const t = totals[stage] || 0;
    const blocks = Math.round(b.pct / 5);
    const meter = '█'.repeat(blocks) + '·'.repeat(20 - blocks);
    console.log(`  ${pad(stage)} ${String(b.count).padStart(6)}  ${meter}  ${String(b.pct).padStart(5)}%   (total: ${t})`);
  }
}

function renderDrops(drops) {
  if (!drops.length) { console.log('  (nenhum descarte registrado)'); return; }
  for (const d of drops.slice(0, 20)) {
    const time = new Date(d.ts).toLocaleTimeString();
    const m = d.match || {};
    console.log(`  [${time}] ${d.stage.padEnd(22)} ${m.label || '-'}  ${m.league || ''}`);
    const detail = { ...d };
    delete detail.ts; delete detail.match; delete detail.stage;
    const extras = Object.entries(detail).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (extras.length) {
      console.log('       ↳ ' + extras.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  '));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const base = String(args.url).replace(/\/+$/, '');
  const dropsQs = `?drops=${Number(args.drops) || 30}`;

  bar('Robotrend IA — Diagnóstico de sinais');
  console.log(`URL base : ${base}`);
  if (!args.token) console.log('⚠️  Sem --token=... — rotas /debug exigem admin. Use --token=$ADMIN_JWT');

  let bet, sig;
  try {
    bet = await fetchJson(`${base}/api/football/bet-signals/debug${dropsQs}`, { token: args.token });
  } catch (e) {
    console.error('\n[ERRO] bet-signals/debug:', e.message);
    process.exitCode = 1;
  }
  try {
    sig = await fetchJson(`${base}/api/football/signals/debug${dropsQs}`, { token: args.token });
  } catch (e) {
    console.error('[ERRO] signals/debug:', e.message);
    process.exitCode = 1;
  }

  if (bet?.report) {
    const r = bet.report;
    bar('1) BET SIGNAL ENGINE — value-bets contínuo');
    console.log(`Modo: ${r.snapshot.mode}    Tick: ${r.snapshot.tickMs}ms    Iniciado: ${r.snapshot.started}`);
    console.log(`Thresholds:`);
    console.log(`  minConfidence : ${r.snapshot.minConfidence}`);
    console.log(`  oddRange      : [${r.snapshot.oddRange.min}, ${r.snapshot.oddRange.max}]`);
    console.log(`  minuteRange   : [${r.snapshot.minuteRange.min}, ${r.snapshot.minuteRange.max}]`);
    console.log(`  cooldownMs    : ${r.snapshot.cooldownMs}`);
    console.log(`\nFunil (totais acumulados desde start):`);
    renderFunnel(r.funnelBreakdown, r.funnelTotals);

    if (r.lastTickSummary) {
      console.log(`\nÚltimo tick (${new Date(r.lastTickAt).toLocaleTimeString()}, ${r.lastTickSummary.durationMs}ms):`);
      const ltot = Object.values(r.lastTickSummary).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
      console.log(`  ${JSON.stringify(r.lastTickSummary)}  (total ops: ${ltot})`);
    }

    console.log(`\nÚltimos descartes (motivo + detalhe):`);
    renderDrops(r.recentDrops);

    console.log(`\nÚltimos sinais emitidos (top 10):`);
    if (!r.recentEmitted?.length) console.log('  (nenhum sinal emitido)');
    else for (const s of r.recentEmitted) {
      console.log(`  ${pad(s.market, 8)} ${s.prediction}  conf=${s.confidence} odd=${s.odd} score=${s.score}  ${s.match?.home} x ${s.match?.away} (${s.match?.minute}′)`);
    }

    if (r.hints?.length) {
      bar('💡 Dicas automáticas — gargalo provável');
      for (const h of r.hints) console.log(`  • ${h}`);
    }
  }

  if (sig?.report) {
    const r = sig.report;
    bar('2) SIGNALS ENGINE — detectores reativos (event-driven)');
    console.log(`Ativo: ${r.snapshot.started}    Cooldown ativos: ${r.snapshot.activeCooldowns}`);
    console.log(`Thresholds:`, JSON.stringify(r.snapshot.thresholds, null, 2));
    console.log(`\nHistograma de descartes (type:reason → count):`);
    const entries = Object.entries(r.dropHistogram).sort((a, b) => b[1] - a[1]);
    if (!entries.length) console.log('  (nenhum descarte)');
    else for (const [k, v] of entries) console.log(`  ${pad(k, 36)} ${String(v).padStart(5)}`);
    console.log(`\nÚltimos descartes detalhados:`);
    renderDrops(r.recentDrops.map((d) => ({ ...d, stage: `${d.type}:${d.reason}`, match: { label: d.label, minute: d.minute } })));
    console.log(`\nÚltimos sinais emitidos:`);
    if (!r.recentSignals?.length) console.log('  (nenhum)');
    else for (const s of r.recentSignals) {
      console.log(`  ${pad(s.type, 20)} conf=${s.confidence} ${s.suggestion} (${s.minute}′)`);
    }
  }

  bar('Próximos passos');
  console.log('Se nenhum sinal está sendo emitido, tente:');
  console.log('  1) BET_SIGNAL_DEBUG=true     → log verboso por decisão');
  console.log('  2) BET_SIGNAL_TEST_MODE=true → afrouxa filtros (min conf 70, odd 1.20-10, sem cooldown)');
  console.log('  3) Verifique se o poller está recebendo fixtures e o enricher está populando match.stats');
  console.log('     curl ' + base + '/api/football/poller/health');
}

main().catch((e) => { console.error('Erro fatal:', e); process.exit(1); });
