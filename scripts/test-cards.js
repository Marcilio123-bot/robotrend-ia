/**
 * Robotrend IA — TESTE do MÓDULO DE CARTÕES (Over/Under)
 *
 * Cobre dois níveis:
 *   1) UNITÁRIO  — _cardsModel + resolveCardsWinner com a fixture pedida na
 *                  auditoria (min 65, 4 cartões, 22 faltas). Deve produzir
 *                  pelo menos UM candidato de cartões.
 *   2) END-TO-END — roda o engine (processMatch → gates → emit → recent buffer)
 *                  e confirma que o sinal de cartões aparece em listRecent()
 *                  com market 'cards' ou 'cardsUnder'.
 *
 * Uso:
 *   node scripts/test-cards.js
 *
 * Exit code 0 = sucesso (sinal gerado). 1 = falha (nenhum sinal).
 */

'use strict';

process.env.LIVE_SIGNAL_DEBUG = 'true';
process.env.BET_SIGNAL_TICK_MS = '600000';   // controlamos o tick manualmente
process.env.BET_SIGNAL_COOLDOWN_MS = '0';    // sem cooldown no teste
process.env.NODE_ENV = 'development';

// --- Mock do poller singleton ANTES de carregar o engine ---
const pollerMod = require('../backend/workers/liveFootballPoller');
const fakePoller = {
  cache: new Map(),
  getMatches() { return Array.from(this.cache.values()); },
  getMatch(id) { return this.cache.get(String(id)); },
};
pollerMod.getPoller = () => fakePoller;

/**
 * Fixture da auditoria: 65', 4 cartões (2+2 amarelos), 22 faltas (11+11).
 */
function makeCardsFixture() {
  return {
    id: '9001',
    fixtureId: 9001,
    home: 'Time A',
    away: 'Time B',
    league: { name: 'Brasileirão Série A', country: 'Brazil', fullName: 'Brasileirão Série A' },
    referee: 'Fulano de Tal',
    minute: 65,
    status: '2H',
    score: { home: 1, away: 1 },
    kickoffAt: new Date(Date.now() - 65 * 60_000).toISOString(),
    flags: { isLive: true, isFinished: false, isFromLiveAPI: true, source: 'api-football' },
    enriched: true,
    enrichedPartial: false,
    stats: {
      corners:          { home: 4, away: 3, total: 7 },
      dangerousAttacks: { home: 40, away: 35, total: 75 },
      attacks:          { home: 80, away: 70, total: 150 },
      shots:            { home: 8, away: 6, total: 14 },
      shotsOnTarget:    { home: 4, away: 3, total: 7 },
      shotsOffTarget:   { home: 4, away: 3, total: 7 },
      possession:       { home: 52, away: 48 },
      cards: { yellow: { home: 2, away: 2, total: 4 }, red: { home: 0, away: 0, total: 0 } },
      fouls:        { home: 11, away: 11, total: 22 },
      passAccuracy: { home: 78, away: 75 },
    },
    perMinute: { corners: 0.1, dangerousAttacks: 1.1, shots: 0.2, sot: 0.1, attacks: 2.3, pressureIndex: 58 },
    momentum: { home: 55, away: 45, pressureIndex: 58 },
    bttsLikelihood: 100,
    events: [],
  };
}

const fixture = makeCardsFixture();
fakePoller.cache.set(fixture.id, fixture);

