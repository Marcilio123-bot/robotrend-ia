/**
 * Robotrend IA — Football Realtime (Socket.io)
 *
 * Cria o namespace `/football` em cima do socket.io existente e roteia
 * os eventos do EventBus para os clientes conectados.
 *
 * Rooms:
 *   `lobby`               -> recebe TODOS os updates (default ao conectar)
 *   `fixture:<id>`        -> updates somente daquela partida
 *   `league:<id|name>`    -> updates filtrados por liga
 *
 * Clientes podem fazer:
 *   socket.emit('subscribe', { type: 'fixture', id: 123 })
 *   socket.emit('unsubscribe', { type: 'fixture', id: 123 })
 *   socket.emit('list', cb) -> snapshot completo
 *
 * Eventos enviados pelo servidor (camelCase, alinhado com SSE):
 *   tick, match:upsert, match:update, match:remove,
 *   fixture:goal, fixture:corner, fixture:card, fixture:pressure,
 *   fixture:btts-near, quota:low, circuit:open, circuit:close
 */

'use strict';

const events = require('./footballEvents');
const metrics = require('./metrics');
const { getPoller } = require('../workers/liveFootballPoller');
const { getEnricher } = require('./fixtureEnricher');
const { logger } = require('../logger');

const log = logger.child({ module: 'football-realtime' });

const MAX_EMIT_PER_SEC = Number(process.env.FOOTBALL_RT_MAX_EMIT_PER_SEC || 50);

const g_sockets       = metrics.gauge('socket_connected', 'Sockets ativos no namespace /football');
const m_socket_open   = metrics.counter('socket_open_total');
const m_socket_close  = metrics.counter('socket_close_total');
const m_emit_total    = metrics.counter('socket_emit_total');
const m_emit_dropped  = metrics.counter('socket_emit_dropped_total', 'Emits descartados pelo throttle');
const m_room_sub      = metrics.counter('socket_subscribe_total');
const m_room_unsub    = metrics.counter('socket_unsubscribe_total');
const m_prefs_filter  = metrics.counter('socket_prefs_filtered_total', 'Emits poupados por prefs do cliente');
const w_emit          = metrics.window('socket_emit_window', { windowMs: 60_000 });

/* ============================================================
   PREFS DO CLIENTE — camada de intenção do usuário (server-side)
   Cliente envia: { markets:['corners','goals'], profile:'conservative'|'aggressive'|'balanced', minConfidence:70 }
   Backend pula emits de sinais/eventos pontuais que NÃO batem com prefs.
   match:enriched continua broadcast (insight completo, frontend filtra picks).
   ============================================================ */
const EVENT_MARKET_TAG = {
  'fixture:goal':      'goals',
  'fixture:corner':    'corners',
  'fixture:card':      'cards',
  'fixture:pressure':  'pressure',
  'fixture:btts-near': 'btts',
};

/**
 * true se o socket aceita receber este sinal/evento.
 *
 * Regras de PROFILE (perfil de risco):
 *   - prefs.profile = 'balanced' (ou ausente) → aceita qualquer perfil de sinal
 *   - sinal sem profile, ou profile = 'balanced' → aceita por qualquer perfil de prefs
 *   - caso restante exige match exato
 */
function prefsAllow(prefs, { market, confidence, profile = null }) {
  if (!prefs) return true; // sem prefs → recebe tudo (compat com cliente legado)
  if (prefs.minConfidence && Number.isFinite(confidence) && confidence < prefs.minConfidence) return false;
  if (Array.isArray(prefs.markets) && prefs.markets.length && market) {
    if (!prefs.markets.includes(market)) return false;
  }
  if (prefs.profile && prefs.profile !== 'balanced' && profile && profile !== 'balanced') {
    if (profile !== prefs.profile) return false;
  }
  return true;
}

/** Emite para sockets de uma room respeitando prefs. */
function emitFiltered(ns, room, evt, payload, { market, confidence, profile } = {}) {
  const sockets = ns.adapter.rooms.get(room);
  if (!sockets || !sockets.size) return 0;
  let sent = 0, filtered = 0;
  for (const sid of sockets) {
    const s = ns.sockets.get(sid);
    if (!s) continue;
    if (prefsAllow(s.data?.prefs, { market, confidence, profile })) {
      s.emit(evt, payload);
      sent++;
    } else {
      filtered++;
    }
  }
  if (filtered) m_prefs_filter.inc(filtered, { event: evt });
  return sent;
}

