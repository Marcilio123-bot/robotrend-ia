/**
 * Robotrend IA — Fixture Normalizer
 *
 * Converte uma fixture crua da API-Football no formato unificado usado
 * por todos os módulos (poller, realtime, alerts, routes, frontend).
 *
 * IMPORTANTE — Modo skeleton vs enriched:
 *   - O endpoint /fixtures?live=all NÃO devolve `statistics` por fixture.
 *   - normalizeFixture(fx) produz o "skeleton": score, status, minuto, league, teams.
 *     stats/perMinute/events ficam null e enriched=false.
 *   - applyEnrichment(match, statsResp, eventsResp) preenche os campos
 *     ricos a partir de /fixtures/statistics e /fixtures/events.
 *   - Frontend mostra "carregando estatísticas…" quando enriched===false.
 *   - Poller preserva enrichment entre ticks (não regenera zeros).
 *
 * Saída padronizada:
 *   {
 *     id, fixtureId,
 *     league: { id, name, country, logo, flag, season, round },
 *     teams: { home: {id,name,logo}, away: {id,name,logo} },
 *     home, away,                  // shortcuts string
 *     minute, status, statusLong,
 *     venue, kickoffAt, date,
 *     score: { home, away, ht, ft },
 *     stats:    null | { ... }     // null quando ainda não enriquecido
 *     perMinute:null | { ... },
 *     events:   [],
 *     enriched: boolean,
 *     enrichedAt: timestamp | null,
 *     flags:    { isLive, isFinished, isFromLiveAPI, source },
 *     lastApiUpdate
 *   }
 */

'use strict';

const LIVE_STATUSES = new Set(['1H','2H','HT','ET','BT','P','LIVE','INT']);
const FINISHED_STATUSES = new Set(['FT','AET','PEN','CANC','PST','ABD','AWD','WO','SUSP']);

function statName(stats, teamId, type) {
  const block = stats?.find?.((s) => s?.team?.id === teamId);
  if (!block) return 0;
  const row = block.statistics?.find?.((x) => x.type === type);
  const v = row?.value;
  if (v == null) return 0;
  if (typeof v === 'string' && v.endsWith('%')) return Number(v.replace('%','')) || 0;
  return Number(v) || 0;
}

/* ============================================================
   SKELETON — só com dados básicos do live endpoint
   ============================================================ */
function normalizeFixture(fx) {
  if (!fx) return null;
  const homeId = fx.teams?.home?.id;
  const awayId = fx.teams?.away?.id;
  const statusShort = fx.fixture?.status?.short;
  const elapsed = Number(fx.fixture?.status?.elapsed || 0);

  // Em casos raros o live endpoint já vem com statistics inline. Aproveitamos.
  const inlineStats = Array.isArray(fx.statistics) ? fx.statistics : [];
  const inlineEvents = Array.isArray(fx.events) ? fx.events : [];

  const base = {
    id: String(fx.fixture?.id),
    fixtureId: fx.fixture?.id,
    league: {
      id: fx.league?.id,
      name: fx.league?.name,
      country: fx.league?.country,
      logo: fx.league?.logo,
      flag: fx.league?.flag,
      season: fx.league?.season,
      round: fx.league?.round,
    },
    teams: {
      home: { id: homeId, name: fx.teams?.home?.name, logo: fx.teams?.home?.logo },
      away: { id: awayId, name: fx.teams?.away?.name, logo: fx.teams?.away?.logo },
    },
    home: fx.teams?.home?.name,
    away: fx.teams?.away?.name,
    minute: elapsed,
    status: statusShort,
    statusLong: fx.fixture?.status?.long,
    venue: fx.fixture?.venue || null,
    kickoffAt: fx.fixture?.date,
    date: fx.fixture?.date,
    score: {
      home: fx.goals?.home || 0,
      away: fx.goals?.away || 0,
      ht: fx.score?.halftime || null,
      ft: fx.score?.fulltime || null,
    },
    stats: null,
    perMinute: null,
    events: inlineEvents.length ? inlineEvents.map(normalizeEvent) : [],
    enriched: false,
    enrichedAt: null,
    flags: {
      isLive: LIVE_STATUSES.has(String(statusShort || '').toUpperCase()),
      isFinished: FINISHED_STATUSES.has(String(statusShort || '').toUpperCase()),
      isFromLiveAPI: true,
      source: 'api-football',
    },
    lastApiUpdate: Date.now(),
  };

  // Inline statistics presentes (raro mas possível) → aplica imediatamente.
  if (inlineStats.length) {
    applyEnrichment(base, inlineStats, inlineEvents);
    base.flags.source = 'api-football-inline';
  }

  return base;
}

/* ============================================================
   ENRICHMENT — preenche stats, perMinute e events a partir de
   respostas de /fixtures/statistics e /fixtures/events
   ============================================================ */
