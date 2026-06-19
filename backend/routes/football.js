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
const af = require('../services/footballProvider');
const history = require('../services/footballHistory');
const events = require('../services/footballEvents');
const metrics = require('../services/metrics');
const signalsEngine = require('../services/signalsEngine');
const betSignalEngine = require('../services/betSignalEngine');
const consensus = require('../consensus');
const { isLiveMatch } = require('../services/liveMatchFilter');
const leagueWhitelist = require('../services/leagueWhitelist');
const { getPoller } = require('../workers/liveFootballPoller');
const { getEnricher } = require('../services/fixtureEnricher');
const { normalizeFixture, statName, ensureAllMinimal } = require('../services/fixtureNormalizer');
const { logger } = require('../logger');
// Gating por plano (FREE x PREMIUM) — análise ao vivo é Premium.
const signalAccess = require('../signalAccess');
const { canViewSystemMessages, projectPublicLivePayload } = require('../utils/systemAccess');

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
     PREMIUM GATE — middleware reutilizável para rotas pagas.
     Usa isPremiumRequester(req) (definido adiante e hoisted).
     FREE/anônimo recebe 402 com payload { locked, upgrade, feature }
     que o frontend usa para exibir o overlay de upgrade.
     ============================================================ */
  function gatePremiumFeature(featureName) {
    return (req, res, next) => {
      noStore(res);
      if (isPremiumRequester(req)) return next();
      return res.status(402).json({
        ok: false,
        locked: true,
        upgrade: true,
        feature: featureName,
        currentTier: 'free',
        code: 'PREMIUM_REQUIRED',
        message: 'Recurso disponível apenas para assinantes Premium.',
      });
    };
  }

  /* ============================================================
     STATUS (usuário logado pode consultar — útil pro dashboard
     mostrar se a API está habilitada e quanto resta de quota)
     ============================================================ */
  router.get('/status', (req, res) => {
    noStore(res);
    const s = af.status();
    if (!canViewSystemMessages(req.user)) {
      return res.json({ ok: true, configured: !!s.configured });
    }
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
   * Safe-mode — detalhes técnicos só para admin_master.
   */
  router.get('/safe-mode', (req, res) => {
    noStore(res);
    if (!canViewSystemMessages(req.user)) {
      return res.json({ ok: true, active: false });
    }
    const snap = af.safeMode ? af.safeMode() : { active: false };
    res.json({
      ok: true,
      active: snap.active ?? false,
      remainingRatio: snap.remainingRatio ?? snap.ratio ?? null,
      dailyRemaining: snap.dailyRemaining ?? snap.quota?.dailyRemaining ?? null,
      dailyLimit: snap.dailyLimit ?? snap.quota?.dailyLimit ?? null,
      dayUsed: snap.dayUsed ?? snap.bucket?.dayUsed ?? null,
      dayLimit: snap.dayLimit ?? snap.bucket?.dayLimit ?? null,
      disabledByEnv: snap.disabledByEnv ?? false,
      rawSafeMode: snap.rawSafeMode ?? null,
      ...snap,
    });
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

  /* ============================================================
     LIVE-FILTERING — extraído para reuso entre /live e /scanner
     ------------------------------------------------------------
     `isLive(m)`     → descarta FT/AET/PST/SCHED/NS e minute>=120
     `liveMatches()` → resolve poller, força refresh no boot e devolve
                       APENAS matches ao vivo (sem filtros de query).
     Tanto /live (com filtros) quanto /scanner (raw) consomem `liveMatches()`.
     ============================================================ */
  async function liveMatches() {
    let matches = poller.getMatches();
    if (!matches.length && !(af.isSafeMode && af.isSafeMode())) {
      const snap = poller.snapshot();
      if (!snap.lastTickAt) {
        await poller.forceRefresh();
        matches = poller.getMatches();
      }
    }
    return matches.filter(isLiveMatch);
  }

  /**
   * Anota `sourceQuality` (+ `consensus` mínimo) em matches vindos do poller.
   * O pipeline scanner/live/panel NÃO chama o consensus engine — usa o
   * poller central como única fonte. Mesmo assim, queremos que o frontend
   * receba o campo de qualidade pra renderizar o badge consistentemente.
   * Se o match já vier anotado (vindo do consensus engine via signal pipeline),
   * o helper preserva os campos originais.
   */
  function annotateMatches(matches) {
    return matches.map((m) => consensus.annotateSourceQuality(m, {
      reason: 'poller-feed',
      providerSource: m.provider || m.flags?.source || null,
    }));
  }

  /**
   * Constrói o bloco `meta` exposto por /live e /scanner.
   * Centraliza a leitura de provider/quota/origem para o frontend
   * conseguir mostrar "📡 Scanner: 87 jogos · API-Football".
   */
  function buildLiveMeta(allLive, afterFilter) {
    const pollerSnap = poller.snapshot?.() || {};
    const pollerBefore = pollerSnap.lastFilter?.beforeFilter;
    const total = pollerBefore != null ? Math.max(pollerBefore, allLive.length) : allLive.length;
    const filteredOut = Math.max(0, total - afterFilter.length);
    // Histograma por provider de origem do match (cada provider stampa
    // `match.provider` e `match.flags.source` no poller).
    const bySource = {};
    const byLeague = new Map();
    for (const m of allLive) {
      const src = m.provider || m.flags?.source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
      const k = m.league?.name || m.league || 'unknown';
      byLeague.set(k, (byLeague.get(k) || 0) + 1);
    }
    const status = af.status?.() || {};
    return {
      totalReceived: total,
      totalAfterFilter: afterFilter.length,
      pollerBeforeFilter: pollerBefore ?? null,
      pollerAfterLiveGate: pollerSnap.lastFilter?.afterLiveStatus ?? allLive.length,
      filteredOut,
      filterPct: total ? +(filteredOut * 100 / total).toFixed(1) : 0,
      provider: {
        active: af.providerName || status.activeProvider || 'unknown',
        available: status.available || [],
        priority: status.priority || [],
        safeMode: af.isSafeMode?.() || false,
        breaker: status.breaker?.state || null,
        quota: af.quota?.() || null,
      },
      bySource,
      topLeagues: Array.from(byLeague.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, count })),
      poller: {
        tracked: poller.snapshot().tracked,
        alive: poller.snapshot().alive,
        lastTickAt: poller.snapshot().lastTickAt,
        feedCompare: poller.getLastFeedCompare?.() || poller.snapshot().feedCompare || null,
      },
    };
  }

  /**
   * Classifica POR QUE não há jogos, separando ERRO REAL da API de
   * "sem jogos ao vivo agora" (resposta vazia legítima).
   *   - null               → há jogos (não é caso de erro)
   *   - 'no-live-matches'   → API respondeu OK, apenas não há jogos agora
   *   - 'poller-warming-up' → poller ainda não rodou a primeira tick
   *   - 'safe-mode' | 'circuit-open' | 'quota-exhausted' | 'data-unavailable'
   *                         → ERRO/indisponibilidade REAL
   *
   * IMPORTANTE: resposta vazia (matches.length === 0) com poller saudável NUNCA
   * vira 'data-unavailable'/'quota-exhausted' — isso é 'no-live-matches'.
   */
  function computeLiveReason(matchCount) {
    if (matchCount > 0) return null;
    const apiStatus = af.status?.() || {};
    const snap = poller.snapshot?.() || {};
    if (apiStatus.safeMode?.active) return 'safe-mode';
    if (apiStatus.breaker?.state === 'OPEN') return 'circuit-open';
    if ((apiStatus.quota?.dailyRemaining ?? 1) <= 0) return 'quota-exhausted';
    if (snap.lastFallbackReason === 'api_not_configured' || !af.isConfigured?.()) return 'data-unavailable';
    // Só consideramos indisponível se o poller está REALMENTE degradado AGORA
    // (falhas consecutivas em curso). Uma tick OK com 0 jogos limpa esse estado.
    if (snap.health === 'degraded') return 'data-unavailable';
    if (!snap.lastTickAt) return 'poller-warming-up';
    return 'no-live-matches';
  }

  router.get('/live', asyncHandler(async (req, res) => {
    noStore(res);
    const allLive = await liveMatches();
    const matches = annotateMatches(applyFilters(allLive, req.query));

    // [STAT TRACE 4/6] rest-live — payload final entregue pelo /api/football/live.
    try {
      const statTrace = require('../services/statTrace');
      const target = statTrace.getTarget();
      if (target.id) {
        const targetMatch = matches.find((m) => String(m.fixtureId || m.id) === target.id);
        if (targetMatch) {
          statTrace.trace('rest-live', target.id, {
            stats: targetMatch.stats,
            extra: {
              enriched: !!targetMatch.enriched,
              enrichedPartial: !!targetMatch.enrichedPartial,
              statsKeys: targetMatch.stats ? Object.keys(targetMatch.stats) : [],
              minute: targetMatch.minute,
            },
          });
        }
      }
    } catch (_) { /* defensivo */ }

    res.json(projectPublicLivePayload({
      ok: true,
      count: matches.length,
      // Validação obrigatória por plano: FREE só recebe dados básicos da partida.
      matches: signalAccess.projectMatchesForUser(matches, isPremiumRequester(req)),
      generatedAt: new Date().toISOString(),
      safeMode: af.isSafeMode?.() || false,
      // reason distingue ERRO REAL de "sem jogos ao vivo agora" (resposta vazia OK).
      reason: computeLiveReason(matches.length),
      meta: buildLiveMeta(allLive, matches),
      consensus: { mode: consensus.CONSENSUS_MODE },
    }, req.user));
  }));

  /* ============================================================
     SCANNER — modo CRU ao vivo (zero filtro IA, zero confiança, zero score).
     Mostra TODOS os jogos reais que o poller recebeu. Aceita opcionalmente
     `search=` e `league=` como ajudantes de navegação, mas IGNORA
     scored / minute / pressure / favorites / btts-near (que dependem de
     enrichment ou de filtros de IA).
     ============================================================ */
  router.get('/scanner', asyncHandler(async (req, res) => {
    noStore(res);

    // SCANNER usa o snapshot do poller (única fonte API-Football).
    const allLive = await liveMatches();
    console.log(`[LIVE MATCHES RECEIVED] /scanner — ${allLive.length} matches (provider ativo: ${af.providerName})`);

    // Filtros de NAVEGAÇÃO permitidos (não-IA)
    const navFilters = {
      search: req.query.search,
      league: req.query.league,
    };
    const filtered = applyFilters(allLive, navFilters);
    console.log(`[NORMALIZED MATCHES] /scanner — ${filtered.length}/${allLive.length} após filtros de navegação`);

    // SCANNER nunca aplica consensus. Anota tudo como single-source para
    // que o frontend mostre o badge "📡 SINGLE-SOURCE" no card.
    const matches = annotateMatches(filtered);
    console.log(`[RENDERED MATCHES] /scanner — devolvendo ${matches.length} matches anotados ao frontend`);

    res.json(projectPublicLivePayload({
      ok: true,
      mode: 'scanner',
      count: matches.length,
      // Validação obrigatória por plano: FREE só recebe dados básicos da partida.
      matches: signalAccess.projectMatchesForUser(matches, isPremiumRequester(req)),
      generatedAt: new Date().toISOString(),
      safeMode: af.isSafeMode?.() || false,
      meta: buildLiveMeta(allLive, matches),
      consensus: { mode: 'off', applied: false, reason: 'scanner-bypass' },
      provider: {
        active: af.providerName,
        priority: af.priority || [],
      },
      hint: 'Modo SCANNER — todos os jogos ao vivo, sem filtros IA, sem consensus. ' +
            'Use /api/football/live para o feed com filtros + score IA.',
    }, req.user));
  }));

  /**
   * Painel ao vivo enriquecido: filtros avançados + agregados +
   * lista de ligas (para o filtro do front).
   */
  router.get('/live/panel', asyncHandler(async (req, res) => {
    noStore(res);
    const matches = await liveMatches();

    // Agregados sobre TODAS antes do filtro (para construir a sidebar de ligas)
    const allLeagues = new Map();
    for (const m of matches) {
      const key = m.league?.id || m.league?.name || 'unknown';
      if (!allLeagues.has(key)) {
        allLeagues.set(key, { id: m.league?.id, name: m.league?.name, country: m.league?.country, flag: m.league?.flag, count: 0 });
      }
      allLeagues.get(key).count++;
    }

    const filtered = annotateMatches(applyFilters(matches, req.query));
    const total = filtered.length;
    let totalCorners = 0, totalShots = 0, totalDang = 0, totalGoals = 0, totalCardsY = 0, totalCardsR = 0;
    let bttsCount = 0;
    for (const m of filtered) {
      totalCorners += m.stats?.corners?.total || 0;
      totalShots   += m.stats?.shots?.total || 0;
      totalDang    += m.stats?.dangerousAttacks?.total || 0;
      totalGoals   += (m.score?.home || 0) + (m.score?.away || 0);
      totalCardsY  += m.stats?.cards?.yellow?.total || 0;
      totalCardsR  += m.stats?.cards?.red?.total || 0;
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
      // Validação obrigatória por plano: FREE só recebe dados básicos da partida.
      matches: signalAccess.projectMatchesForUser(filtered, isPremiumRequester(req)),
      meta: buildLiveMeta(matches, filtered),
      consensus: { mode: consensus.CONSENSUS_MODE },
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

    // Validação obrigatória por plano: FREE só recebe dados básicos da partida.
    const streamIsPremium = isPremiumRequester(req);

    // envia snapshot inicial
    res.write(`event: tick\ndata: ${JSON.stringify({
      matches: signalAccess.projectMatchesForUser(poller.getMatches(), streamIsPremium),
      generatedAt: new Date().toISOString(),
      source: 'snapshot',
    })}\n\n`);

    const send = (event) => (payload) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (_) { /* client fechou */ }
    };
    // Projeta eventos de partida (tick / match:*) conforme o plano antes de enviar.
    const sendTick = (payload) => {
      const projected = streamIsPremium
        ? payload
        : { ...payload, matches: signalAccess.projectMatchesForUser(payload?.matches, false) };
      try { res.write(`event: tick\ndata: ${JSON.stringify(projected)}\n\n`); } catch (_) {}
    };
    const sendMatchEvt = (event) => (payload) => {
      const projected = signalAccess.projectMatchEventPayload(payload, streamIsPremium);
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(projected)}\n\n`); } catch (_) {}
    };
    const onTick     = sendTick;
    const onUpdate   = sendMatchEvt('match:update');
    const onUpsert   = sendMatchEvt('match:upsert');
    const onRemove   = send('match:remove');
    // Eventos factuais do placar (gol/escanteio/cartão) — básicos, com match sanitizado.
    const onGoal     = sendMatchEvt('fixture:goal');
    const onCorner   = sendMatchEvt('fixture:corner');
    const onCard     = sendMatchEvt('fixture:card');
    // Pressão e BTTS-near são PROBABILIDADES AVANÇADAS (Premium) — só para premium.
    const onPressure = send('fixture:pressure');
    const onBtts     = send('fixture:btts-near');

    events.on('tick',              onTick);
    events.on('match:update',      onUpdate);
    events.on('match:upsert',      onUpsert);
    events.on('match:remove',      onRemove);
    events.on('fixture:goal',      onGoal);
    events.on('fixture:corner',    onCorner);
    events.on('fixture:card',      onCard);
    if (streamIsPremium) {
      events.on('fixture:pressure',  onPressure);
      events.on('fixture:btts-near', onBtts);
    }

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
      if (streamIsPremium) {
        events.off('fixture:pressure',  onPressure);
        events.off('fixture:btts-near', onBtts);
      }
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
    // Análise ao vivo é Premium: FREE recebe partida básica (sem IA) e nunca
    // predictions/odds calculadas.
    const fxIsPremium = isPremiumRequester(req);

    const safeMode = af.isSafeMode && af.isSafeMode();
    if (safeMode) {
      const cached = poller.getMatch(id);
      return res.json({
        ok: true,
        safeMode: true,
        fixture: signalAccess.projectMatchForUser(cached || null, fxIsPremium),
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
      fixture: signalAccess.projectMatchForUser(fixture, fxIsPremium),
      statistics: stats,
      events,
      lineups,
      // predictions/odds calculadas são Premium.
      predictions: fxIsPremium ? predictions : null,
      odds: fxIsPremium ? odds : null,
      ...(fxIsPremium ? {} : { locked: true, upgrade: true, message: signalAccess.LIVE_UPGRADE_MESSAGE }),
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

  router.get('/predictions/:fixtureId', gatePremiumFeature('premium_predictions'), asyncHandler(async (req, res) => {
    noStore(res);
    const data = await af.getPredictions(req.params.fixtureId);
    res.json({ ok: true, prediction: data[0] || null });
  }));

  router.get('/odds', gatePremiumFeature('premium_odds'), asyncHandler(async (req, res) => {
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

  router.get('/odds/live', gatePremiumFeature('premium_odds'), asyncHandler(async (req, res) => {
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
  router.get('/odds/bundle/:fixtureId', gatePremiumFeature('premium_odds'), asyncHandler(async (req, res) => {
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
    const raw = signalsEngine.listRecent({ limit, type, markets, minConfidence, sinceMs });
    // Validação obrigatória por plano: FREE só vê sinais FREE e respeita a cota
    // diária (anti-contorno — mesmo gating do feed principal /bet-signals).
    const signalAccess = require('../signalAccess');
    const isPrem = isPremiumRequester(req);
    const ctx = (!isPrem && req.user?.id != null) ? { userId: req.user.id } : undefined;
    const signals = signalAccess.projectSignalsForUser(raw, isPrem, ctx);
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
    // Análise ao vivo (recomendações de entrada da IA) é PREMIUM.
    if (!isPremiumRequester(req)) {
      return res.json({
        ok: true,
        locked: true,
        upgrade: true,
        currentTier: 'free',
        count: 0,
        total: 0,
        enriched: 0,
        signals: [],
        message: signalAccess.LIVE_UPGRADE_MESSAGE,
        generatedAt: new Date().toISOString(),
      });
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const prefs = {
      markets: req.query.markets ? String(req.query.markets).split(',').map((s) => s.trim()).filter(Boolean) : [],
      profile: ['conservative','aggressive','balanced'].includes(String(req.query.profile)) ? String(req.query.profile) : 'balanced',
      minConfidence: Math.max(0, Math.min(100, Number(req.query.minConfidence) || 0)),
    };
    const { filterSignalsByPrefs } = require('../services/signalGenerator');
    const matches = poller.getMatches();
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
     FILTRO DE LIGAS POPULARES (Bet365) — whitelist de competições
     ------------------------------------------------------------
     GET  → estado atual + competições da whitelist (público: o front
            usa para mostrar o badge/legenda do filtro).
     POST → liga/desliga o filtro "Mostrar apenas ligas populares da
            Bet365" (admin). Default: ATIVADO.
     ============================================================ */
  router.get('/signals/league-filter', (req, res) => {
    noStore(res);
    res.json({
      ok: true,
      popularOnly: leagueWhitelist.isPopularOnly(),
      mode: leagueWhitelist.filterMode,
      default: leagueWhitelist.envDefault,
      count: leagueWhitelist.WHITELIST_IDS.size,
      leagues: leagueWhitelist.listWhitelist(),
    });
  });

  router.post('/signals/league-filter', adminMw, express.json(), (req, res) => {
    noStore(res);
    const raw = req.body?.popularOnly;
    if (typeof raw !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'popularOnly (boolean) é obrigatório' });
    }
    const value = leagueWhitelist.setPopularOnly(raw);
    // Quando LIGADO, limpa imediatamente do cache jogos fora da whitelist.
    let purged = [];
    try { purged = poller.purgeNonWhitelisted?.('admin-toggle') || []; } catch (_) {}
    log.info('league filter toggled', { popularOnly: value, purged: purged.length });
    res.json({
      ok: true,
      popularOnly: value,
      purged: purged.length,
      count: leagueWhitelist.WHITELIST_IDS.size,
    });
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
    try {
      const subMod = require('../subscription');
      if (subMod.isAdminUser(u)) return true;
      const sub = req.subscription || subMod.resolveSubscriptionState(u);
      return !!sub.isPremium;
    } catch (_) {
      const role = String(u.role || '').toLowerCase();
      const plan = String(u.plan || '').toUpperCase();
      return role === 'admin' || role === 'owner' || role === 'premium'
          || plan === 'PREMIUM' || plan === 'VIP' || plan === 'PRO';
    }
  }

  // (gating por plano centralizado em backend/signalAccess.js)

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

    // Painel restrito aos 5 mercados ativos (remove WIN/1X2 legado que possa
    // ainda estar no ring buffer de sinais anteriores ao corte).
    const ALLOWED_MARKETS = new Set(['btts', 'over25', 'under25', 'corners', 'cards', 'cardsUnder']);
    signals = signals.filter((s) => ALLOWED_MARKETS.has(s.market));

    let quota = null;
    if (!isPrem) {
      // FREE: sinais PREMIUM viram placeholder de upgrade (nenhum dado preditivo
      // vaza) e sinais FREE perdem só a análise profunda. Além disso, aplica a
      // COTA DIÁRIA (máx. N sinais/dia) — sinais além do limite são bloqueados.
      // Fonte única do gating: signalAccess (REST e socket compartilham a cota).
      const signalAccess = require('../signalAccess');
      const ctx = req.user?.id != null ? { userId: req.user.id } : undefined;
      signals = signalAccess.projectSignalsForUser(signals, false, ctx);
      quota = signalAccess.freeQuotaSnapshot(req.user?.id);
    }

    res.json({
      ok: true,
      count: signals.length,
      signals,
      tier: isPrem ? 'premium' : 'free',
      quota,
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

  /**
   * GET /api/football/bet-signals/diag
   *
   * Diagnóstico de pipeline (qualquer usuário autenticado OU bypass via
   * METRICS_TOKEN). Pensado para comparar rapidamente o estado do engine
   * entre dev e Render quando /bet-signals retorna count=0.
   *
   * Auth:
   *  - Sessão normal (req.user) — qualquer tier
   *  - OU ?token=$METRICS_TOKEN ou header x-metrics-token  → bypass via curl
   *
   * Campos: engineRunning / engineEnabled / liveMatches / signalsInMemory /
   * lastTickAt / lastSignalAt / lastEmittedTickAgo / enrichEnabled /
   * apiFootballStatus / pollerRunning / pollerLastTickAt / thresholds /
   * lastTickFunnel / process.
   */
  function diagAuth(req, res, next) {
    const token = process.env.METRICS_TOKEN;
    const provided = req.query.token || req.get('x-metrics-token');
    if (token && provided && String(provided) === String(token)) return next();
    return requireAuth(db)(req, res, next);
  }

  router.get('/bet-signals/diag', diagAuth, (req, res) => {
    noStore(res);
    const signalAccessDiag = require('../signalAccess');
    let engineSnap = null, pollerSnap = null, apiStatus = null, recentList = [];
    try { engineSnap = betSignalEngine.snapshot(); } catch (e) { engineSnap = { error: e.message }; }
    try { pollerSnap = poller.snapshot(); }         catch (e) { pollerSnap = { error: e.message }; }
    try { apiStatus  = af.status(); }               catch (e) { apiStatus  = { error: e.message }; }
    try { recentList = betSignalEngine.listRecent({ limit: 1, minConfidence: 0 }) || []; }
    catch (_) { recentList = []; }

    const liveMatches = (poller.getMatches?.() || []).length;
    const lastSignal = recentList[0] || null;

    // Diagnóstico das chamadas a /fixtures/statistics — puxamos do módulo
    // apiFootball direto (não do footballProvider, que usa delegate).
    let statsCallDiag = null;
    let enricherSnap = null;
    let socketEmits = null;
    let pollerFunnel = null;
    try {
      const apiFootballMod = require('../services/apiFootball');
      statsCallDiag = apiFootballMod.getFixtureStatistics?.diagSnapshot?.() || null;
    } catch (_) { statsCallDiag = null; }
    try {
      const { getEnricher } = require('../services/fixtureEnricher');
      enricherSnap = getEnricher().snapshot();
    } catch (_) { enricherSnap = null; }
    try {
      const rt = require('../services/footballRealtime');
      socketEmits = rt.getEmitCounters?.() || null;
    } catch (_) { socketEmits = null; }
    try { pollerFunnel = poller.getLastFeedCompare?.() || null; } catch (_) { pollerFunnel = null; }

    // Sample do match cache: corners do top-3 live para validar pipeline
    let sampleMatchStats = [];
    try {
      const top = (poller.getMatches?.() || []).slice(0, 3);
      sampleMatchStats = top.map((m) => ({
        fixtureId: m.fixtureId || m.id,
        match: `${m.home} x ${m.away}`,
        minute: m.minute,
        enriched: !!m.enriched,
        enrichedPartial: !!m.enrichedPartial,
        corners: m.stats?.corners || null,
        shots: m.stats?.shots || null,
        shotsOnTarget: m.stats?.shotsOnTarget || null,
        dangerousAttacks: m.stats?.dangerousAttacks || null,
      }));
    } catch (_) { sampleMatchStats = []; }

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),

      engineRunning:    !!engineSnap?.started,
      engineEnabled:    !!engineSnap?.enabled,
      signalsInMemory:  engineSnap?.recent ?? 0,
      lastTickAt:       engineSnap?.lastTickAt || null,
      lastSignalAt:     lastSignal?.createdAt || null,
      lastEmittedTickAgo: engineSnap?.lastTickAt
        ? Date.now() - engineSnap.lastTickAt
        : null,

      liveMatches,
      pollerRunning:    !!pollerSnap?.running,
      pollerLastTickAt: pollerSnap?.lastTickAt || null,
      pollerInterval:   pollerSnap?.intervalMs || null,
      pollerCacheSize:  pollerSnap?.tracked ?? null,
      pollerAlive:      !!pollerSnap?.alive,
      pollerLastError:  pollerSnap?.lastError || pollerSnap?.lastFallbackReason || null,
      pollerConsecutiveFailures: pollerSnap?.consecutiveFailures ?? null,

      enrichEnabled: String(process.env.ENRICH_ENABLED || 'true').toLowerCase() !== 'false',
      strictRealOnly: String(process.env.STRICT_REAL_ONLY || '').toLowerCase() === 'true',
      betSignalDebug: String(process.env.BET_SIGNAL_DEBUG || 'false').toLowerCase() === 'true',
      liveSignalDebug: String(process.env.LIVE_SIGNAL_DEBUG || '').toLowerCase() === 'true',

      // [STATS COVERAGE] — resumo direto (item solicitado): a API-Football
      // está devolvendo estatísticas para ALGUM fixture nas últimas 24h?
      //   verdict=all-empty  → nenhuma stat chegou (plano/cobertura)
      //   verdict=mixed      → algumas ligas têm cobertura, outras não
      //   verdict=all-ok     → stats chegando normalmente
      statsCoverage: statsCallDiag ? {
        ok24h:           statsCallDiag.ok24h ?? 0,
        empty24h:        statsCallDiag.empty24h ?? 0,
        emptyPct24h:     statsCallDiag.emptyPct24h ?? 0,
        verdict:         statsCallDiag.verdict ?? 'no-data-yet',
        okFixtureIds:    statsCallDiag.okFixtureIds ?? [],
        emptyFixtureIds: statsCallDiag.emptyFixtureIds ?? [],
      } : null,

      // /fixtures/statistics — confirma se a API está sendo chamada
      // e quantas respostas 200 (com array preenchido) chegaram.
      statsApiCalls: statsCallDiag,
      enricherStatus: enricherSnap ? {
        enabled: enricherSnap.enabled,
        running: enricherSnap.running,
        lastTickAt: enricherSnap.lastTickAt,
        tracked: enricherSnap.tracked,
        inflight: enricherSnap.inflight,
        systemQueue: enricherSnap.systemQueue,
        stats: enricherSnap.stats,
      } : null,

      // FUNIL DE MATCHES — onde os jogos são reduzidos:
      //   apiRaw → blacklist → priority → liveStatus → cache → getMatches
      //   → socket emits
      pollerFunnel,
      socketEmits,
      sampleMatchStats,
      lastTickByMarket: engineSnap?.lastTickByMarket || null,
      lastCornersStats: engineSnap?.lastCornersStats || null,

      apiFootballStatus: apiStatus ? {
        configured: apiStatus.configured,
        hasKey: apiStatus.hasKey,
        host: apiStatus.host,
        safeMode: apiStatus.safeMode,
        breaker: apiStatus.breaker,
        rateLimit: apiStatus.rateLimit,
      } : null,

      thresholds: {
        minConfidence: engineSnap?.minConfidence ?? null,
        freeMin: engineSnap?.freeMinConfidence ?? null,
        premiumMin: engineSnap?.premiumMinConfidence ?? null,
        oddRange: engineSnap?.oddRange ?? null,
        minuteRange: engineSnap?.minuteRange ?? null,
        cooldownMs: engineSnap?.cooldownMs ?? null,
        tickMs: engineSnap?.tickMs ?? null,
        mode: engineSnap?.mode ?? null,
      },

      lastTickFunnel: engineSnap?.lastTickSummary || null,
      funnelTotals:   engineSnap?.funnelTotals   || null,

      // Amostra diagnóstica do último sinal. Conteúdo preditivo só é revelado
      // a quem tem acesso premium/admin (ou via METRICS_TOKEN). FREE vê apenas
      // metadados não sensíveis — nunca o palpite/odd de um sinal premium.
      lastSignalSample: lastSignal ? (() => {
        const tokenOk = process.env.METRICS_TOKEN
          && String(req.query.token || req.get('x-metrics-token') || '') === String(process.env.METRICS_TOKEN);
        const reveal = tokenOk || isPremiumRequester(req) || !signalAccessDiag.isPremiumSignal(lastSignal);
        const base = {
          market: lastSignal.market,
          tier: lastSignal.tier,
          createdAt: lastSignal.createdAt,
        };
        if (!reveal) return { ...base, locked: true };
        return {
          ...base,
          prediction: lastSignal.prediction,
          confidence: lastSignal.confidence,
          odd: lastSignal.oddEstimated,
          match: lastSignal.match
            ? `${lastSignal.match.home} x ${lastSignal.match.away}`
            : null,
          minute: lastSignal.match?.minute,
        };
      })() : null,

      process: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.version,
      },
    });
  });

  /**
   * GET /api/football/bet-signals/diag/decisions/:id
   *
   * Lista as últimas N decisões do bet engine para um fixtureId específico.
   * Mostra exatamente em qual etapa cada sinal foi descartado e os
   * números (conf/prob/odd) que levaram ao drop.
   *
   * Auth: requireAuth(db) OU ?token=$METRICS_TOKEN
   * Query: ?limit=30 (max 30 — tamanho do ring buffer por fixture)
   *
   * Quando o usuário quer entender "por que esse jogo do Bayern não
   * gerou nenhum sinal apesar de stats reais", essa rota responde:
   *   - corners DROP low-confidence conf=58 < 65
   *   - btts    DROP odd-out-of-range odd=1.43 < 1.80
   *   - win     DROP odd-out-of-range odd=1.45 < 1.80
   */
  router.get('/bet-signals/diag/decisions/:id', diagAuth, (req, res) => {
    noStore(res);
    const id = String(req.params.id);
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 30));
    const decisions = betSignalEngine.getDecisionsFor(id, { limit });

    // Agregação por (market, result/reason) — útil pra ver padrão
    const byMarket = {};
    for (const d of decisions) {
      const k = d.market;
      if (!byMarket[k]) byMarket[k] = { total: 0, emit: 0, dropByReason: {} };
      byMarket[k].total++;
      if (d.result === 'EMIT') byMarket[k].emit++;
      else {
        const r = d.reason || 'unknown';
        byMarket[k].dropByReason[r] = (byMarket[k].dropByReason[r] || 0) + 1;
      }
    }

    res.json({
      ok: true,
      fixtureId: id,
      count: decisions.length,
      summary: byMarket,
      decisions: decisions.map((d) => ({
        ts: new Date(d.ts).toISOString(),
        market: d.market,
        result: d.result,
        reason: d.reason || null,
        confidence: d.confidence ?? null,
        threshold: d.threshold ?? null,
        probability: d.probability ?? null,
        odd: d.odd ?? null,
        oddRange: d.oddRange ?? null,
        prediction: d.prediction ?? null,
        extras: d.extras ?? null,
        justification: d.justification ?? null,
        cooldownMs: d.cooldownMs ?? null,
        match: d.match ?? null,
        min: d.min ?? null,
      })),
    });
  });

  /**
   * GET /api/football/bet-signals/diag/decisions
   *
   * Lista os fixtures com decisões em buffer (auxiliar pra
   * descobrir IDs sem precisar do /live).
   */
  router.get('/bet-signals/diag/decisions', diagAuth, (req, res) => {
    noStore(res);
    res.json({
      ok: true,
      fixtures: betSignalEngine.listDecisionFixtures({ limit: 50 }),
    });
  });

  /**
   * GET /api/football/bet-signals/diag/markets
   *
   * Funil de sinais separado pelos 5 mercados de produto:
   *   btts | over25 | under25 | cornersOver
   *
   * Para cada mercado:
   *   {
   *     candidates: <compute*Bet() != null>,
   *     emitted:    <passou todos os gates>,
   *     drops:      { compute-null, low-confidence, odd-out-of-range,
   *                   cooldown, market-not-implemented }
   *   }
   *
   * Inclui também:
   *   - preGate           : not-enriched / no-stats / minute-out-of-range
   *                         (são DROPS que acontecem ANTES do loop por
   *                         mercado — afetam os 5 mercados igualmente)
   *   - lastTick          : snapshot do tick mais recente
   *   - thresholds        : valores ativos de minConfidence / oddRange / ...
   *   - notes             : status de implementação por mercado
   *   - pollerFunnel      : apiRaw → blacklist → liveStatus → cache
   *                         (responde "por que só 3 jogos")
   *   - liveMatches       : tamanho atual de poller.getMatches()
   *
   * Auth: requireAuth(db) OU ?token=$METRICS_TOKEN.
   * Não altera nenhum cálculo, threshold ou filtro — apenas relata.
   */
  router.get('/bet-signals/diag/markets', diagAuth, (req, res) => {
    noStore(res);

    let funnel = null;
    try { funnel = betSignalEngine.getMarketFunnel?.() || null; } catch (_) { funnel = null; }

    let pollerFunnel = null;
    let liveMatches = null;
    try {
      const poller = getPoller();
      pollerFunnel = poller.getLastFeedCompare?.() || null;
      liveMatches = (poller.getMatches?.() || []).length;
    } catch (_) { /* defensivo */ }

    let enricherSnap = null;
    try {
      const { getEnricher } = require('../services/fixtureEnricher');
      enricherSnap = getEnricher().snapshot();
    } catch (_) { enricherSnap = null; }

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),

      // === SHAPE PRINCIPAL pedido pelo produto ===
      btts:         funnel?.markets?.btts         || { candidates: 0, emitted: 0, drops: {} },
      over25:       funnel?.markets?.over25       || { candidates: 0, emitted: 0, drops: {} },
      under25:      funnel?.markets?.under25      || { candidates: 0, emitted: 0, drops: {} },
      cornersOver:  funnel?.markets?.cornersOver  || { candidates: 0, emitted: 0, drops: {} },
      cardsOver:    funnel?.markets?.cardsOver    || { candidates: 0, emitted: 0, drops: {} },
      cardsUnder:   funnel?.markets?.cardsUnder   || { candidates: 0, emitted: 0, drops: {} },

      // === metadados de diagnóstico ===
      lastTick:     funnel?.lastTick     || null,
      preGate:      funnel?.preGate      || null,
      thresholds:   funnel?.thresholds   || null,
      notes:        funnel?.notes        || null,
      lastTickAt:   funnel?.lastTickAt   || null,

      // === investigação "por que só 3 jogos" ===
      // pollerFunnel.apiRawCount     -> quantos jogos a API devolveu
      // pollerFunnel.purgedByBlacklist -> removidos pela blacklist de ligas
      // pollerFunnel.purgedByLiveStatus -> removidos pelo isLiveMatch()
      // pollerFunnel.cacheSize       -> permanecem no cache
      // pollerFunnel.restGetMatchesCount -> entregues a /live e ao engine
      pollerFunnel,
      liveMatches,
      enricher: enricherSnap ? {
        enabled: enricherSnap.enabled,
        running: enricherSnap.running,
        autoTop: enricherSnap.autoTop,
        pollerEnrichTop: enricherSnap.pollerEnrichTop,
        tracked: enricherSnap.tracked,
        inflight: enricherSnap.inflight,
        stats: enricherSnap.stats,
      } : null,
    });
  });

  /**
   * POST /api/football/bet-signals/diag/trace-front
   *
   * Endpoint best-effort para o frontend reportar [STAT TRACE 6/6] e
   * fechar o ciclo no /diag/trace/:id consolidado. Sem auth — payload
   * é só { fixtureId, flat:{ corners, shots, ... } }.
   */
  router.post('/bet-signals/diag/trace-front', express.json({ limit: '4kb' }), (req, res) => {
    try {
      const statTrace = require('../services/statTrace');
      const id = String(req.body?.fixtureId || '');
      const flat = req.body?.flat || {};
      if (id) statTrace.trace('front-render', id, { flat, extra: { source: 'browser' } });
    } catch (_) { /* defensivo */ }
    res.json({ ok: true });
  });

  /**
   * GET /api/football/bet-signals/diag/trace/:id
   *
   * Devolve um JSON ÚNICO com os 6 estágios do pipeline para o fixtureId
   * pedido, mostrando os mesmos 5 campos (corners, shots, shotsOnTarget,
   * dangerousAttacks, attacks) em cada estágio.
   *
   * Os estágios 1-3 vêm do buffer de statTrace.js (alimentado em runtime
   * pelo enricher); 4-5 são preenchidos sob demanda pelo handler;
   * 6 (front-render) é coletado pelo navegador (ver dashboard.js).
   *
   * Auth: requireAuth(db) OU ?token=$METRICS_TOKEN
   *
   * Para FORÇAR o tracing de um id específico, defina
   * STAT_TRACE_FIXTURE_ID=… em runtime, ou bata neste endpoint passando
   * o id desejado — ele vira o auto-target por 5 minutos.
   */
  router.get('/bet-signals/diag/trace/:id', diagAuth, asyncHandler(async (req, res) => {
    noStore(res);
    const id = String(req.params.id);
    const statTrace = require('../services/statTrace');
    statTrace.setAutoTarget(id); // garante que próximos ticks tracem este id

    const buf = statTrace.snapshot(id) || {};

    // Adiciona estágio 4 (rest-live) sob demanda — chama o mesmo pipeline
    // do GET /api/football/live para esse fixture específico.
    const allLive = poller.getMatches?.() || [];
    const targetMatch = allLive.find((m) => String(m.fixtureId || m.id) === id);
    if (targetMatch) {
      buf['rest-live-now'] = {
        ts: Date.now(),
        stats: targetMatch.stats || null,
        flat: {
          corners: targetMatch.stats?.corners?.total ?? null,
          shots: targetMatch.stats?.shots?.total ?? null,
          shotsOnTarget: targetMatch.stats?.shotsOnTarget?.total ?? null,
          dangerousAttacks: targetMatch.stats?.dangerousAttacks?.total ?? null,
          attacks: targetMatch.stats?.attacks?.total ?? null,
        },
        extra: {
          enriched: !!targetMatch.enriched,
          enrichedPartial: !!targetMatch.enrichedPartial,
          minute: targetMatch.minute,
          home: targetMatch.home, away: targetMatch.away,
        },
      };
    }

    // Helper para extrair os 5 campos de qualquer stage
    function flatten(stage) {
      if (!stage) return null;
      const f = stage.flat || {};
      const s = stage.stats || {};
      return {
        corners: f.corners ?? s?.corners?.total ?? null,
        shots: f.shots ?? s?.shots?.total ?? null,
        shotsOnTarget: f.shotsOnTarget ?? s?.shotsOnTarget?.total ?? null,
        dangerousAttacks: f.dangerousAttacks ?? s?.dangerousAttacks?.total ?? null,
        attacks: f.attacks ?? s?.attacks?.total ?? null,
      };
    }

    const stages = {
      stage1_apiRaw:           flatten(buf['api-raw']),
      stage2_enricher:         flatten(buf['enricher']),
      stage3_normalizer:       flatten(buf['normalizer']),
      stage4_restLiveNow:      flatten(buf['rest-live-now']),
      stage4_restLiveLastEmit: flatten(buf['rest-live']),
      stage5_socketEmit:       flatten(buf['socket-emit']),
      stage6_frontRender:      flatten(buf['front-render']) || '⚠ veja [STAT TRACE 6/6] no console DevTools do navegador',
    };

    // Detecta em qual stage os campos zeram/desaparecem
    const stageOrder = ['stage1_apiRaw', 'stage2_enricher', 'stage3_normalizer', 'stage4_restLiveNow', 'stage5_socketEmit'];
    let dropDetectedAt = null;
    let prev = null;
    for (const k of stageOrder) {
      const s = stages[k];
      if (!s) continue;
      if (prev) {
        const fields = ['corners', 'shots', 'shotsOnTarget', 'dangerousAttacks', 'attacks'];
        const lostFields = fields.filter((f) => (prev[f] || 0) > 0 && !(s[f] > 0));
        if (lostFields.length) {
          dropDetectedAt = { from: prev._stage, to: k, fieldsLost: lostFields, prev, current: s };
          break;
        }
      }
      if (s) prev = { ...s, _stage: k };
    }

    // Hint humano
    let hint = null;
    if (!buf['api-raw'] && !buf['normalizer']) {
      hint = 'Nenhum trace gravado. Aguarde 1 ciclo do enricher (~30s) ou ENRICH_ENABLED=false bloqueia api-raw.';
    } else if (buf['normalizer']?.extra?.mode === 'MINIMAL') {
      hint = 'Stage 3 está em modo MINIMAL — applyMinimalEnrichment está zerando tudo (cenário ENRICH_ENABLED=false / safeMode).';
    } else if (dropDetectedAt) {
      hint = `Stats foram perdidos entre ${dropDetectedAt.from} e ${dropDetectedAt.to} nos campos ${dropDetectedAt.fieldsLost.join(', ')}.`;
    } else {
      const lastBackend = stages.stage5_socketEmit || stages.stage4_restLiveNow;
      if (lastBackend && Object.values(lastBackend).every((v) => !v)) {
        hint = 'Backend está zerado em todos os stages backend. Causa: enricher não rodou (verifique ENRICH_ENABLED) ou API devolveu vazio (veja /diag/stats/:id).';
      }
    }

    res.json({
      ok: true,
      fixtureId: id,
      target: statTrace.getTarget(),
      stages,
      timestamps: {
        apiRaw:      buf['api-raw']?.ts ? new Date(buf['api-raw'].ts).toISOString() : null,
        enricher:    buf['enricher']?.ts ? new Date(buf['enricher'].ts).toISOString() : null,
        normalizer:  buf['normalizer']?.ts ? new Date(buf['normalizer'].ts).toISOString() : null,
        restLive:    buf['rest-live']?.ts ? new Date(buf['rest-live'].ts).toISOString() : null,
        socketEmit:  buf['socket-emit']?.ts ? new Date(buf['socket-emit'].ts).toISOString() : null,
        frontRender: buf['front-render']?.ts ? new Date(buf['front-render'].ts).toISOString() : null,
      },
      dropDetectedAt,
      hint,
      raw: {
        normalizerExtra: buf['normalizer']?.extra || null,
        apiRawTypes:     buf['api-raw']?.raw?.types || null,
        apiTeamsCount:   buf['api-raw']?.raw?.teamsCount ?? null,
      },
    });
  }));

  /**
   * GET /api/football/bet-signals/diag/stats/:id
   *
   * Dump CRU da resposta /fixtures/statistics para um fixture específico.
   * Útil quando os logs [STATS FETCH] mostram array vazio e queremos ver
   * exatamente o que a API-Football devolveu (com todos os types
   * disponíveis), sem precisar acessar o backend manualmente.
   *
   * Auth: requireAuth(db) OU ?token=$METRICS_TOKEN
   *
   * Resposta:
   *   {
   *     ok: true,
   *     fixtureId, durationMs,
   *     response: <bruto da API-Football>,           // truncado a 8KB
   *     extracted: { corners, shots, sot, dang, … }, // o que applyEnrichment extrairia
   *     typesByTeam: [['Corner Kicks','Total Shots',…], […]]
   *   }
   */
  router.get('/bet-signals/diag/stats/:id', diagAuth, asyncHandler(async (req, res) => {
    noStore(res);
    const id = req.params.id;
    const t0 = Date.now();
    let response = null;
    let error = null;
    try {
      const apiFootballMod = require('../services/apiFootball');
      response = await apiFootballMod.getFixtureStatistics(id);
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    }
    const durMs = Date.now() - t0;

    // Espelha exatamente a lógica do fixtureNormalizer.applyEnrichment
    function findVal(team, type) {
      const row = (team?.statistics || []).find((s) => s?.type === type);
      const v = row?.value;
      if (v == null) return 0;
      if (typeof v === 'string' && v.endsWith('%')) return Number(v.slice(0, -1)) || 0;
      return Number(v) || 0;
    }
    const teams = Array.isArray(response) ? response : [];
    const t0t = teams[0] || {};
    const t1t = teams[1] || {};
    const extracted = {
      teams: teams.length,
      home: {
        teamId: t0t?.team?.id, teamName: t0t?.team?.name,
        corners: findVal(t0t, 'Corner Kicks'),
        shots: findVal(t0t, 'Total Shots'),
        shotsOnTarget: findVal(t0t, 'Shots on Goal'),
        shotsOffTarget: findVal(t0t, 'Shots off Goal'),
        dangerousAttacks: findVal(t0t, 'Dangerous Attacks'),
        attacks: findVal(t0t, 'Attacks'),
        possession: findVal(t0t, 'Ball Possession'),
        yellow: findVal(t0t, 'Yellow Cards'),
        red: findVal(t0t, 'Red Cards'),
        fouls: findVal(t0t, 'Fouls'),
        passAccuracy: findVal(t0t, 'Passes %'),
      },
      away: {
        teamId: t1t?.team?.id, teamName: t1t?.team?.name,
        corners: findVal(t1t, 'Corner Kicks'),
        shots: findVal(t1t, 'Total Shots'),
        shotsOnTarget: findVal(t1t, 'Shots on Goal'),
        shotsOffTarget: findVal(t1t, 'Shots off Goal'),
        dangerousAttacks: findVal(t1t, 'Dangerous Attacks'),
        attacks: findVal(t1t, 'Attacks'),
        possession: findVal(t1t, 'Ball Possession'),
        yellow: findVal(t1t, 'Yellow Cards'),
        red: findVal(t1t, 'Red Cards'),
        fouls: findVal(t1t, 'Fouls'),
        passAccuracy: findVal(t1t, 'Passes %'),
      },
    };
    const typesByTeam = teams.map((t) => (t?.statistics || []).map((s) => s?.type));

    res.json({
      ok: !error,
      fixtureId: id,
      durationMs: durMs,
      apiResponse: response,
      apiResponseTruncated: JSON.stringify(response || null).length > 8192,
      extracted,
      typesByTeam,
      error,
      hint: !error && (!teams.length || (!extracted.home.corners && !extracted.away.corners
        && !extracted.home.shots && !extracted.away.shots))
        ? 'API respondeu mas extracted está zerado/vazio. Veja typesByTeam para confirmar se o schema mudou.'
        : null,
    });
  }));

  /**
   * GET /api/football/bet-signals/debug
   *  Diagnóstico do pipeline de sinais (admin):
   *    - funil completo (input → enriched → minute → compute → conf → odd → cooldown → emitted)
   *    - contagem absoluta e percentual em cada estágio
   *    - últimas N decisões de descarte com motivo + payload curto
   *    - hints automáticos identificando o gargalo
   *
   *  Use ?drops=50 para ver mais descartes (max 100).
   */
  router.get('/bet-signals/debug', adminMw, (req, res) => {
    noStore(res);
    const dropLimit = Math.min(100, Math.max(1, Number(req.query.drops || 30)));
    res.json({
      ok: true,
      engine: 'betSignalEngine',
      generatedAt: new Date().toISOString(),
      report: betSignalEngine.debugReport({ dropLimit }),
    });
  });

  /**
   * GET /api/football/signals/debug
   *  Mesmo diagnóstico para o signalsEngine REATIVO (detectors).
   */
  router.get('/signals/debug', adminMw, (req, res) => {
    noStore(res);
    const dropLimit = Math.min(100, Math.max(1, Number(req.query.drops || 30)));
    res.json({
      ok: true,
      engine: 'signalsEngine',
      generatedAt: new Date().toISOString(),
      report: signalsEngine.debugReport({ dropLimit }),
    });
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
    const reason = computeLiveReason(matches.length);
    res.json({
      ok: true,
      count: matches.length,
      // Validação obrigatória por plano: FREE só recebe dados básicos da partida.
      matches: signalAccess.projectMatchesForUser(matches, isPremiumRequester(req)),
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
     INSIGHTS — leitura IA interpretativa (PREMIUM)
     Devolve trends + reads + picks. Computado on-demand a partir do
     match cacheado no poller. Sem nova chamada à API.
     FREE/anônimo recebe 402 + locked → overlay de upgrade no frontend.
     ============================================================ */
  router.get('/fixture/:id/insight', gatePremiumFeature('premium_insight'), (req, res) => {
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

  /* ============================================================
     MONITOR DE CONSUMO DA API-FOOTBALL (admin)
     GET /api/admin/api-usage
     Números REAIS de créditos gastos (1 chamada de rede = 1 crédito),
     atribuídos por fonte (poller/enricher/rotas), com séries para gráfico
     e relatório de projeção/risco. ZERO chamada à API (só leitura).
     ============================================================ */
  app.get('/api/admin/api-usage', requireAuth(db), requireAdmin, (req, res) => {
    noStore(res);

    let usage;
    try {
      usage = require('../services/apiUsageTracker').snapshot();
    } catch (e) {
      console.error('[API USAGE] snapshot() falhou:', e.message, e.stack);
      usage = {
        error: e.message,
        callsToday: 0, callsLastHour: 0,
        pollerToday: 0, enricherToday: 0, routeToday: 0, otherToday: 0,
        todayBySource: {},
        byEndpoint: [], charts: { hourly: [], daily: [] },
        avgDaily: 0, todayProjected: 0, completeDaysSampled: 0,
        totalSinceBoot: 0, generatedAt: new Date().toISOString(),
      };
    }

    const status = af.status?.() || {};
    const quota = status.quota || {};
    const perDay  = status.rateLimit?.perDay ?? null;
    const dayUsed = status.rateLimit?.dayUsed ?? null;

    // Limite/restante: prioriza headers oficiais da API; cai pro rate-limiter local.
    const dailyLimit = quota.dailyLimit ?? perDay ?? null;
    const dailyRemaining = quota.dailyRemaining
      ?? (perDay != null && dayUsed != null ? Math.max(0, perDay - dayUsed) : null);
    const creditsConsumed = (dailyLimit != null && dailyRemaining != null)
      ? (dailyLimit - dailyRemaining)
      : (dayUsed ?? usage.callsToday);

    // Jogos monitorados (cache do poller) + fila do enricher.
    let gamesMonitored = 0;
    try { gamesMonitored = (poller.getMatches?.() || []).length; } catch (_) {}
    let enricherSnap = null;
    try { enricherSnap = getEnricher().snapshot(); } catch (_) {}

    // === Relatório: média diária, projeção mensal, risco ===
    const basis = Math.max(usage.avgDaily || 0, usage.todayProjected || 0);
    const monthlyProjection = Math.round(basis * 30);
    let riskLevel = 'BAIXO';
    let riskRatio = null;
    if (dailyLimit && dailyLimit > 0) {
      riskRatio = +(basis / dailyLimit).toFixed(2);
      if (riskRatio >= 0.9) riskLevel = 'CRÍTICO';
      else if (riskRatio >= 0.7) riskLevel = 'ALTO';
      else if (riskRatio >= 0.5) riskLevel = 'MODERADO';
      else riskLevel = 'BAIXO';
    }

    res.json({
      ok: true,
      // KPIs principais
      callsToday: usage.callsToday,
      callsLastHour: usage.callsLastHour,
      byEndpoint: usage.byEndpoint,
      credits: {
        limit: dailyLimit,
        consumed: creditsConsumed,
        remaining: dailyRemaining,
        source: quota.dailyLimit != null ? 'api-headers' : 'rate-limiter-local',
      },
      gamesMonitored,
      consumption: {
        poller:   usage.pollerToday,
        enricher: usage.enricherToday,
        route:    usage.routeToday,
        other:    usage.otherToday,
        bySource: usage.todayBySource,
      },
      // Gráficos
      charts: usage.charts,
      // Relatório
      report: {
        avgDaily: usage.avgDaily,
        todayProjected: usage.todayProjected,
        monthlyProjection,
        riskLevel,
        riskRatio,
        completeDaysSampled: usage.completeDaysSampled,
      },
      // Telemetria auxiliar
      safeMode: af.isSafeMode?.() || false,
      breaker: status.breaker?.state || null,
      enricher: enricherSnap ? {
        running: enricherSnap.running,
        liveRefreshMs: enricherSnap.liveRefreshMs,
        includeEvents: enricherSnap.includeEvents,
        systemQueue: enricherSnap.systemQueue,
        tracked: enricherSnap.tracked,
      } : null,
      totalSinceBoot: usage.totalSinceBoot,
      generatedAt: usage.generatedAt,
    });
  });

  // Pipeline SYSTEM — ZERO auth no mount (token inválido não pode quebrar bootstrap).
  app.use('/api/football', router);
}

module.exports = { buildFootballRoutes };
