/**
 * Robotrend IA — Rotas Football API (API-Sports)
 *
 * Expõe endpoints REST para o frontend consumir dados em tempo real
 * vindos do serviço centralizado `services/apiFootball`.
 *
 * Rotas live/signals/panel = públicas (pipeline SYSTEM).
 * Rotas admin = requireAuth + requireAdmin.
 * Cache-Control: no-store em todas.
 *   - propagam erros 502 com a mensagem original
 *
 * Painel ao vivo:
 *   GET  /api/football/live
 *   GET  /api/football/live/panel?league=ID
 *   GET  /api/football/fixtures/:id              (bundle completo)
 *   GET  /api/football/fixtures/:id/statistics
 *   GET  /api/football/fixtures/:id/events
 *   GET  /api/football/fixtures/:id/lineups
 *   GET  /api/football/fixtures/by-date?date=YYYY-MM-DD
 *
 * Times:
 *   GET  /api/football/teams/:id/last?n=5
 *   GET  /api/football/teams/:id/statistics?league=ID&season=YYYY
 *   GET  /api/football/teams/:id/corner-average?league=ID&season=YYYY
 *
 * H2H / Predictions / Odds:
 *   GET  /api/football/h2h?team1=ID&team2=ID&last=10
 *   GET  /api/football/predictions/:fixtureId
 *   GET  /api/football/odds?fixture=ID
 *   GET  /api/football/odds/live?fixture=ID
 *   GET  /api/football/odds/bundle/:fixtureId    (odds + btts + over/under)
 *
 * Catálogo / utilitários:
 *   GET  /api/football/leagues?search=...
 *   GET  /api/football/status                   (config + quota — público)
 *   GET  /api/football/quota                    (admin)
 *   POST /api/football/cache/clear              (admin)
 */

'use strict';

const express = require('express');
const af = require('../services/apiFootball');
const history = require('../services/footballHistory');
const events = require('../services/footballEvents');
const metrics = require('../services/metrics');
const signalsEngine = require('../services/signalsEngine');
const betSignalEngine = require('../services/betSignalEngine');
const { getPoller } = require('../workers/liveFootballPoller');
const { getEnricher } = require('../services/fixtureEnricher');
const { normalizeFixture, statName, ensureAllMinimal } = require('../services/fixtureNormalizer');
const { logger } = require('../logger');

const log = logger.child({ module: 'football-routes' });

/* ============================================================
   Wrapper async — captura erro e responde 502 padronizado.
   ============================================================ */
function asyncHandler(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res))
      .catch((err) => {
        const status = err?.status || 502;
        log.error('football route error', {
          path: req.originalUrl,
          err: err?.message,
          status,
        });
        res.status(status).json({
          ok: false,
          error: 'api-football',
          message: err?.message || 'erro desconhecido',
          ...(err?.body ? { details: trimBody(err.body) } : {}),
        });
      });
  };
}