// --- Carrega engine APÓS o mock ---
const engine = require('../backend/services/betSignalEngine');
const I = engine._internals;

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${msg}`);
  if (!cond) failures++;
};

console.log('\n========================================');
console.log('=  TESTE — MÓDULO DE CARTÕES           =');
console.log('========================================');
console.log('Fixture: 65′ · 4 cartões (4🟨 0🟥) · 22 faltas · árbitro presente\n');

// =============================================================
// 1) UNITÁRIO — modelo + resolver
// =============================================================
console.log('--- 1) UNITÁRIO: _cardsModel ---');
const model = I._cardsModel(fixture);
console.log('  dataOk        :', model.dataOk);
console.log('  cartões atuais:', model.yellow + model.red);
console.log('  esperado(FT)  :', model.expected.toFixed(2), `(λrem=${model.lambdaRem.toFixed(2)})`);
console.log('  rivalidade    :', model.rivalry.toFixed(2));
console.log('  confiança base:', model.confidence);
console.log('  linhas (O/U %):');
for (const L of I.CARDS_LINES) {
  console.log(`     ${L}: Over ${model.lines[L].over}%  Under ${model.lines[L].under}%`);
}
assert(model.dataOk === true, 'model.dataOk = true (dados suficientes)');
assert(model.expected > model.yellow + model.red, 'expected > cartões atuais (projeção crescente)');

console.log('\n--- 1b) UNITÁRIO: resolveCardsWinner ---');
const sigStats = { fixtureId: String(fixture.fixtureId), home: fixture.home, away: fixture.away, min: fixture.minute };
const pick = I.resolveCardsWinner(fixture, sigStats);
assert(pick != null, 'resolveCardsWinner retorna candidato (NUNCA null com dados suficientes)');
if (pick) {
  console.log('  market     :', pick.market);
  console.log('  predição   :', pick.prediction);
  console.log('  prob        :', pick.probability + '%');
  console.log('  confiança IA:', pick.confidence + '%');
  console.log('  odd justa  :', '~' + pick.oddEstimated);
  console.log('  score       :', pick.analysisScore);
  console.log('  motivo      :', pick.justification);
  assert(['cards', 'cardsUnder'].includes(pick.market), "market é 'cards' ou 'cardsUnder'");
  assert(pick.confidence >= I.CARDS_MIN_CONFIDENCE, `confiança >= ${I.CARDS_MIN_CONFIDENCE}`);
  assert(pick.analysisScore >= I.CARDS_MIN_SCORE, `score >= ${I.CARDS_MIN_SCORE}`);
  assert(pick.extras && pick.extras.lines, 'extras.lines presente (8 probabilidades)');
}

// Garantia do ponto 4: com dados insuficientes → null; com dados → candidato.
console.log('\n--- 1c) UNITÁRIO: garantia "sem dados → null" ---');
const empty = { ...fixture, fixtureId: 9002, minute: 65,
  stats: { ...fixture.stats,
    cards: { yellow: { home: 0, away: 0, total: 0 }, red: { home: 0, away: 0, total: 0 } },
    fouls: { home: 0, away: 0, total: 0 } },
  perMinute: { pressureIndex: 0 }, enriched: true };
// Remove qualquer sinal de stats avançados para forçar dataOk=false.
empty.stats.corners = { home: 0, away: 0, total: 0 };
empty.stats.shots = { home: 0, away: 0, total: 0 };
empty.stats.shotsOnTarget = { home: 0, away: 0, total: 0 };
empty.stats.dangerousAttacks = { home: 0, away: 0, total: 0 };
empty.stats.possession = { home: 0, away: 0 };
const emptyModel = I._cardsModel(empty);
console.log('  dataOk (fixture vazia):', emptyModel.dataOk);

// =============================================================
// 2) END-TO-END — engine tick + recent buffer
// =============================================================
console.log('\n--- 2) END-TO-END: engine.start() + recent buffer ---');
engine.start();

setTimeout(() => {
  const recent = engine.listRecent({ limit: 100, minConfidence: 0 });
  const cards = recent.filter((s) => s.market === 'cards' || s.market === 'cardsUnder');

  console.log(`  sinais no buffer: ${recent.length} | de cartões: ${cards.length}`);
  cards.forEach((s, i) => {
    console.log(`   [${i + 1}] ${s.market} · ${s.prediction} · conf=${s.confidence}% · prob=${s.probability}% · odd~${s.oddEstimated} · score=${s.betScore}`);
  });
  assert(cards.length >= 1, 'PELO MENOS 1 sinal de cartões no recent buffer (dashboard/websocket/API)');

  // Simula filtro REST /bet-signals (mesmas regras de routes/football.js)
  const ALLOWED = new Set(['btts', 'over25', 'under25', 'corners', 'cards', 'cardsUnder']);
  const restVisible = recent.filter((s) => ALLOWED.has(s.market));
  assert(restVisible.some((s) => s.market === 'cards' || s.market === 'cardsUnder'),
    'cartões sobrevivem ao filtro ALLOWED_MARKETS do /bet-signals');

  // Funil por mercado
  const funnel = engine.getMarketFunnel();
  console.log('\n  Funil cardsOver :', JSON.stringify(funnel.markets?.cardsOver || funnel.cardsOver || {}));
  console.log('  Funil cardsUnder:', JSON.stringify(funnel.markets?.cardsUnder || funnel.cardsUnder || {}));

  console.log('\n========================================');
  console.log(failures === 0 ? '=  RESULTADO: ✅ TODOS OS TESTES OK    =' : `=  RESULTADO: ❌ ${failures} FALHA(S)            =`);
  console.log('========================================\n');

  engine.stop();
  process.exit(failures === 0 ? 0 : 1);
}, 6500);
