/**
 * Robotrend IA — Smoke test do serviço API-Football
 *
 * Roda offline (sem rede) checagens estruturais + se houver API_FOOTBALL_KEY,
 * dispara uma chamada real para confirmar que a integração responde.
 *
 *   npm run test:apifootball
 */

'use strict';

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

const af = require('../backend/services/apiFootball');

const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  yel:   (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  gray:  (s) => `\x1b[90m${s}\x1b[0m`,
};

let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { console.log(`  ${colors.green('✔')} ${name}`); passed++; }
  else      { console.log(`  ${colors.red('✘')} ${name}` + (extra ? ' ' + colors.gray(extra) : '')); failed++; }
}

async function main() {
  console.log(colors.cyan('\n━━━ Robotrend IA · Smoke test API-Football ━━━\n'));

  /* ============================================================
     1) Sanity check — service loaded e configurado
     ============================================================ */
  console.log(colors.yel('▶ Configuração'));
  const s = af.status();
  check('módulo carregou', typeof af.get === 'function');
  check('exporta helpers obrigatórios', [
    'getLiveFixtures', 'getFixturesByDate', 'getFixtureById',
    'getFixturesByTeam', 'getFixtureStatistics', 'getFixtureEvents',
    'getFixtureLineups', 'getHeadToHead', 'getPredictions',
    'getOdds', 'getOddsLive', 'getTeamStatistics', 'getLeagues',
  ].every((fn) => typeof af[fn] === 'function'));

  console.log(`    host       : ${colors.cyan(s.host)}`);
  console.log(`    baseURL    : ${colors.cyan(s.baseURL)}`);
  console.log(`    legacy RP  : ${colors.cyan(s.legacyRapidApi)}`);
  console.log(`    configured : ${colors.cyan(s.configured)}`);
  console.log(`    rate/min   : ${colors.cyan(s.rateLimit.perMin)} · /dia: ${colors.cyan(s.rateLimit.perDay)}`);
  console.log(`    cacheStore : ${colors.cyan(s.cacheStore?.backend || 'unknown')}`);
  console.log(`    breaker    : ${colors.cyan(s.breaker?.state || 'unknown')}`);

  check('baseURL coerente com host', s.baseURL.includes(s.host));
  check('cacheStore configurado',   !!s.cacheStore);
  check('circuit breaker ativo',    s.breaker?.state === 'CLOSED');

  /* ============================================================
     2) Validação sem rede — chamar get() sem key deve falhar limpo
     ============================================================ */
  console.log(colors.yel('\n▶ Validações offline'));
  if (!s.configured) {
    try {
      await af.getLiveFixtures();
      check('falha sem API_KEY', false, 'esperado erro');
    } catch (e) {
      check('falha sem API_KEY (mensagem clara)', /API_FOOTBALL_KEY/.test(e.message), e.message);
    }
  } else {
    check('API_KEY presente', true);
  }

  /* ============================================================
     3) Chamada real (somente se KEY definida)
     ============================================================ */
  if (s.configured) {
    console.log(colors.yel('\n▶ Live call (GET /fixtures?live=all)'));
    try {
      const live = await af.getLiveFixtures();
      check('resposta é array', Array.isArray(live));
      console.log(`    ${colors.gray('partidas ao vivo:')} ${colors.cyan(live.length)}`);
      const q = af.quota();
      console.log(`    ${colors.gray('quota diária restante :')} ${colors.cyan(q.dailyRemaining ?? '—')}`);
      console.log(`    ${colors.gray('quota minuto restante :')} ${colors.cyan(q.minuteRemaining ?? '—')}`);

      // tenta enriquecer 1 fixture (statistics, events, lineups)
      if (live[0]?.fixture?.id) {
        const id = live[0].fixture.id;
        console.log(colors.yel(`\n▶ Enriquecimento fixture ${id}`));
        const [stats, events, lineups] = await Promise.all([
          af.getFixtureStatistics(id).catch((e) => { console.log(colors.red('    statistics erro: ') + e.message); return null; }),
          af.getFixtureEvents(id).catch((e) => { console.log(colors.red('    events erro: ') + e.message); return null; }),
          af.getFixtureLineups(id).catch((e) => { console.log(colors.red('    lineups erro: ') + e.message); return null; }),
        ]);
        if (stats)   console.log(`    ${colors.gray('stats blocks  :')} ${colors.cyan(stats.length)}`);
        if (events)  console.log(`    ${colors.gray('events        :')} ${colors.cyan(events.length)}`);
        if (lineups) console.log(`    ${colors.gray('lineups       :')} ${colors.cyan(lineups.length)}`);
        check('enriquecimento ao menos parcial', stats || events || lineups);
      } else {
        console.log(colors.gray('    sem partida ao vivo p/ enriquecer (ok)'));
      }
    } catch (e) {
      check('chamada live respondeu', false, e.message);
    }
  } else {
    console.log(colors.gray('\n  ↪ defina API_FOOTBALL_KEY no .env para validar chamada real'));
  }

  /* ============================================================
     4) Sumário
     ============================================================ */
  console.log(colors.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`  ${colors.green('✔ passed')}  ${passed}`);
  console.log(`  ${colors.red('✘ failed')}  ${failed}`);
  console.log(colors.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(colors.red('FATAL: ' + e.message));
  process.exit(1);
});
