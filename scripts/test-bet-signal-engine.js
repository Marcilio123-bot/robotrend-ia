/**
 * Robotrend IA — TESTE END-TO-END do betSignalEngine
 *
 * Roda o pipeline completo (processMatch → compute*Bet → emit → recent buffer)
 * com partidas sintéticas que reproduzem o perfil estatístico de jogos reais
 * SEM stats avançados (skeleton-only — cenário ENRICH_ENABLED=false em produção).
 *
 * Uso:
 *   node scripts/test-bet-signal-engine.js
 *
 * Saída: logs [LIVE PIPELINE] + relatório consolidado.
 */

'use strict';

process.env.LIVE_SIGNAL_DEBUG = 'true';
process.env.BET_SIGNAL_TICK_MS = '600000';      // tick interno longo (controlamos manualmente)
process.env.BET_SIGNAL_COOLDOWN_MS = '0';       // desliga cooldown para teste end-to-end
process.env.NODE_ENV = 'development';

// =============================================================
// MOCK do poller singleton ANTES de carregar o engine.
// O engine resolve via require('../workers/liveFootballPoller').getPoller().
// =============================================================
const pollerMod = require('../backend/workers/liveFootballPoller');
const fakePoller = {
  cache: new Map(),
  getMatches() { return Array.from(this.cache.values()); },
  getMatch(id) { return this.cache.get(String(id)); },
};
pollerMod.getPoller = () => fakePoller;

// Helper: monta match sintético no formato que o engine espera (skeleton + stats zerados,
// idêntico ao output de applyMinimalEnrichment).
function makeMatch({ id, home, away, league = 'TestLiga', minute, sh = 0, sa = 0, possH = 50 }) {
  return {
    id: String(id),
    fixtureId: id,
    home,
    away,
    league: { name: league, country: 'BR' },
    minute,
    status: minute < 45 ? '1H' : '2H',
    score: { home: sh, away: sa },
    kickoffAt: new Date(Date.now() - minute * 60_000).toISOString(),
    flags: { isLive: true, isFinished: false, isFromLiveAPI: true, source: 'api-football' },
    enriched: true,
    enrichedPartial: true,
    stats: {
      corners:          { home: 0, away: 0, total: 0 },
      dangerousAttacks: { home: 0, away: 0, total: 0 },
      attacks:          { home: 0, away: 0, total: 0 },
      shots:            { home: 0, away: 0, total: 0 },
      shotsOnTarget:    { home: 0, away: 0, total: 0 },
      shotsOffTarget:   { home: 0, away: 0, total: 0 },
      possession:       { home: possH, away: 100 - possH },
      cards: { yellow: { home: 0, away: 0, total: 0 }, red: { home: 0, away: 0, total: 0 } },
      fouls:        { home: 0, away: 0, total: 0 },
      passAccuracy: { home: 0, away: 0 },
    },
    perMinute: { corners: 0, dangerousAttacks: 0, shots: 0, sot: 0, attacks: 0, pressureIndex: 0.3 },
    momentum: { home: 50, away: 50, pressureIndex: 0.3 },
    bttsLikelihood: (sh > 0 && sa > 0) ? 100 : Math.min(60, Math.round((sh + sa) * 20 + minute * 0.3)),
    events: [],
  };
}

// =============================================================
// Distribuição de jogos sintéticos (12 partidas) cobrindo perfis típicos:
// 0×0 cedo, 0×0 médio, 1×0 várias fases, 1×1 final, 2×0, 0×1 etc.
// =============================================================
const matches = [
  makeMatch({ id: 1001, home: 'Bayern',          away: 'Dortmund',        minute: 35, sh: 0, sa: 0 }),
  makeMatch({ id: 1002, home: 'Real Madrid',     away: 'Barcelona',       minute: 50, sh: 0, sa: 0 }),
  makeMatch({ id: 1003, home: 'Manchester City', away: 'Liverpool',       minute: 45, sh: 1, sa: 0 }),
  makeMatch({ id: 1004, home: 'PSG',             away: 'Lyon',            minute: 55, sh: 1, sa: 0 }),
  makeMatch({ id: 1005, home: 'Inter',           away: 'Milan',           minute: 65, sh: 1, sa: 0 }),
  makeMatch({ id: 1006, home: 'Juventus',        away: 'Roma',            minute: 70, sh: 0, sa: 0 }),
  makeMatch({ id: 1007, home: 'Ajax',            away: 'PSV',             minute: 80, sh: 1, sa: 1 }),
  makeMatch({ id: 1008, home: 'Atletico',        away: 'Betis',           minute: 78, sh: 1, sa: 1 }),
  makeMatch({ id: 1009, home: 'Flamengo',        away: 'Palmeiras',       minute: 30, sh: 1, sa: 0 }),
  makeMatch({ id: 1010, home: 'Sao Paulo',       away: 'Corinthians',     minute: 60, sh: 0, sa: 1 }),
  makeMatch({ id: 1011, home: 'Santos',          away: 'Vasco',           minute: 25, sh: 0, sa: 0 }),
  makeMatch({ id: 1012, home: 'Gremio',          away: 'Internacional',   minute: 48, sh: 0, sa: 0, possH: 60 }),
];

for (const m of matches) fakePoller.cache.set(m.id, m);

// =============================================================
// Carrega engine APÓS mock (importante)
// =============================================================
const engine = require('../backend/services/betSignalEngine');