function applyEnrichment(match, statsResp, eventsResp) {
  if (!match) return match;
  const homeId = match.teams?.home?.id;
  const awayId = match.teams?.away?.id;
  const elapsed = Number(match.minute || 0);

  const cornersHome = statName(statsResp, homeId, 'Corner Kicks');
  const cornersAway = statName(statsResp, awayId, 'Corner Kicks');
  const dangHome    = statName(statsResp, homeId, 'Dangerous Attacks');
  const dangAway    = statName(statsResp, awayId, 'Dangerous Attacks');
  const attacksHome = statName(statsResp, homeId, 'Attacks');
  const attacksAway = statName(statsResp, awayId, 'Attacks');
  const shotsHome   = statName(statsResp, homeId, 'Total Shots');
  const shotsAway   = statName(statsResp, awayId, 'Total Shots');
  const sotHome     = statName(statsResp, homeId, 'Shots on Goal');
  const sotAway     = statName(statsResp, awayId, 'Shots on Goal');
  const sofHome     = statName(statsResp, homeId, 'Shots off Goal');
  const sofAway     = statName(statsResp, awayId, 'Shots off Goal');
  const yellowHome  = statName(statsResp, homeId, 'Yellow Cards');
  const yellowAway  = statName(statsResp, awayId, 'Yellow Cards');
  const redHome     = statName(statsResp, homeId, 'Red Cards');
  const redAway     = statName(statsResp, awayId, 'Red Cards');
  const foulsHome   = statName(statsResp, homeId, 'Fouls');
  const foulsAway   = statName(statsResp, awayId, 'Fouls');
  const passAccHome = statName(statsResp, homeId, 'Passes %');
  const passAccAway = statName(statsResp, awayId, 'Passes %');
  const possHomeRaw = statName(statsResp, homeId, 'Ball Possession');
  const possHome    = possHomeRaw || 50;

  const totalCorners = cornersHome + cornersAway;
  const totalDang    = dangHome + dangAway;
  const totalShots   = shotsHome + shotsAway;
  const totalSot     = sotHome + sotAway;
  const totalAttacks = attacksHome + attacksAway;

  match.stats = {
    corners:          { home: cornersHome, away: cornersAway, total: totalCorners },
    dangerousAttacks: { home: dangHome,    away: dangAway,    total: totalDang },
    attacks:          { home: attacksHome, away: attacksAway, total: totalAttacks },
    shots:            { home: shotsHome,   away: shotsAway,   total: totalShots },
    shotsOnTarget:    { home: sotHome,     away: sotAway,     total: totalSot },
    shotsOffTarget:   { home: sofHome,     away: sofAway,     total: sofHome + sofAway },
    possession:       { home: possHome,    away: 100 - possHome },
    cards: {
      yellow: { home: yellowHome, away: yellowAway, total: yellowHome + yellowAway },
      red:    { home: redHome,    away: redAway,    total: redHome + redAway },
    },
    fouls:        { home: foulsHome, away: foulsAway, total: foulsHome + foulsAway },
    passAccuracy: { home: passAccHome, away: passAccAway },
  };

  match.perMinute = elapsed > 0 ? {
    corners:          +(totalCorners / elapsed).toFixed(3),
    dangerousAttacks: +(totalDang    / elapsed).toFixed(3),
    shots:            +(totalShots   / elapsed).toFixed(3),
    sot:              +(totalSot     / elapsed).toFixed(3),
    attacks:          +(totalAttacks / elapsed).toFixed(3),
    pressureIndex: +((
      totalDang * 0.4 + totalShots * 1.5 + totalCorners * 2 + totalSot * 3
    ) / elapsed).toFixed(2),
  } : null;

  // Momentum: combo de pressão recente + tendência de chutes vs ritmo do jogo
  if (match.perMinute) {
    const homeScore = sotHome * 3 + dangHome * 0.3 + cornersHome * 1.5;
    const awayScore = sotAway * 3 + dangAway * 0.3 + cornersAway * 1.5;
    const totalScore = homeScore + awayScore;
    match.momentum = {
      home: totalScore > 0 ? Math.round((homeScore / totalScore) * 100) : 50,
      away: totalScore > 0 ? Math.round((awayScore / totalScore) * 100) : 50,
      pressureIndex: match.perMinute.pressureIndex,
    };
  } else {
    match.momentum = null;
  }

  // BTTS likelihood (heurístico): 0..100, considera placar atual + finalizações
  match.bttsLikelihood = computeBttsLikelihood(match);

  if (Array.isArray(eventsResp) && eventsResp.length) {
    match.events = eventsResp.map(normalizeEvent);
  }

  match.enriched = true;
  match.enrichedAt = Date.now();

  // Camada interpretativa (IA explicada). Lazy-require para evitar ciclo.
  try {
    const { computeInsight } = require('./matchInsights');
    match.insight = computeInsight(match);
  } catch (_) { /* defensivo — nunca quebrar enrichment se módulo falhar */ }

  // Sinais contínuos por mercado (corners/goals/btts/cards). Sempre 1 por mercado.
  try {
    const { generateSignals } = require('./signalGenerator');
    match.signals = generateSignals(match);
  } catch (_) { match.signals = []; }

  return match;
}