function leagueRoom(m) {
  const id = m?.league?.id || m?.league?.name;
  return id ? `league:${id}` : null;
}
function fixtureRoom(m) {
  const id = m?.fixtureId || m?.id;
  return id ? `fixture:${id}` : null;
}

/**
 * Throttle simples (drop excedente). Garante que mesmo eventos
 * espúrios não saturem o socket.
 */
function makeThrottle(maxPerSec) {
  let bucket = 0;
  let resetAt = Date.now() + 1000;
  return function allow() {
    const now = Date.now();
    if (now >= resetAt) { bucket = 0; resetAt = now + 1000; }
    if (bucket >= maxPerSec) return false;
    bucket++;
    return true;
  };
}

function attachFootballRealtime(io, opts = {}) {
  const ns = io.of('/football');
  const poller = getPoller();
  const enricher = getEnricher();
  const allow = makeThrottle(MAX_EMIT_PER_SEC);

  // Middleware de auth no namespace /football — popula `socket.user`
  // (replica o middleware global em `io.use` mas no namespace específico).
  // Sem isso, `isPremiumSocket()` e `emitAdminOnly()` nunca enxergam o user.
  const db = opts.db || null;
  const auth = opts.auth || null;
  if (db && auth) {
    ns.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token
          || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
        if (token) {
          const payload = auth.verifyToken(token);
          if (payload?.sub) {
            const u = await db.findUserById(payload.sub);
            if (u) socket.user = { id: u.id, plan: u.plan, role: u.role, email: u.email };
          }
        }
      } catch (_) { /* anônimo OK */ }
      next();
    });
  }

  // Injeta no enricher uma função que devolve as fixtures atualmente subscritas
  enricher.setSubscriberSource(() => {
    const out = new Set();
    try {
      const rooms = ns.adapter.rooms;
      for (const [roomName, sockets] of rooms.entries()) {
        // Pula rooms que são apenas o socket id default
        if (ns.sockets.has(roomName)) continue;
        if (!roomName.startsWith('fixture:')) continue;
        if (!sockets || sockets.size === 0) continue;
        out.add(roomName.slice('fixture:'.length));
      }
    } catch (_) { /* defensive */ }
    return out;
  });

  ns.on('connection', (socket) => {
    g_sockets.inc(1);
    m_socket_open.inc();
    log.info('client connected', { id: socket.id, total: ns.sockets.size });
    socket.join('lobby');

    socket.emit('hello', {
      service: 'robotrend-football',
      socketId: socket.id,
      ts: Date.now(),
    });

    let snapshotMatches = poller.getMatches();
    const { ensureAllMinimal } = require('./fixtureNormalizer');
    ensureAllMinimal(snapshotMatches);
    socket.emit('tick', {
      matches: snapshotMatches,
      generatedAt: new Date().toISOString(),
      source: 'snapshot',
      poller: poller.snapshot(),
    });
    enricher.bootstrapTop(snapshotMatches);
    enricher.queueFromPoller(snapshotMatches);

    socket.on('subscribe', (payload, cb) => {
      try {
        const room = roomFromPayload(payload);
        if (!room) return cb?.({ ok: false, error: 'payload inválido' });
        socket.join(room);
        m_room_sub.inc(1, { kind: payload?.type || 'unknown' });

        // Subscribe a uma fixture → dispara enrichment imediato (cache de 30min
        // garante 0 custo se já estiver enriquecida recentemente).
        if (payload?.type === 'fixture' && payload?.id) {
          enricher.requestEnrich(payload.id).then((r) => {
            // Se já estava enriquecida e em cache, manda direto o snapshot
            const m = poller.getMatch(payload.id);
            if (m?.enriched) {
              socket.emit('match:enriched', { match: m, fixtureId: Number(payload.id), ts: m.enrichedAt });
            } else if (!r?.ok) {
              socket.emit('match:enrich-fail', { fixtureId: Number(payload.id), reason: r?.reason || 'unknown' });
            }
          }).catch((e) => log.warn('subscribe enrich fail', { id: payload.id, err: e.message }));
        }
        cb?.({ ok: true, room });
      } catch (e) { cb?.({ ok: false, error: e.message }); }
    });

    socket.on('unsubscribe', (payload, cb) => {
      try {
        const room = roomFromPayload(payload);
        if (!room) return cb?.({ ok: false, error: 'payload inválido' });
        socket.leave(room);
        m_room_unsub.inc(1, { kind: payload?.type || 'unknown' });
        cb?.({ ok: true, room });
      } catch (e) { cb?.({ ok: false, error: e.message }); }
    });

    socket.on('list', (cb) => {
      cb?.({ ok: true, matches: poller.getMatches(), poller: poller.snapshot() });
    });

    // Camada de intenção: cliente envia preferências (mercados, perfil, conf min)
    socket.on('prefs', (payload, cb) => {
      try {
        const next = {
          markets: Array.isArray(payload?.markets)
            ? payload.markets.filter((x) => typeof x === 'string').slice(0, 8)
            : [],
          profile: ['conservative','aggressive','balanced'].includes(payload?.profile)
            ? payload.profile : 'balanced',
          minConfidence: Math.max(0, Math.min(100, Number(payload?.minConfidence) || 0)),
        };
        socket.data.prefs = next;
        cb?.({ ok: true, prefs: next });
      } catch (e) { cb?.({ ok: false, error: e.message }); }
    });

    socket.on('disconnect', (reason) => {
      g_sockets.dec(1);
      m_socket_close.inc(1, { reason: String(reason || 'unknown') });
      log.debug?.('client disconnected', { id: socket.id, reason });
    });
  });

  /* ============================================================
     SUBSCRIBERS DO EVENT BUS → SOCKET.IO
     ============================================================ */
  function emitTo(room, eventName, payload) {
    ns.to(room).emit(eventName, payload);
    m_emit_total.inc(1, { event: eventName });
    w_emit.hit();
  }

  events.on('tick', (payload) => {
    if (!allow()) { m_emit_dropped.inc(1, { event: 'tick' }); return; }
    emitTo('lobby', 'tick', payload);
  });

  events.on('match:upsert', ({ match }) => {
    if (!allow()) { m_emit_dropped.inc(1, { event: 'match:upsert' }); return; }
    emitTo('lobby', 'match:upsert', { match });
    const fr = fixtureRoom(match); if (fr) emitTo(fr, 'match:upsert', { match });
    const lr = leagueRoom(match);  if (lr) emitTo(lr, 'match:upsert', { match });
  });

  events.on('match:update', ({ match, prev, deltas }) => {
    if (!allow()) { m_emit_dropped.inc(1, { event: 'match:update' }); return; }
    const payload = { match, prev: lite(prev), deltas };
    emitTo('lobby', 'match:update', payload);
    const fr = fixtureRoom(match); if (fr) emitTo(fr, 'match:update', payload);
    const lr = leagueRoom(match);  if (lr) emitTo(lr, 'match:update', payload);
  });

  events.on('match:remove', ({ matchId, match }) => {
    if (!allow()) return;
    const payload = { matchId, match: lite(match) };
    ns.to('lobby').emit('match:remove', payload);
    if (match) {
      const fr = fixtureRoom(match); if (fr) ns.to(fr).emit('match:remove', payload);
      const lr = leagueRoom(match);  if (lr) ns.to(lr).emit('match:remove', payload);
    }
  });

  // Eventos pontuais (gols, escanteios, cartões, pressão) — filtrados pelas prefs do socket
  ['fixture:goal','fixture:corner','fixture:card','fixture:pressure','fixture:btts-near']
    .forEach((evt) => {
      events.on(evt, (payload) => {
        const market = EVENT_MARKET_TAG[evt];
        const opts = { market };
        // Fixture/league room: enriquece com market p/ filtragem por socket
        emitFiltered(ns, 'lobby', evt, payload, opts);
        const fr = fixtureRoom(payload.match); if (fr) emitFiltered(ns, fr, evt, payload, opts);
        const lr = leagueRoom(payload.match);  if (lr) emitFiltered(ns, lr, evt, payload, opts);
        m_emit_total.inc(1, { event: evt });
        w_emit.hit();
      });
    });

  // Status / quota / breaker — eventos TÉCNICOS, restritos a admins.
  // Cliente comum não recebe — separa o CLIENT da camada ADMIN.
  function emitAdminOnly(event, payload) {
    const sockets = ns.adapter.rooms.get('lobby');
    if (!sockets) return;
    for (const sid of sockets) {
      const s = ns.sockets.get(sid);
      const role = String(s?.user?.role || '').toLowerCase();
      if (role === 'admin' || role === 'owner') s.emit(event, payload);
    }
  }
  events.on('quota',        (p) => emitAdminOnly('quota', p));
  events.on('quota:low',    (p) => emitAdminOnly('quota:low', p));
  events.on('circuit:open', (p) => emitAdminOnly('circuit:open', p));
  events.on('circuit:close',(p) => emitAdminOnly('circuit:close', p));
  events.on('poller:error', (p) => emitAdminOnly('poller:error', p));

  // Sinais automáticos (gerados pelo signalsEngine) — filtrados por prefs
  events.on('signal:fire', (signal) => {
    // signal.markets é array; usamos o principal (signal.market) p/ filtragem
    const opts = {
      market: signal.market,
      confidence: signal.confidence,
      profile: inferSignalProfile(signal),
    };
    emitFiltered(ns, 'lobby', 'signal:fire', signal, opts);
    const fr = `fixture:${signal.matchId}`;
    if (fr) emitFiltered(ns, fr, 'signal:fire', signal, opts);
    m_emit_total.inc(1, { event: 'signal:fire', market: signal.market || 'unknown' });
    w_emit.hit();
  });

  /* ============================================================
     BET SIGNALS — broadcast por TIER (PREMIUM imediato / FREE com delay)
     ------------------------------------------------------------
     Decisão de produto:
       - sinais com confidence >= PREMIUM_MIN (75) → tier 'premium'
       - sinais com confidence em [FREE_MIN, PREMIUM_MIN) → tier 'free'

     PREMIUM (users com role admin/premium ou plan VIP/PREMIUM):
       → recebe o sinal IMEDIATAMENTE em ambos os tiers
       → recebe `signal:best` (melhor aposta do momento)

     FREE (role user + plan FREE):
       → recebe sinais 'free' com FREE_DELAY_MS atraso (vantagem real do premium)
       → recebe sinais 'premium' COM DELAY (vê depois)
       → NUNCA recebe `signal:best`

     Os campos `premiumInsight` e `betScore` são REMOVIDOS para sockets FREE
     para que o cliente sinta a falta de "análise profunda" no plano grátis.
     ============================================================ */
  let betEngineCfg = { FREE_DELAY_MS: 8000, PREMIUM_MIN_CONFIDENCE: 75 };
  try { betEngineCfg = require('./betSignalEngine').config || betEngineCfg; } catch (_) {}

  function isPremiumSocket(sock) {
    const u = sock?.user;
    if (!u) return false;
    const role = String(u.role || '').toLowerCase();
    const plan = String(u.plan || '').toUpperCase();
    return role === 'admin' || role === 'owner' || role === 'premium'
        || plan === 'PREMIUM' || plan === 'VIP' || plan === 'PRO' || plan === 'TRIAL';
  }

  function stripForFree(signal) {
    // FREE recebe sinal mas SEM o "molho" premium (insight rico, score, breakdown)
    const out = { ...signal };
    delete out.premiumInsight;
    delete out.betScore;
    delete out.scoreBreakdown;
    delete out.extras; // sem detalhes de modelo
    out.justification = 'Acesse o plano Premium para ver a análise completa da IA.';
    out.locked = true;
    return out;
  }

  function emitTieredToSockets(room, evt, signal) {
    const sockets = ns.adapter.rooms.get(room);
    if (!sockets) return;
    const premiumPayload = signal;
    const freePayload = stripForFree(signal);
    const opts = {
      market: signal.market,
      confidence: signal.confidence,
      profile: signal.confidence >= 80 ? 'conservative'
             : signal.confidence >= 70 ? 'balanced'
             : 'aggressive',
    };

    for (const sid of sockets) {
      const s = ns.sockets.get(sid);
      if (!s) continue;
      if (!prefsAllow(s.data?.prefs, opts)) continue;
      const isPrem = isPremiumSocket(s);
      if (isPrem) {
        // Premium: imediato + payload completo
        s.emit(evt, premiumPayload);
      } else {
        // Free: payload reduzido + delay
        setTimeout(() => {
          try { s.connected && s.emit(evt, freePayload); } catch (_) {}
        }, betEngineCfg.FREE_DELAY_MS || 8000);
      }
    }
  }

  events.on('signal:new', (signal) => {
    emitTieredToSockets('lobby', 'signal:new', signal);
    const fr = `fixture:${signal.matchId}`;
    if (fr) emitTieredToSockets(fr, 'signal:new', signal);

    // Broadcast no root io para clients legacy (dashboard.js) — também tier-aware
    try {
      for (const [sid, s] of io.sockets.sockets) {
        if (!s) continue;
        const isPrem = isPremiumSocket(s);
        if (isPrem) {
          s.emit('signal:new', signal);
        } else {
          setTimeout(() => {
            try { s.connected && s.emit('signal:new', stripForFree(signal)); } catch (_) {}
          }, betEngineCfg.FREE_DELAY_MS || 8000);
        }
      }
    } catch (_) {}

    m_emit_total.inc(1, { event: 'signal:new', market: signal.market || 'unknown', tier: signal.tier });
    w_emit.hit();
  });

  /* ============================================================
     SIGNAL:BEST — melhor aposta do momento (PREMIUM only)
     ============================================================ */
  events.on('signal:best', (signal) => {
    if (!signal) return;
    const sockets = ns.adapter.rooms.get('lobby');
    if (sockets) {
      for (const sid of sockets) {
        const s = ns.sockets.get(sid);
        if (s && isPremiumSocket(s)) s.emit('signal:best', signal);
      }
    }
    // Root io legacy
    try {
      for (const [, s] of io.sockets.sockets) {
        if (s && isPremiumSocket(s)) s.emit('signal:best', signal);
      }
    } catch (_) {}
    m_emit_total.inc(1, { event: 'signal:best', tier: 'premium' });
  });

  /** Deduz o "perfil" do signal a partir do risco para casar com prefs.profile. */
  function inferSignalProfile(signal) {
    const lvl = String(signal.risk?.level || '').toUpperCase();
    if (lvl.startsWith('LOW') || lvl === 'BAIXO') return 'conservative';
    if (lvl === 'HIGH' || lvl === 'ALTO')          return 'aggressive';
    return 'balanced';
  }

  // Enrichment incremental (statistics + events + momentum + BTTS likelihood)
  events.on('match:enriched', ({ match, fixtureId, ts }) => {
    const payload = { match, fixtureId, ts };
    emitTo('lobby', 'match:enriched', payload);
    const fr = fixtureRoom(match) || `fixture:${fixtureId}`;
    if (fr) emitTo(fr, 'match:enriched', payload);
    const lr = leagueRoom(match);
    if (lr) emitTo(lr, 'match:enriched', payload);
  });
  events.on('match:enrich-fail', (payload) => {
    const fr = `fixture:${payload.fixtureId}`;
    if (fr) emitTo(fr, 'match:enrich-fail', payload);
  });

  log.info('football realtime ativo (namespace /football)');
  return ns;
}

function roomFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'fixture' && payload.id) return `fixture:${payload.id}`;
  if (payload.type === 'league'  && payload.id) return `league:${payload.id}`;
  if (payload.type === 'lobby')                 return 'lobby';
  return null;
}

// Envia versão "leve" do match para evitar repetir payloads enormes
function lite(m) {
  if (!m) return null;
  return {
    id: m.id, fixtureId: m.fixtureId,
    home: m.home, away: m.away,
    minute: m.minute, status: m.status,
    score: m.score,
  };
}

module.exports = { attachFootballRealtime };