console.log('\n========================================');
console.log('=  TESTE END-TO-END betSignalEngine    =');
console.log('========================================');
console.log('Total de partidas no poller mock:', matches.length);
console.log('Modo: ENRICH_ENABLED=false simulado (skeleton + applyMinimalEnrichment)');
console.log('Configs ativas:');
console.log('  MIN_CONFIDENCE = 65 (FREE)');
console.log('  PREMIUM_MIN_CONFIDENCE = 75');
console.log('  ODD range = [1.80, 2.20]');
console.log('  MINUTE range = [20, 85]');
console.log('  COOLDOWN = 0 (desligado para teste)');
  console.log('  BASELINE_XG_PER_MIN = 0.0180');
console.log('========================================\n');

// =============================================================
// Inicia engine + força um tick (start() agenda tick em 5s)
// =============================================================
engine.start();

// Aguarda 6s para o setTimeout interno (5s) executar + margem
setTimeout(() => {
  const recent = engine.listRecent({ limit: 100, minConfidence: 0 });

  console.log('\n========================================');
  console.log('=  RELATÓRIO FINAL                     =');
  console.log('========================================');
  console.log('Total de partidas processadas: ', matches.length);
  console.log('Total de sinais emitidos:      ', recent.length);
  console.log('');

  const byMarket = { corners: 0, btts: 0, win: 0, goals: 0 };
  const byTier   = { free: 0, premium: 0 };
  for (const s of recent) {
    byMarket[s.market] = (byMarket[s.market] || 0) + 1;
    byTier[s.tier]     = (byTier[s.tier]     || 0) + 1;
  }

  console.log('Por mercado:');
  console.log('  - Escanteios (corners): ', byMarket.corners);
  console.log('  - BTTS (Ambas Marcam):  ', byMarket.btts);
  console.log('  - Vitória (win):        ', byMarket.win);
  console.log('  - Gols:                 ', byMarket.goals);
  console.log('');
  console.log('Por tier:');
  console.log('  - FREE   (conf 65–74):  ', byTier.free);
  console.log('  - PREMIUM (conf >= 75): ', byTier.premium);
  console.log('');

  // Funil completo
  const debug = engine.debugReport({ dropLimit: 30 });
  console.log('Funil de descarte (acumulado):');
  for (const [k, v] of Object.entries(debug.funnelTotals)) {
    if (v > 0) console.log(`  ${k.padEnd(22)} ${v}`);
  }
  console.log('');

  // Exemplos reais
  if (recent.length) {
    console.log('========================================');
    console.log('=  EXEMPLOS DE SINAIS PRODUZIDOS       =');
    console.log('========================================');
    recent.slice(0, 8).forEach((s, i) => {
      console.log(`\n  Sinal ${i + 1}:`);
      console.log(`    Mercado:    ${s.market}`);
      console.log(`    Predição:   ${s.prediction}`);
      console.log(`    Confiança:  ${s.confidence}%`);
      console.log(`    Probab.:    ${s.probability}%`);
      console.log(`    Odd:        ~${s.oddEstimated}`);
      console.log(`    Tier:       ${s.tier}`);
      console.log(`    Match:      ${s.match.home} × ${s.match.away}`);
      console.log(`    Minuto:     ${s.match.minute}'`);
      console.log(`    Placar:     ${s.match.score.home}×${s.match.score.away}`);
      console.log(`    Justif.:    ${s.justification}`);
    });
  } else {
    console.log('========================================');
    console.log('=  NENHUM SINAL EMITIDO                =');
    console.log('========================================');
    console.log('Drops dos últimos N processamentos:');
    debug.recentDrops.slice(0, 15).forEach((d, i) => {
      console.log(`  ${i + 1}. ${d.stage} | ${d.match?.label || '?'} | conf=${d.confidence ?? '-'} | odd=${d.oddEstimated ?? '-'} | ${d.prediction || ''}`);
    });
  }

  console.log('\n========================================');
  console.log('=  SIMULAÇÃO REST GET /api/bet-signals =');
  console.log('========================================');
  // Filtro REST (mesmas regras de routes/football.js)
  const restFREE = recent.filter((s) => s.tier !== 'premium');
  const restPREM = recent;
  console.log(`FREE   ?minConfidence=70  → ${restFREE.filter(s => s.confidence >= 70).length} sinais`);
  console.log(`FREE   ?minConfidence=0   → ${restFREE.length} sinais`);
  console.log(`PREMIUM ?minConfidence=70 → ${restPREM.filter(s => s.confidence >= 70).length} sinais`);
  console.log(`PREMIUM ?minConfidence=0  → ${restPREM.length} sinais`);

  // Frontend KPIs
  console.log('\n========================================');
  console.log('=  KPIs ESPERADOS NO FRONTEND          =');
  console.log('========================================');
  if (recent.length) {
    const avgConf = Math.round(recent.reduce((s, x) => s + (x.confidence || 0), 0) / recent.length);
    const odds = recent.map((x) => x.oddEstimated).filter(Number.isFinite);
    const avgOdd = odds.length ? (odds.reduce((s, v) => s + v, 0) / odds.length).toFixed(2) : '—';
    const tally = {};
    for (const s of recent) tally[s.market] = (tally[s.market] || 0) + 1;
    const topMarket = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
    console.log('Sinais nas últimas 2h:', recent.length);
    console.log('Confiança média:       ', avgConf + '%');
    console.log('Odd média estimada:    ', avgOdd);
    console.log('Mercado mais ativo:    ', topMarket);
  } else {
    console.log('Tudo zerado.');
  }

  engine.stop();
  process.exit(0);
}, 6500);