function trimBody(body) {
  try { return JSON.parse(JSON.stringify(body)); } catch { return null; }
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/* ============================================================
   BUILDER
   ============================================================ */
function buildFootballRoutes(app, requireAuth, db, requireAdmin, io = null) {
  const router = express.Router();
  // Rotas admin exigem auth+admin; rotas live/signals/panel são públicas (pipeline SYSTEM).
  const adminMw = [requireAuth(db), requireAdmin];

  // Popula req.user em todas as rotas (sem bloquear se anônimo).
  // Necessário para o tier-gating (premium vs free) em /bet-signals e /best-signal.
  const auth = require('../auth');
  router.use(auth.optionalAuth(db));

  /* ============================================================
     STATUS (usuário logado pode consultar — útil pro dashboard
     mostrar se a API está habilitada e quanto resta de quota)
     ============================================================ */
  router.get('/status', (req, res) => {
    noStore(res);
    const s = af.status();
    res.json({
      ok: true,
      configured: s.configured,
      host: s.host,
      legacyRapidApi: s.legacyRapidApi,
      cacheStore: s.cacheStore?.backend,
      breaker: s.breaker?.state,
      quotaRemaining: s.quota?.dailyRemaining,
      safeMode: s.safeMode?.active || false,
    });
  });

  /**
   * Endpoint público de safe-mode — frontend usa para mostrar banner amarelo
   * "quota baixa — exibindo dados cacheados".
   */
  router.get('/safe-mode', (req, res) => {
    noStore(res);
    const snap = af.safeMode ? af.safeMode() : { active: false };
    res.json({ ok: true, ...snap });
  });

  /* ============================================================
     LIVE — leitura do cache do poller (custo ZERO por request).
     ============================================================ */
  const poller = getPoller();

  function applyFilters(matches, q) {
    let out = matches;
    if (q.league) {
      const f = String(q.league).toLowerCase();
      out = out.filter((m) => String(m.league?.id) === f
        || String(m.league?.name || '').toLowerCase().includes(f));
    }
    if (q.minMinute) {
      const v = Number(q.minMinute);
      out = out.filter((m) => Number(m.minute || 0) >= v);
    }
    if (q.maxMinute) {
      const v = Number(q.maxMinute);
      out = out.filter((m) => Number(m.minute || 0) <= v);
    }
    if (q.minPressure) {
      const v = Number(q.minPressure);
      out = out.filter((m) => Number(m.perMinute?.pressureIndex || 0) >= v);
    }
    if (q.minCorners) {
      const v = Number(q.minCorners);
      out = out.filter((m) => Number(m.stats?.corners?.total || 0) >= v);
    }
    if (q.scored === 'btts') {
      out = out.filter((m) => (m.score.home || 0) > 0 && (m.score.away || 0) > 0);
    }
    if (q.scored === 'noBtts') {
      out = out.filter((m) => !((m.score.home || 0) > 0 && (m.score.away || 0) > 0));
    }
    if (q.search) {
      const s = String(q.search).toLowerCase();
      out = out.filter((m) => (m.home + ' ' + m.away).toLowerCase().includes(s));
    }
    return out;
  }

  router.get('/live', asyncHandler(async (req, res) => {
    noStore(res);
    let matches = poller.getMatches();
    // forceRefresh dispara chamada extra à API. Só fazemos no boot
    // (poller ainda não rodou). Em safe-mode NUNCA forçamos.
    if (!matches.length && !(af.isSafeMode && af.isSafeMode())) {
      const snap = poller.snapshot();
      if (!snap.lastTickAt) {
        await poller.forceRefresh();
        matches = poller.getMatches();
      }
    }
    matches = applyFilters(matches, req.query);
    ensureAllMinimal(matches);
    res.json({ ok: true, count: matches.length, matches, safeMode: af.isSafeMode?.() || false });
  }));

  /**
   * Painel ao vivo enriquecido: filtros avançados + agregados +
   * lista de ligas (para o filtro do front).
   */
  router.get('/live/panel', asyncHandler(async (req, res) => {
    noStore(res);
    let matches = poller.getMatches();
    if (!matches.length && !(af.isSafeMode && af.isSafeMode())) {
      const snap = poller.snapshot();
      if (!snap.lastTickAt) {
        await poller.forceRefresh();
        matches = poller.getMatches();
      }
    }

    // Agregados sobre TODAS antes do filtro (para construir a sidebar de ligas)
    const allLeagues = new Map();
    for (const m of matches) {
      const key = m.league?.id || m.league?.name || 'unknown';
      if (!allLeagues.has(key)) {
        allLeagues.set(key, { id: m.league?.id, name: m.league?.name, country: m.league?.country, flag: m.league?.flag, count: 0 });
      }
      allLeagues.get(key).count++;
    }

    ensureAllMinimal(matches);
    const filtered = applyFilters(matches, req.query);
    const total = filtered.length;
    let totalCorners = 0, totalShots = 0, totalDang = 0, totalGoals = 0, totalCardsY = 0, totalCardsR = 0;
    let bttsCount = 0;
    for (const m of filtered) {
      totalCorners += m.stats.corners.total || 0;
      totalShots   += m.stats.shots.total || 0;
      totalDang    += m.stats.dangerousAttacks.total || 0;
      totalGoals   += (m.score.home || 0) + (m.score.away || 0);
      totalCardsY  += m.stats.cards.yellow.total || 0;
      totalCardsR  += m.stats.cards.red.total || 0;
      if ((m.score.home || 0) > 0 && (m.score.away || 0) > 0) bttsCount++;
    }

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      poller: poller.snapshot(),
      total,
      averages: total ? {
        corners: +(totalCorners / total).toFixed(2),
        shots: +(totalShots / total).toFixed(2),
        dangerousAttacks: +(totalDang / total).toFixed(2),
        goals: +(totalGoals / total).toFixed(2),
        cardsYellow: +(totalCardsY / total).toFixed(2),
        cardsRed: +(totalCardsR / total).toFixed(2),
        bttsPct: Math.round((bttsCount / total) * 100),
      } : null,
      leagues: Array.from(allLeagues.values()).sort((a,b) => b.count - a.count),
      matches: filtered,
    });
  }));

  /* ============================================================
     SSE — Server-Sent Events (alternativa ao Socket.io)
     Para clientes que não conseguem WebSocket. Escuta o EventBus
     e envia updates incrementais.
     ============================================================ */
  router.get('/live/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(`retry: 5000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

    // envia snapshot inicial
    res.write(`event: tick\ndata: ${JSON.stringify({
      matches: poller.getMatches(),
      generatedAt: new Date().toISOString(),
      source: 'snapshot',
    })}\n\n`);

    const send = (event) => (payload) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (_) { /* client fechou */ }
    };
    const onTick     = send('tick');
    const onUpdate   = send('match:update');
    const onUpsert   = send('match:upsert');
    const onRemove   = send('match:remove');
    const onGoal     = send('fixture:goal');
    const onCorner   = send('fixture:corner');
    const onCard     = send('fixture:card');
    const onPressure = send('fixture:pressure');
    const onBtts     = send('fixture:btts-near');

    events.on('tick',              onTick);
    events.on('match:update',      onUpdate);
    events.on('match:upsert',      onUpsert);
    events.on('match:remove',      onRemove);
    events.on('fixture:goal',      onGoal);
    events.on('fixture:corner',    onCorner);
    events.on('fixture:card',      onCard);
    events.on('fixture:pressure',  onPressure);
    events.on('fixture:btts-near', onBtts);

    // heartbeat para evitar proxies fecharem por idle
    const hb = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch {} }, 15_000);

    req.on('close', () => {
      clearInterval(hb);
      events.off('tick',              onTick);
      events.off('match:update',      onUpdate);
      events.off('match:upsert',      onUpsert);
      events.off('match:remove',      onRemove);
      events.off('fixture:goal',      onGoal);
      events.off('fixture:corner',    onCorner);
      events.off('fixture:card',      onCard);
      events.off('fixture:pressure',  onPressure);
      events.off('fixture:btts-near', onBtts);
    });
  });

  /* ============================================================
     FIXTURE — bundle (statistics + events + lineups + odds)
     ============================================================ */
  router.get('/fixtures/by-date', asyncHandler(async (req, res) => {
    noStore(res);
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const raw = await af.getFixturesByDate(date);
    res.json({ ok: true, date, count: raw.length, fixtures: raw.map(normalizeFixture) });
  }));

  router.get('/fixtures/:id', asyncHandler(async (req, res) => {
    noStore(res);
    const id = req.params.id;
    // include default reduzido para só o essencial (statistics + events).
    // Antes eram 6 chamadas paralelas por click no detalhe da partida.
    // lineups/predictions/odds devem ser pedidos explicitamente via ?include=.
    let include = String(req.query.include || 'statistics,events')
      .split(',').map((s) => s.trim()).filter(Boolean);

    // SAFE-MODE: serve só o que estiver no cache do poller. Não dispara
    // nenhuma chamada nova de stats/events/lineups/odds/predictions.
    const safeMode = af.isSafeMode && af.isSafeMode();
    if (safeMode) {
      const cached = poller.getMatch(id);
      return res.json({
        ok: true,
        safeMode: true,
        fixture: cached || null,
        statistics: cached?.stats ? [cached.stats] : null,
        events: cached?.events || null,
        lineups: null,
        predictions: null,
        odds: null,
        message: 'safe-mode ativo (quota baixa) — exibindo dados em cache',
      });
    }

    const [fxArr, stats, events, lineups, predictions, odds] = await Promise.all([
      af.getFixtureById(id).catch(() => []),
      include.includes('statistics')  ? af.getFixtureStatistics(id).catch(() => []) : Promise.resolve(null),
      include.includes('events')      ? af.getFixtureEvents(id).catch(() => [])     : Promise.resolve(null),
      include.includes('lineups')     ? af.getFixtureLineups(id).catch(() => [])    : Promise.resolve(null),
      include.includes('predictions') ? af.getPredictions(id).catch(() => [])       : Promise.resolve(null),
      include.includes('odds')        ? af.getOdds({ fixture: id }).catch(() => []) : Promise.resolve(null),
    ]);

    const fixture = normalizeFixture(fxArr[0]);
    // Mescla enrichment recém-recebido no objeto fixture (mantém compatibilidade
    // com clients antigos que esperam fixture.stats populado).
    if (fixture && Array.isArray(stats) && stats.length) {
      const { applyEnrichment } = require('../services/fixtureNormalizer');
      applyEnrichment(fixture, stats, Array.isArray(events) ? events : []);
      // Atualiza cache do poller para que o realtime aproveite
      try { poller.cache.set(String(fixture.id), fixture); } catch {}
    }
    res.json({
      ok: true,
      fixture,
      statistics: stats,
      events,
      lineups,
      predictions,
      odds,
    });
  }));

  router.get('/fixtures/:id/statistics', asyncHandler(async (req, res) => {
    noStore(res);
    res.json({ ok: true, response: await af.getFixtureStatistics(req.params.id) });
  }));
  router.get('/fixtures/:id/events', asyncHandler(async (req, res) => {
    noStore(res);
    res.json({ ok: true, response: await af.getFixtureEvents(req.params.id) });
  }));
  router.get('/fixtures/:id/lineups', asyncHandler(async (req, res) => {
    noStore(res);
    res.json({ ok: true, response: await af.getFixtureLineups(req.params.id) });
  }));

  /* ============================================================
     H2H / PREDICTIONS / ODDS
     ============================================================ */
  router.get('/h2h', asyncHandler(async (req, res) => {
    noStore(res);
    const { team1, team2 } = req.query;
    if (!team1 || !team2) {
      return res.status(400).json({ ok: false, error: 'team1 e team2 são obrigatórios' });
    }
    const last = Number(req.query.last || 10);
    const data = await af.getHeadToHead(team1, team2, { last });
    res.json({ ok: true, count: data.length, fixtures: data.map(normalizeFixture) });
  }));

  router.get('/predictions/:fixtureId', asyncHandler(async (req, res) => {
    noStore(res);
    const data = await af.getPredictions(req.params.fixtureId);
    res.json({ ok: true, prediction: data[0] || null });
  }));

  router.get('/odds', asyncHandler(async (req, res) => {
    noStore(res);
    const data = await af.getOdds({
      fixture:   req.query.fixture,
      league:    req.query.league,
      season:    req.query.season,
      bet:       req.query.bet,
      bookmaker: req.query.bookmaker,
      page:      req.query.page,
    });
    res.json({ ok: true, count: data.length, odds: data });
  }));

  router.get('/odds/live', asyncHandler(async (req, res) => {
    noStore(res);
    const data = await af.getOddsLive({
      fixture: req.query.fixture,
      league:  req.query.league,
    });
    res.json({ ok: true, count: data.length, odds: data });
  }));

  /**
   * Bundle de odds — extrai BTTS, Over/Under, Match Winner, Asian Corners.
   */
  router.get('/odds/bundle/:fixtureId', asyncHandler(async (req, res) => {
    noStore(res);
    const fixtureId = req.params.fixtureId;
    const [oddsLive, oddsPre] = await Promise.all([
      af.getOddsLive({ fixture: fixtureId }).catch(() => []),
      af.getOdds({ fixture: fixtureId }).catch(() => []),
    ]);

    const out = { btts: null, overUnder: null, matchWinner: null, corners: null, source: null };

    // Tenta primeiro odds ao vivo, depois pré-jogo
    const trySrc = (arr, label) => {
      if (!arr?.length) return false;
      const game = arr[0];
      const bookmakers = game?.bookmakers || [];
      for (const bk of bookmakers) {
        for (const bet of (bk.bets || bk.odds || [])) {
          const name = String(bet?.name || '').toLowerCase();
          if (name.includes('both teams to score') && !out.btts) {
            out.btts = bet.values || bet.odds || null;
          }
          if (name.includes('over/under') && !out.overUnder) {
            out.overUnder = bet.values || bet.odds || null;
          }
          if ((name.includes('match winner') || name === '1x2') && !out.matchWinner) {
            out.matchWinner = bet.values || bet.odds || null;
          }
          if (name.includes('corner') && !out.corners) {
            out.corners = bet.values || bet.odds || null;
          }
        }
      }
      if (out.btts || out.overUnder || out.matchWinner || out.corners) {
        out.source = label;
        return true;
      }
      return false;
    };

    trySrc(oddsLive, 'odds-live') || trySrc(oddsPre, 'odds-pre');
    res.json({ ok: true, fixtureId, ...out });
  }));

  /* ============================================================
     TEAMS
     ============================================================ */
  router.get('/teams/:id/last', asyncHandler(async (req, res) => {
    noStore(res);
    const n = Number(req.query.n || 5);
    const data = await af.getFixturesByTeam(req.params.id, { last: Math.min(50, Math.max(1, n)) });
    res.json({ ok: true, count: data.length, fixtures: data.map(normalizeFixture) });
  }));

  router.get('/teams/:id/statistics', asyncHandler(async (req, res) => {
    noStore(res);
    const { league, season } = req.query;
    if (!league || !season) {
      return res.status(400).json({ ok: false, error: 'league e season são obrigatórios' });
    }
    const stats = await af.getTeamStatistics(req.params.id, league, season);
    res.json({ ok: true, statistics: stats });
  }));

  /**
   * Média de escanteios + tendências de gols nos últimos N jogos
   * (resumo derivado — sem custo extra de API se cachear).
   */
  router.get('/teams/:id/trends', asyncHandler(async (req, res) => {
    noStore(res);
    if (af.isSafeMode && af.isSafeMode()) {
      return res.status(503).json({
        ok: false, safeMode: true,
        error: 'safe-mode-active',
        message: 'Quota baixa — endpoint pesado temporariamente indisponível. Tente novamente após o reset da quota.',
      });
    }
    const teamId = req.params.id;
    const n = Math.min(50, Math.max(1, Number(req.query.n || 5)));
    const fixtures = await af.getFixturesByTeam(teamId, { last: n });

    let goalsFor = 0, goalsAgainst = 0, over25 = 0, btts = 0, played = fixtures.length;
    for (const fx of fixtures) {
      const isHome = fx.teams?.home?.id === Number(teamId);
      const gf = isHome ? (fx.goals?.home || 0) : (fx.goals?.away || 0);
      const ga = isHome ? (fx.goals?.away || 0) : (fx.goals?.home || 0);
      goalsFor += gf; goalsAgainst += ga;
      if (gf + ga > 2.5) over25++;
      if (gf > 0 && ga > 0) btts++;
    }

    // Para corners, precisamos puxar statistics de cada fixture
    // (cobrado em chamadas extras — limitamos a min(5, n) pra controlar custo)
    const sampleSize = Math.min(played, Number(req.query.cornersSample || 5));
    let cornersTotal = 0, cornersGames = 0;
    for (let i = 0; i < sampleSize; i++) {
      try {
        const stats = await af.getFixtureStatistics(fixtures[i].fixture.id);
        const t = fixtures[i].teams.home.id === Number(teamId) ? fixtures[i].teams.home.id : fixtures[i].teams.away.id;
        const v = statName(stats, t, 'Corner Kicks');
        if (Number.isFinite(v)) { cornersTotal += v; cornersGames++; }
      } catch (e) {
        // ignora erro pontual de stats
      }
    }

    res.json({
      ok: true,
      teamId: Number(teamId),
      played,
      averages: played ? {
        goalsFor: +(goalsFor / played).toFixed(2),
        goalsAgainst: +(goalsAgainst / played).toFixed(2),
        goalsTotal: +((goalsFor + goalsAgainst) / played).toFixed(2),
        over25Pct: +((over25 / played) * 100).toFixed(1),
        bttsPct: +((btts / played) * 100).toFixed(1),
        cornersAvg: cornersGames ? +(cornersTotal / cornersGames).toFixed(2) : null,
        cornersSample: cornersGames,
      } : null,
      lastFixtures: fixtures.map(normalizeFixture),
    });
  }));

  /**
   * Endpoint específico de média de escanteios (mais barato — só extrai
   * estatística de N jogos do time). Útil pro painel "tendências".
   */
  router.get('/teams/:id/corner-average', asyncHandler(async (req, res) => {
    noStore(res);
    if (af.isSafeMode && af.isSafeMode()) {
      return res.status(503).json({
        ok: false, safeMode: true,
        error: 'safe-mode-active',
        message: 'Quota baixa — endpoint pesado temporariamente indisponível.',
      });
    }
    const teamId = Number(req.params.id);
    const n = Math.min(20, Math.max(1, Number(req.query.n || 5)));
    const fixtures = await af.getFixturesByTeam(teamId, { last: n });

    let totalFor = 0, totalAgainst = 0, sample = 0;
    for (const fx of fixtures) {
      try {
        const stats = await af.getFixtureStatistics(fx.fixture.id);
        const homeId = fx.teams.home.id;
        const awayId = fx.teams.away.id;
        const isHome = homeId === teamId;
        const cornersTeam = statName(stats, isHome ? homeId : awayId, 'Corner Kicks');
        const cornersOpp  = statName(stats, isHome ? awayId : homeId, 'Corner Kicks');
        if (cornersTeam + cornersOpp > 0) {
          totalFor += cornersTeam; totalAgainst += cornersOpp; sample++;
        }
      } catch (e) { /* ignora */ }
    }
    res.json({
      ok: true,
      teamId, sample,
      cornersFor:     sample ? +(totalFor / sample).toFixed(2) : null,
      cornersAgainst: sample ? +(totalAgainst / sample).toFixed(2) : null,
      cornersTotal:   sample ? +((totalFor + totalAgainst) / sample).toFixed(2) : null,
    });
  }));

  /* ============================================================
     LEAGUES (catálogo p/ filtros do painel)
     ============================================================ */
  router.get('/leagues', asyncHandler(async (req, res) => {
    noStore(res);
    const params = {};
    if (req.query.search)  params.search  = req.query.search;
    if (req.query.country) params.country = req.query.country;
    if (req.query.season)  params.season  = req.query.season;
    if (req.query.current === 'true') params.current = 'true';
    const data = await af.getLeagues(params);
    const slim = data.map((row) => ({
      id: row.league?.id,
      name: row.league?.name,
      logo: row.league?.logo,
      country: row.country?.name,
      flag: row.country?.flag,
      seasons: (row.seasons || []).map((s) => ({ year: s.year, current: s.current })),
    }));
    res.json({ ok: true, count: slim.length, leagues: slim });
  }));

  /* ============================================================
     SIGNALS — engine de sinais automáticos
     ============================================================ */
  router.get('/signals/live', asyncHandler(async (req, res) => {
    noStore(res);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const type  = req.query.type || null;
    const markets = req.query.markets || null;          // CSV: corners,goals,btts,cards,pressure
    const minConfidence = Number(req.query.minConfidence || 0);
    const sinceMs = req.query.sinceMs ? Number(req.query.sinceMs) : 0;
    const signals = signalsEngine.listRecent({ limit, type, markets, minConfidence, sinceMs });
    res.json({ ok: true, count: signals.length, signals, engine: signalsEngine.snapshot() });
  }));

  /**
   * /signals/board — DECISION BOARD (não é feed de jogos)
   *
   * Devolve TODOS os sinais ativos (corners/goals/btts/cards) de matches
   * enriquecidos, filtrados pelos prefs do usuário.
   *
   * Query: ?markets=corners,goals&profile=conservative&minConfidence=70&limit=50
   *
   * Ordenação default: confidence DESC. Cada match contribui com 0–4 sinais
   * (um por mercado disponível). Frontend usa isso como SignalCards.
   */
  router.get('/signals/board', (req, res) => {
    noStore(res);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const prefs = {
      markets: req.query.markets ? String(req.query.markets).split(',').map((s) => s.trim()).filter(Boolean) : [],
      profile: ['conservative','aggressive','balanced'].includes(String(req.query.profile)) ? String(req.query.profile) : 'balanced',
      minConfidence: Math.max(0, Math.min(100, Number(req.query.minConfidence) || 0)),
    };
    const { filterSignalsByPrefs } = require('../services/signalGenerator');
    const matches = poller.getMatches();
    ensureAllMinimal(matches);
    const all = [];
    for (const m of matches) {
      if (!m.enriched || !Array.isArray(m.signals)) continue;
      const allowed = filterSignalsByPrefs(m.signals, prefs);
      for (const s of allowed) all.push(s);
    }
    all.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    res.json({
      ok: true,
      count: all.length,
      total: matches.length,
      enriched: matches.filter((m) => m.enriched).length,
      prefs,
      signals: all.slice(0, limit),
      generatedAt: new Date().toISOString(),
    });
  });

  // Lista enums de mercado + thresholds default p/ o frontend popular o radar
  router.get('/signals/markets', (req, res) => {
    noStore(res);
    res.json({
      ok: true,
      markets: signalsEngine.MARKET ? Object.values(signalsEngine.MARKET) : [],
      typeToMarkets: signalsEngine.TYPE_TO_MARKETS || {},
      radarMinConfidence: signalsEngine.RADAR_MIN_CONFIDENCE || 70,
    });
  });

  router.get('/signals/engine', adminMw, (req, res) => {
    noStore(res);
    res.json({ ok: true, engine: signalsEngine.snapshot() });
  });

  /* ============================================================
     BET SIGNALS — motor de value-bets (corners / btts / win)
     ZERO custo de API: itera sobre poller.getMatches() periodicamente.
     ============================================================ */
  /**
   * Helper interno — decide se o requester é PREMIUM (tier completo).
   * Aceita admin/owner/premium ou plan PREMIUM/VIP/PRO/TRIAL.
   * Tolera ausência de auth (Free anônimo) → retorna false.
   */
  function isPremiumRequester(req) {
    const u = req.user;
    if (!u) return false;
    const role = String(u.role || '').toLowerCase();
    const plan = String(u.plan || '').toUpperCase();
    return role === 'admin' || role === 'owner' || role === 'premium'
        || plan === 'PREMIUM' || plan === 'VIP' || plan === 'PRO' || plan === 'TRIAL';
  }

  function stripForFree(s) {
    const out = { ...s };
    delete out.premiumInsight;
    delete out.betScore;
    delete out.scoreBreakdown;
    delete out.extras;
    out.justification = 'Análise completa disponível no plano Premium.';
    out.locked = true;
    return out;
  }

  /**
   * GET /api/football/bet-signals
   *  Tier-aware:
   *   - PREMIUM: vê todos os sinais com payload completo
   *   - FREE:    vê apenas sinais não-premium (conf entre 65–74) + payload simplificado
   *              (sem premiumInsight, sem score, sem extras)
   */
  router.get('/bet-signals', (req, res) => {
    noStore(res);
    const isPrem = isPremiumRequester(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const market = req.query.market || null;
    const minConfidence = Math.max(0, Math.min(100, Number(req.query.minConfidence || 0)));
    const sinceMs = req.query.sinceMs ? Number(req.query.sinceMs) : 0;
    let signals = betSignalEngine.listRecent({ limit, market, minConfidence, sinceMs });

    if (!isPrem) {
      // FREE: filtra para mostrar apenas sinais 'free' (tier='free') e remove detalhes
      signals = signals
        .filter((s) => s.tier !== 'premium')
        .map(stripForFree);
    }

    res.json({
      ok: true,
      count: signals.length,
      signals,
      tier: isPrem ? 'premium' : 'free',
      engine: isPrem ? betSignalEngine.snapshot() : { tier: 'free' },
      generatedAt: new Date().toISOString(),
    });
  });

  /**
   * GET /api/football/best-signal
   *  Retorna a "MELHOR APOSTA DO MOMENTO" — exclusivo PREMIUM.
   *  FREE recebe 402 (Payment Required) com flag de upgrade.
   */
  router.get('/best-signal', (req, res) => {
    noStore(res);
    if (!isPremiumRequester(req)) {
      return res.status(402).json({
        ok: false,
        locked: true,
        upgrade: true,
        message: 'A "Melhor Aposta do Momento" é exclusiva do plano Premium.',
        currentTier: 'free',
      });
    }
    const best = betSignalEngine.getBestSignal();
    if (!best) {
      return res.json({
        ok: true,
        available: false,
        message: 'Aguardando sinal de alta qualidade. Próxima análise em alguns minutos.',
      });
    }
    res.json({
      ok: true,
      available: true,
      signal: best,
      ttlMs: betSignalEngine.config?.BEST_TTL_MS || 480000,
    });
  });

  router.get('/bet-signals/engine', adminMw, (req, res) => {
    noStore(res);
    res.json({ ok: true, engine: betSignalEngine.snapshot() });
  });

  /* ============================================================
     HISTORY — minuto a minuto + eventos persistidos
     ============================================================ */
  router.get('/history/:fixtureId/snapshots', asyncHandler(async (req, res) => {
    noStore(res);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 120)));
    const snaps = await history.listSnapshots(req.params.fixtureId, { limit });
    res.json({ ok: true, count: snaps.length, snapshots: snaps });
  }));

  router.get('/history/:fixtureId/events', asyncHandler(async (req, res) => {
    noStore(res);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const evs = await history.listEvents(req.params.fixtureId, { limit });
    res.json({ ok: true, count: evs.length, events: evs });
  }));

  router.get('/history/recent', asyncHandler(async (req, res) => {
    noStore(res);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const fixtures = await history.listRecentFixtures({ limit });
    res.json({ ok: true, count: fixtures.length, fixtures });
  }));

  /* ============================================================
     ADMIN
     ============================================================ */
  router.get('/quota', adminMw, (req, res) => {
    res.json({
      ok: true,
      status: af.status(),
      poller: poller.snapshot(),
      history: history.stats(),
      events: events.snapshot(),
    });
  });

  router.post('/cache/clear', adminMw, asyncHandler(async (req, res) => {
    const prefix = req.body?.prefix || null;
    const n = await af.cacheClear(prefix);
    res.json({ ok: true, cleared: n, prefix });
  }));

  router.post('/poller/refresh', adminMw, asyncHandler(async (req, res) => {
    await poller.forceRefresh();
    res.json({ ok: true, poller: poller.snapshot() });
  }));

  /**
   * Resync público — para o botão "↻" do frontend.
   * Não força nova chamada à API (evita estourar quota); só devolve o snapshot
   * mais recente do poller + flag indicando se há dados. Frontend usa isso
   * para re-popular a lista quando o usuário desconfia que está stale.
   */
  router.post('/poller/resync', asyncHandler(async (req, res) => {
    noStore(res);
    // CRÍTICO: resync NUNCA dispara chamadas novas para API. Sempre devolve
    // o snapshot atual do poller (atualizado a cada FOOTBALL_POLL_INTERVAL_MS).
    // Antes esse endpoint estava sendo abusado pelo frontend (F5/botão↻)
    // e a forceRefresh chained acabava furando o rate limit.
    const matches = poller.getMatches();
    const snap = poller.snapshot();
    const apiStatus = af.status();
    let reason = null;
    if (!matches.length) {
      if (apiStatus.safeMode?.active) reason = 'safe-mode';
      else if (apiStatus.breaker?.state === 'OPEN') reason = 'circuit-open';
      else if ((apiStatus.quota?.dailyRemaining ?? 1) <= 0) reason = 'quota-exhausted';
      else if (!snap.lastTickAt) reason = 'poller-not-ticked-yet';
      else reason = 'no-live-matches';
    }
    ensureAllMinimal(matches);
    res.json({
      ok: true,
      count: matches.length,
      matches,
      poller: snap,
      safeMode: apiStatus.safeMode || null,
      reason,
      ts: Date.now(),
    });
  }));

  /* ============================================================
     OBSERVABILIDADE — admin
     ============================================================ */
  function socketsSnapshot() {
    if (!io) return { available: false };
    try {
      const ns = io.of('/football');
      const rooms = {};
      for (const [room, set] of ns.adapter.rooms.entries()) {
        // Pula rooms que são apenas socket ids (default room por socket)
        if (ns.sockets.has(room)) continue;
        rooms[room] = set.size;
      }
      return {
        available: true,
        namespace: '/football',
        sockets: ns.sockets.size,
        rooms,
      };
    } catch (e) { return { available: false, error: e.message }; }
  }

  // Snapshot completo das métricas (JSON estruturado para o painel)
  router.get('/metrics', adminMw, (req, res) => {
    noStore(res);
    res.json({
      ok: true,
      at: new Date().toISOString(),
      metrics: metrics.snapshot(),
      sockets: socketsSnapshot(),
    });
  });

  // Formato Prometheus (exposition format) para scraping externo
  router.get('/metrics.prom', adminMw, (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics.prometheus());
  });

  // Diagnóstico consolidado (one-stop endpoint para o painel admin)
  router.get('/diagnostics', adminMw, (req, res) => {
    noStore(res);
    res.json({
      ok: true,
      at: new Date().toISOString(),
      api: af.status(),
      poller: poller.snapshot(),
      history: history.stats(),
      events: events.snapshot(),
      sockets: socketsSnapshot(),
      signals: signalsEngine.snapshot(),
      betSignals: betSignalEngine.snapshot(),
      enricher: getEnricher().snapshot(),
      process: metrics.snapshot().process,
      versions: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    });
  });

  // Test hooks (apenas dev/staging — controlar via env STRICT_REAL_ONLY)
  router.post('/test/force-fail', adminMw, (req, res) => {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_HOOKS !== 'true') {
      return res.status(403).json({ ok: false, error: 'Test hooks desabilitados em produção (ALLOW_TEST_HOOKS=true para liberar)' });
    }
    const mode = req.body?.mode ?? null;
    const valid = [null, 'timeout', '5xx', '429', 'circuit-open'];
    if (!valid.includes(mode)) {
      return res.status(400).json({ ok: false, error: `mode inválido. Valores: ${valid.map(String).join(', ')}` });
    }
    af.setForceFail(mode);
    res.json({ ok: true, mode, breaker: af.breaker.snapshot() });
  });

  router.get('/test/force-fail', adminMw, (req, res) => {
    res.json({ ok: true, mode: af.getForceFail(), breaker: af.breaker.snapshot() });
  });

  /* ============================================================
     ENRICHMENT — força refresh de stats/events de uma fixture
     ============================================================ */
  /* ============================================================
     INSIGHTS — leitura IA interpretativa (público)
     Devolve trends + reads + picks. Computado on-demand a partir do
     match cacheado no poller. Sem nova chamada à API.
     ============================================================ */
  router.get('/fixture/:id/insight', (req, res) => {
    noStore(res);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
    const match = poller.getMatch(id);
    if (!match) return res.status(404).json({ ok: false, error: 'match não está no cache do poller' });
    if (!match.enriched) {
      return res.json({ ok: true, enriched: false, insight: null, hint: 'aguardando enrichment — abra o detalhe da partida' });
    }
    // Prefs opcionais via query: ?markets=corners,goals&profile=conservative&minConfidence=70
    const prefs = (req.query.markets || req.query.profile || req.query.minConfidence)
      ? {
          markets: req.query.markets ? String(req.query.markets).split(',').map((s) => s.trim()).filter(Boolean) : [],
          profile: ['conservative','aggressive','balanced'].includes(String(req.query.profile)) ? String(req.query.profile) : 'balanced',
          minConfidence: Number(req.query.minConfidence) || 0,
        }
      : null;
    const { computeInsight } = require('../services/matchInsights');
    const insight = computeInsight(match, prefs);
    res.json({
      ok: true, enriched: true, insight,
      match: { id: match.id, home: match.home, away: match.away, minute: match.minute, score: match.score },
    });
  });

  router.post('/fixture/:id/enrich', adminMw, asyncHandler(async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
    const force = String(req.query.force || req.body?.force || 'false').toLowerCase() === 'true';
    const r = await getEnricher().requestEnrich(id, { force });
    const match = poller.getMatch(id);
    res.json({ ok: true, result: r, match: match ? { id: match.id, enriched: match.enriched, enrichedAt: match.enrichedAt } : null });
  }));

  router.get('/enricher/snapshot', adminMw, (req, res) => {
    noStore(res);
    res.json({ ok: true, enricher: getEnricher().snapshot() });
  });

  // Pipeline SYSTEM — ZERO auth no mount (token inválido não pode quebrar bootstrap).
  app.use('/api/football', router);
}

module.exports = { buildFootballRoutes };
