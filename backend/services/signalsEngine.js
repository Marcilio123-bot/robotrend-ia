/**
 * Robotrend IA — Signals Engine v1 (fundação)
 *
 * Engine de sinais automáticos baseada em eventos do bus de futebol +
 * snapshots históricos persistidos.
 *
 * Detectores plugáveis (cada um pode ser habilitado/desabilitado por env):
 *
 *   - PressureScoreDetector   : detecta surto sustentado de pressão ofensiva
 *   - BttsImminentDetector    : 1x0/0x1 com pressão alta do lado perdedor
 *   - CornersMomentumDetector : >= N escanteios em X minutos com escalada
 *   - OverCornersDetector     : projeção de mais escanteios no minuto X
 *
 * Princípios:
 *   - LISTEN-ONLY: não chama API. Consome apenas o EventBus + snapshots.
 *   - IDEMPOTENTE: cooldown por (matchId × tipo) evita duplicar sinais.
 *   - PUBLISHA: emite `signal:fire` no bus + log estruturado + métricas.
 *               Quem quiser persistir/dispatch pode ouvir esse evento.
 *
 * Para a IA "real" (treinada em histórico), `score()` pode ser
 * estendido posteriormente carregando pesos de um arquivo/DB. Por ora,
 * usamos heurísticas explicáveis (white-box) que são auditáveis.
 */

'use strict';

const events = require('./footballEvents');
const metrics = require('./metrics');
const { logger } = require('../logger');
// history fica disponível para evolução futura (IA com base em snapshots)
// const history = require('./footballHistory');

const log = logger.child({ module: 'signalsEngine' });

const ENABLED            = String(process.env.SIGNALS_ENABLED || 'true').toLowerCase() !== 'false';
const COOLDOWN_MS        = Number(process.env.SIGNALS_COOLDOWN_MS || 6 * 60_000);
const DEBUG_MODE         = String(process.env.SIGNALS_DEBUG || 'false').toLowerCase() === 'true';
const DROPS_MAX          = Number(process.env.SIGNALS_DROPS_MAX || 100);

const PRESSURE_MIN       = Number(process.env.SIGNALS_PRESSURE_MIN || 70);
const PRESSURE_RAMP_DELTA = Number(process.env.SIGNALS_PRESSURE_RAMP_DELTA || 18);

const BTTS_MIN_MINUTE    = Number(process.env.SIGNALS_BTTS_MIN_MINUTE || 35);
const BTTS_MAX_MINUTE    = Number(process.env.SIGNALS_BTTS_MAX_MINUTE || 80);
const BTTS_MIN_PRESSURE  = Number(process.env.SIGNALS_BTTS_MIN_PRESSURE || 60);

const CORNERS_WINDOW_MIN = Number(process.env.SIGNALS_CORNERS_WINDOW_MIN || 8);
const CORNERS_MIN_COUNT  = Number(process.env.SIGNALS_CORNERS_MIN_COUNT || 4);

const OVER_CORNERS_MIN_RATE = Number(process.env.SIGNALS_OVER_CORNERS_MIN_RATE || 0.18); // escanteios/min

// Cards & Over-goals
const CARDS_WINDOW_MIN     = Number(process.env.SIGNALS_CARDS_WINDOW_MIN || 10);
const CARDS_MIN_COUNT      = Number(process.env.SIGNALS_CARDS_MIN_COUNT || 3);   // 3+ amarelos em 10min
const CARDS_INCLUDE_RED    = String(process.env.SIGNALS_CARDS_INCLUDE_RED || 'true').toLowerCase() !== 'false';

const OVER_GOALS_MIN_RATE  = Number(process.env.SIGNALS_OVER_GOALS_MIN_RATE || 0.035); // gols/min (~3+ em 90)
const OVER_GOALS_MIN_MIN   = Number(process.env.SIGNALS_OVER_GOALS_MIN_MINUTE || 25);
const OVER_GOALS_MAX_MIN   = Number(process.env.SIGNALS_OVER_GOALS_MAX_MINUTE || 70);

// Threshold mínimo p/ entrar no Radar (frontend ainda pode subir)
const RADAR_MIN_CONFIDENCE = Number(process.env.SIGNALS_RADAR_MIN_CONFIDENCE || 70);