/**
 * Enrichment mínimo LOCAL — quando API stats/events falha ou quota bloqueia.
 * Gera stats zerados + sinais parciais a partir de placar/minuto.
 * Nunca deixa o frontend em "0/42 enriquecido".
 */
function applyMinimalEnrichment(match) {
  if (!match) return match;
  const min = Math.max(1, Number(match.minute || 1));
  const gh = Number(match.score?.home || 0);
  const ga = Number(match.score?.away || 0);
  const totalGoals = gh + ga;

  match.stats = {
    corners:          { home: 0, away: 0, total: 0 },
    dangerousAttacks: { home: 0, away: 0, total: 0 },
    attacks:          { home: 0, away: 0, total: 0 },
    shots:            { home: 0, away: 0, total: 0 },
    shotsOnTarget:    { home: 0, away: 0, total: 0 },
    shotsOffTarget:   { home: 0, away: 0, total: 0 },
    possession:       { home: 50, away: 50 },
    cards: {
      yellow: { home: 0, away: 0, total: 0 },
      red:    { home: 0, away: 0, total: 0 },
    },
    fouls:        { home: 0, away: 0, total: 0 },
    passAccuracy: { home: 0, away: 0 },
  };

  const goalRate = totalGoals / min;
  match.perMinute = {
    corners: 0,
    dangerousAttacks: 0,
    shots: 0,
    sot: 0,
    attacks: 0,
    pressureIndex: +(goalRate * 2 + 0.3).toFixed(2),
  };

  match.momentum = { home: 50, away: 50, pressureIndex: match.perMinute.pressureIndex };
  match.bttsLikelihood = (gh > 0 && ga > 0) ? 100 : Math.min(60, Math.round(totalGoals * 20 + min * 0.3));
  match.events = match.events || [];
  match.enriched = true;
  match.enrichedPartial = true;
  match.enrichedAt = Date.now();

  try {
    const { computeInsight } = require('./matchInsights');
    match.insight = computeInsight(match);
  } catch (_) { match.insight = null; }

  try {
    const { generatePartialSignals } = require('./signalGenerator');
    match.signals = generatePartialSignals(match);
  } catch (_) { match.signals = []; }

  return match;
}

/* ============================================================
   EVENT NORMALIZATION (uniforme p/ /fixtures/events)
   ============================================================ */
function normalizeEvent(ev) {
  return {
    minute:   ev?.time?.elapsed ?? null,
    extra:    ev?.time?.extra ?? null,
    teamId:   ev?.team?.id ?? null,
    teamName: ev?.team?.name ?? null,
    playerId: ev?.player?.id ?? null,
    playerName: ev?.player?.name ?? null,
    assistName: ev?.assist?.name ?? null,
    type:     ev?.type || null,           // Goal | Card | subst | Var
    detail:   ev?.detail || null,         // Normal Goal | Yellow Card | etc.
    comments: ev?.comments || null,
  };
}

/* ============================================================
   BTTS LIKELIHOOD (placar + pressão do lado perdedor/zerado)
   ============================================================ */
function computeBttsLikelihood(m) {
  const sh = m.score?.home || 0, sa = m.score?.away || 0;
  const min = m.minute || 0;
  if (sh > 0 && sa > 0) return 100; // já BTTS

  // Lado que ainda não marcou (ou está empatado em 0×0)
  const needsHome = sh === 0;
  const needsAway = sa === 0;
  if (!needsHome && !needsAway) return 100;

  const sotH = m.stats?.shotsOnTarget?.home || 0;
  const sotA = m.stats?.shotsOnTarget?.away || 0;
  const dangH = m.stats?.dangerousAttacks?.home || 0;
  const dangA = m.stats?.dangerousAttacks?.away || 0;
  const cornH = m.stats?.corners?.home || 0;
  const cornA = m.stats?.corners?.away || 0;

  let score = 0;
  if (needsHome) score += sotH * 8 + dangH * 0.3 + cornH * 2;
  if (needsAway) score += sotA * 8 + dangA * 0.3 + cornA * 2;

  // Penaliza minuto avançado sem nenhum progresso
  if (min > 75 && score < 15) score *= 0.3;
  if (min < 15) score *= 0.5; // muito cedo p/ projetar
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Garante enriched+signals mínimos sem API (síncrono). */
function ensureMinimalEnrichment(match) {
  if (!match) return match;
  if (match.enriched && Array.isArray(match.signals) && match.signals.length) return match;
  return applyMinimalEnrichment(match);
}

function ensureAllMinimal(matches) {
  if (!Array.isArray(matches)) return matches;
  for (const m of matches) ensureMinimalEnrichment(m);
  return matches;
}

module.exports = {
  normalizeFixture,
  applyEnrichment,
  applyMinimalEnrichment,
  ensureMinimalEnrichment,
  ensureAllMinimal,
  normalizeEvent,
  statName,
  computeBttsLikelihood,
  LIVE_STATUSES,
  FINISHED_STATUSES,
};