const m_fired   = metrics.counter('signals_fired_total');
const m_skipped = metrics.counter('signals_skipped_total');
const m_score   = metrics.histogram('signals_confidence');
const m_market  = metrics.counter('signals_by_market_total');

/**
 * Mercados suportados pelo Radar. Cada signal type pertence a UM mercado
 * (ou múltiplos via `markets:[]` em casos de cross-market como `pressure-surge`
 * que indica risco de gol → goals/btts).
 *
 * Frontend usa isso para filtrar sinais por chip selecionado.
 */
const MARKET = {
  CORNERS: 'corners',
  GOALS:   'goals',
  BTTS:    'btts',
  CARDS:   'cards',
  PRESSURE:'pressure',
};
const TYPE_TO_MARKETS = {
  'pressure-surge'   : [MARKET.PRESSURE, MARKET.GOALS],
  'btts-imminent'    : [MARKET.BTTS, MARKET.GOALS],
  'corners-momentum' : [MARKET.CORNERS],
  'over-corners'     : [MARKET.CORNERS],
  'over-goals'       : [MARKET.GOALS],
  'cards-surge'      : [MARKET.CARDS],
};
function marketsFor(type) { return TYPE_TO_MARKETS[type] || []; }

const cooldowns = new Map(); // `${matchId}:${type}` -> ts
const RECENT_MAX = Number(process.env.SIGNALS_RECENT_MAX || 200);
const recent = []; // ring buffer dos últimos sinais (para /signals/live)

/* ============================================================
   DIAGNÓSTICO — ring buffer de descartes + histograma por motivo
   ============================================================ */
const recentDrops = []; // { ts, type, reason, matchId, label?, minute? }
const dropHistogram = {}; // `${type}:${reason}` -> count
function recordDrop(type, reason, payload = {}) {
  const key = `${type}:${reason}`;
  dropHistogram[key] = (dropHistogram[key] || 0) + 1;
  recentDrops.unshift({ ts: Date.now(), type, reason, ...payload });
  if (recentDrops.length > DROPS_MAX) recentDrops.length = DROPS_MAX;
  if (DEBUG_MODE) log.info('signal DROP', { type, reason, ...payload });
}

/* ============================================================
   HELPERS
   ============================================================ */
function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function canFire(key, cooldownMs = COOLDOWN_MS) {
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < cooldownMs) return false;
  cooldowns.set(key, now);
  return true;
}
function losingSide(match) {
  const sh = n(match.score?.home), sa = n(match.score?.away);
  if (sh > sa) return 'away';
  if (sa > sh) return 'home';
  return null;
}

/* ============================================================
   DETECTORS
   ============================================================ */
function fireSignal(signal) {
  // Enriquece com mercados (sempre) p/ o frontend filtrar
  if (!signal.markets || !signal.markets.length) signal.markets = marketsFor(signal.type);
  if (!signal.market) signal.market = signal.markets[0] || 'unknown';

  m_fired.inc(1, { type: signal.type, market: signal.market });
  m_score.observe(signal.confidence, { type: signal.type });
  for (const mk of signal.markets) m_market.inc(1, { market: mk });

  log.info('signal:fire', {
    type: signal.type, conf: signal.confidence,
    market: signal.market, markets: signal.markets,
    match: signal.matchId, suggestion: signal.suggestion,
  });
  recent.unshift(signal);
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  events.emit('signal:fire', signal);
}

/**
 * Lista sinais recentes. Suporta filtros:
 *   - type:        'pressure-surge' | 'btts-imminent' | …
 *   - markets:     'corners,btts'   (CSV → match em qualquer um)
 *   - minConfidence: 0..100
 *   - sinceMs:     filtra por createdAt > now - sinceMs
 *   - limit:       default 50
 */
function listRecent({ limit = 50, type = null, markets = null, minConfidence = 0, sinceMs = 0 } = {}) {
  let out = recent;
  if (type) out = out.filter((s) => s.type === type);
  if (markets) {
    const wanted = new Set(
      (Array.isArray(markets) ? markets : String(markets).split(','))
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean)
    );
    if (wanted.size) {
      out = out.filter((s) => (s.markets || []).some((m) => wanted.has(m)));
    }
  }
  if (minConfidence) out = out.filter((s) => s.confidence >= minConfidence);
  if (sinceMs) {
    const cutoff = Date.now() - sinceMs;
    out = out.filter((s) => new Date(s.createdAt).getTime() >= cutoff);
  }
  return out.slice(0, limit);
}

function skip(reason, type, match = null, extras = {}) {
  m_skipped.inc(1, { type, reason });
  recordDrop(type, reason, {
    matchId: match?.fixtureId || match?.id || null,
    label: match ? `${match.home || '?'} x ${match.away || '?'}` : null,
    minute: match?.minute ?? null,
    ...extras,
  });
}

/**
 * 1) PressureScoreDetector
 *    Dispara quando pressão >= MIN E veio com ramp positivo recente.
 *    Sugestão padrão: "Próximo gol provável" (1.5+ ou Asian Handicap +0.25).
 */
function onPressure({ match, pressure, delta }) {
  if (!match) return;
  if (pressure < PRESSURE_MIN || delta < PRESSURE_RAMP_DELTA) {
    skip('threshold', 'pressure-surge', match, { pressure, delta, min: PRESSURE_MIN }); return;
  }
  const key = `${match.id}:pressure`;
  if (!canFire(key)) { skip('cooldown', 'pressure-surge', match); return; }

  const side = match.stats?.shotsOnTarget?.home > match.stats?.shotsOnTarget?.away ? 'home' : 'away';
  const confidence = clamp(Math.round(50 + (pressure - PRESSURE_MIN) * 0.6 + delta * 0.4), 60, 98);

  fireSignal({
    type: 'pressure-surge',
    matchId: match.fixtureId,
    home: match.home, away: match.away,
    league: match.league?.name,
    minute: match.minute,
    snapshot: {
      score: match.score,
      corners: match.stats?.corners?.total,
      dangerousAttacks: match.stats?.dangerousAttacks?.total,
      shots: match.stats?.shots?.total,
      shotsOnTarget: match.stats?.shotsOnTarget?.total,
      possession: match.stats?.possession?.home,
    },
    pressure,
    pressureDelta: delta,
    side,
    suggestion: side === 'home'
      ? `Pressão alta ${match.home} — próximo gol em foco`
      : `Pressão alta ${match.away} — próximo gol em foco`,
    classification: { label: pressure >= 85 ? 'HOT' : 'WARM', emoji: pressure >= 85 ? '🔥' : '⚡' },
    risk: pressure >= 85 ? { level: 'MED', emoji: '🟡', label: 'MÉDIO' } : { level: 'MED-LOW', emoji: '🟢', label: 'BAIXO-MÉD' },
    confidence,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 2) BttsImminentDetector
 *    1x0 ou 0x1 + minuto entre 35-80 + lado perdedor com pressão alta.
 *    Já existe `fixture:btts-near` no poller, mas aqui escoramos com
 *    pressão e finalizações para um sinal mais confiável.
 */
function onBttsNear({ match, reason }) {
  if (!match) return;
  const min = n(match.minute);
  if (min < BTTS_MIN_MINUTE || min > BTTS_MAX_MINUTE) { skip('minute-range', 'btts-imminent', match, { minute: min, range: [BTTS_MIN_MINUTE, BTTS_MAX_MINUTE] }); return; }
  const sh = n(match.score?.home), sa = n(match.score?.away);
  if (!((sh > 0 && sa === 0) || (sa > 0 && sh === 0))) { skip('not-1-0', 'btts-imminent', match, { score: { home: sh, away: sa } }); return; }

  const losing = losingSide(match);
  if (!losing) return;
  const sotLosing = n(match.stats?.shotsOnTarget?.[losing]);
  const dangLosing = n(match.stats?.dangerousAttacks?.[losing]);
  const cornersLosing = n(match.stats?.corners?.[losing]);
  const pressureLosing = sotLosing * 12 + dangLosing * 0.5 + cornersLosing * 4;
  if (pressureLosing < BTTS_MIN_PRESSURE) { skip('pressure-low', 'btts-imminent', match, { pressureLosing, minRequired: BTTS_MIN_PRESSURE }); return; }

  const key = `${match.id}:btts-imminent`;
  if (!canFire(key)) { skip('cooldown', 'btts-imminent', match); return; }

  const confidence = clamp(Math.round(55 + (pressureLosing - BTTS_MIN_PRESSURE) * 0.6 + (sotLosing * 3)), 60, 95);

  fireSignal({
    type: 'btts-imminent',
    matchId: match.fixtureId,
    home: match.home, away: match.away,
    league: match.league?.name,
    minute: match.minute,
    snapshot: { score: match.score, corners: match.stats?.corners?.total, dangerousAttacks: match.stats?.dangerousAttacks?.total },
    losingSide: losing,
    losingPressure: Math.round(pressureLosing),
    suggestion: `BTTS — ${losing === 'home' ? match.home : match.away} prestes a empatar`,
    reasonHint: reason,
    classification: { label: 'BTTS-NEAR', emoji: '🎯' },
    risk: { level: 'MED', emoji: '🟡', label: 'MÉDIO' },
    confidence,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 3) CornersMomentumDetector
 *    Dispara quando >= CORNERS_MIN_COUNT escanteios surgem em CORNERS_WINDOW_MIN
 *    minutos (delta vindo do poller). Aqui contamos via `fixture:corner`.
 */
const cornerWindow = new Map(); // matchId -> [{ ts, minute }]
function onCorner({ match }) {
  if (!match) return;
  const id = String(match.id);
  const now = Date.now();
  const list = cornerWindow.get(id) || [];
  list.push({ ts: now, minute: match.minute });
  const cutoff = now - CORNERS_WINDOW_MIN * 60_000;
  while (list.length && list[0].ts < cutoff) list.shift();
  cornerWindow.set(id, list);

  if (list.length < CORNERS_MIN_COUNT) return;

  const key = `${id}:corners-momentum`;
  if (!canFire(key)) { skip('cooldown', 'corners-momentum', match); return; }

  const confidence = clamp(55 + (list.length - CORNERS_MIN_COUNT) * 8, 60, 95);

  fireSignal({
    type: 'corners-momentum',
    matchId: match.fixtureId,
    home: match.home, away: match.away,
    league: match.league?.name,
    minute: match.minute,
    snapshot: { corners: match.stats?.corners?.total },
    burst: list.length,
    windowMin: CORNERS_WINDOW_MIN,
    suggestion: `Over de escanteios — surto recente (${list.length} em ${CORNERS_WINDOW_MIN}min)`,
    classification: { label: 'CORNER-BURST', emoji: '🚩' },
    risk: { level: 'LOW', emoji: '🟢', label: 'BAIXO' },
    confidence,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 4) OverCornersDetector
 *    Projeção baseada em escanteios/minuto. Se ritmo >= MIN_RATE e o
 *    minuto está entre 35-65, projeta atingir um threshold no fim.
 */
function onMatchUpdate({ match }) {
  if (!match) return;
  const min = n(match.minute);
  if (min < 35 || min > 65) return;
  const rate = n(match.perMinute?.corners);
  if (rate < OVER_CORNERS_MIN_RATE) return;
  const totalCorners = n(match.stats?.corners?.total);
  const projected90 = Math.round(rate * 95);
  if (projected90 < totalCorners + 3) return; // sem upside

  const key = `${match.id}:over-corners`;
  if (!canFire(key)) { skip('cooldown', 'over-corners', match); return; }

  const confidence = clamp(50 + Math.round((rate - OVER_CORNERS_MIN_RATE) * 200), 55, 90);

  fireSignal({
    type: 'over-corners',
    matchId: match.fixtureId,
    home: match.home, away: match.away,
    league: match.league?.name,
    minute: match.minute,
    snapshot: { corners: totalCorners },
    rateCornersPerMin: rate,
    projected90,
    suggestion: `Over ${Math.floor(projected90 - 0.5)}.5 escanteios projetado (ritmo ${rate.toFixed(2)}/min)`,
    classification: { label: 'OVER-CORNERS', emoji: '📈' },
    risk: { level: 'LOW', emoji: '🟢', label: 'BAIXO' },
    confidence,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 5) CardsSurgeDetector (mercado: cards)
 *    Dispara quando >= CARDS_MIN_COUNT cartões surgem em CARDS_WINDOW_MIN
 *    minutos. Cartão vermelho conta como 1.5 (peso maior).
 */
const cardWindow = new Map(); // matchId -> [{ ts, color }]
function onCard({ match, color }) {
  if (!match) return;
  if (!CARDS_INCLUDE_RED && color === 'red') return;
  const id = String(match.id);
  const now = Date.now();
  const list = cardWindow.get(id) || [];
  list.push({ ts: now, color });
  const cutoff = now - CARDS_WINDOW_MIN * 60_000;
  while (list.length && list[0].ts < cutoff) list.shift();
  cardWindow.set(id, list);

  // peso: amarelo=1, vermelho=1.5
  const weighted = list.reduce((s, x) => s + (x.color === 'red' ? 1.5 : 1), 0);
  if (weighted < CARDS_MIN_COUNT) return;

  const key = `${id}:cards-surge`;
  if (!canFire(key)) { skip('cooldown', 'cards-surge', match); return; }

  const reds = list.filter((x) => x.color === 'red').length;
  const confidence = clamp(55 + Math.round((weighted - CARDS_MIN_COUNT) * 10 + reds * 8), 60, 95);

  fireSignal({
    type: 'cards-surge',
    matchId: match.fixtureId,
    home: match.home, away: match.away,
    league: match.league?.name,
    minute: match.minute,
    snapshot: {
      yellow: match.stats?.cards?.yellow?.total,
      red: match.stats?.cards?.red?.total,
      fouls: match.stats?.fouls?.total,
    },
    burst: list.length,
    weighted: Number(weighted.toFixed(1)),
    reds,
    windowMin: CARDS_WINDOW_MIN,
    suggestion: reds
      ? `Cartões — jogo aceso (${list.length} em ${CARDS_WINDOW_MIN}min, ${reds} vermelho${reds>1?'s':''})`
      : `Over cartões — surto recente (${list.length} amarelos em ${CARDS_WINDOW_MIN}min)`,
    classification: { label: reds ? 'CARDS-HOT' : 'CARDS-BURST', emoji: reds ? '🟥' : '🟨' },
    risk: { level: reds ? 'MED' : 'LOW', emoji: reds ? '🟡' : '🟢', label: reds ? 'MÉDIO' : 'BAIXO' },
    confidence,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 6) OverGoalsDetector (mercado: goals)
 *    Combina ritmo de gols já marcados + finalizações no alvo + pressão sustentada.
 *    Dispara em janela 25-70 min com ritmo projetado >= MIN_RATE * 90.
 */
function onMatchUpdateGoals({ match }) {
  if (!match) return;
  if (!match.enriched) return;
  const min = n(match.minute);
  if (min < OVER_GOALS_MIN_MIN || min > OVER_GOALS_MAX_MIN) return;

  const goals = n(match.score?.home) + n(match.score?.away);
  const rate = min > 0 ? goals / min : 0;
  const sot = n(match.stats?.shotsOnTarget?.total);
  const dang = n(match.stats?.dangerousAttacks?.total);
  const pressure = n(match.perMinute?.pressureIndex);

  // Projeção combinada: ritmo atual + tendência de finalizações
  const projected90 = +(rate * 95).toFixed(2);
  const finishingBoost = (sot / Math.max(min, 1)) * 90 * 0.25; // ~0.25 conv. esperada
  const projectedTotal = projected90 + finishingBoost;

  if (rate < OVER_GOALS_MIN_RATE) return;
  if (projectedTotal < goals + 1.2) return; // sem upside material
  if (pressure < 25) return;

  const key = `${match.id}:over-goals`;
  if (!canFire(key)) { skip('cooldown', 'over-goals', match); return; }

  const threshold = goals + 0.5; // ex: 1×1 (2 gols) → over 2.5
  const confidence = clamp(50 + Math.round((projectedTotal - threshold) * 18 + Math.min(pressure, 80) * 0.3), 55, 92);

  fireSignal({
    type: 'over-goals',
    matchId: match.fixtureId,
    home: match.home, away: match.away,
    league: match.league?.name,
    minute: match.minute,
    snapshot: {
      score: match.score,
      sot,
      dangerousAttacks: dang,
      pressureIndex: pressure,
    },
    ratePerMin: +rate.toFixed(3),
    projectedGoals: +projectedTotal.toFixed(1),
    suggestion: `Over ${threshold} gols — ritmo ${(rate*90).toFixed(1)}/90′, ${sot} no alvo`,
    classification: { label: 'OVER-GOALS', emoji: '⚽' },
    risk: { level: 'MED', emoji: '🟡', label: 'MÉDIO' },
    confidence,
    createdAt: new Date().toISOString(),
  });
}

/* ============================================================
   LIFECYCLE
   ============================================================ */
let started = false;
function start() {
  if (!ENABLED) { log.warn('signals engine desabilitado (SIGNALS_ENABLED=false)'); return; }
  if (started) return;
  started = true;
  events.on('fixture:pressure',  onPressure);
  events.on('fixture:btts-near', onBttsNear);
  events.on('fixture:corner',    onCorner);
  events.on('fixture:card',      onCard);
  events.on('match:update',      onMatchUpdate);
  events.on('match:update',      onMatchUpdateGoals);
  log.info('signals engine ativo', {
    pressureMin: PRESSURE_MIN,
    pressureRamp: PRESSURE_RAMP_DELTA,
    bttsMin: BTTS_MIN_MINUTE,
    bttsMax: BTTS_MAX_MINUTE,
    cornersWin: CORNERS_WINDOW_MIN,
    cornersMin: CORNERS_MIN_COUNT,
    overCornersRate: OVER_CORNERS_MIN_RATE,
    cardsWin: CARDS_WINDOW_MIN,
    cardsMin: CARDS_MIN_COUNT,
    overGoalsRate: OVER_GOALS_MIN_RATE,
    radarMinConfidence: RADAR_MIN_CONFIDENCE,
  });
}
function stop() {
  if (!started) return;
  events.off('fixture:pressure',  onPressure);
  events.off('fixture:btts-near', onBttsNear);
  events.off('fixture:corner',    onCorner);
  events.off('fixture:card',      onCard);
  events.off('match:update',      onMatchUpdate);
  events.off('match:update',      onMatchUpdateGoals);
  started = false;
}
function snapshot() {
  return {
    enabled: ENABLED,
    started,
    debugMode: DEBUG_MODE,
    markets: Object.values(MARKET),
    radarMinConfidence: RADAR_MIN_CONFIDENCE,
    thresholds: {
      pressure: { min: PRESSURE_MIN, rampDelta: PRESSURE_RAMP_DELTA },
      btts:     { minMin: BTTS_MIN_MINUTE, maxMin: BTTS_MAX_MINUTE, pressureMin: BTTS_MIN_PRESSURE },
      corners:  { windowMin: CORNERS_WINDOW_MIN, minCount: CORNERS_MIN_COUNT },
      overCorners: { minRate: OVER_CORNERS_MIN_RATE },
      cards:    { windowMin: CARDS_WINDOW_MIN, minCount: CARDS_MIN_COUNT, includeRed: CARDS_INCLUDE_RED },
      overGoals:{ minRate: OVER_GOALS_MIN_RATE, minMin: OVER_GOALS_MIN_MIN, maxMin: OVER_GOALS_MAX_MIN },
    },
    activeCooldowns: cooldowns.size,
    cornerWindows: cornerWindow.size,
    cardWindows: cardWindow.size,
    recentSignals: recent.length,
  };
}

/**
 * Relatório de descartes: motivos × frequência + amostra detalhada.
 * Útil para diagnosticar "por que nenhum sinal está sendo gerado".
 */
function debugReport({ dropLimit = 30 } = {}) {
  return {
    snapshot: snapshot(),
    dropHistogram: { ...dropHistogram },
    recentDrops: recentDrops.slice(0, dropLimit),
    recentSignals: recent.slice(0, 10).map((s) => ({
      type: s.type, market: s.market, confidence: s.confidence,
      suggestion: s.suggestion, matchId: s.matchId,
      minute: s.minute, createdAt: s.createdAt,
    })),
  };
}

module.exports = {
  start, stop, snapshot, listRecent,
  debugReport,
  MARKET, TYPE_TO_MARKETS, marketsFor,
  RADAR_MIN_CONFIDENCE,
};
