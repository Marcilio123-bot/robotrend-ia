/**
 * Robotrend IA — Live Football Poller (worker)
 *
 * SINGLE OWNER de todas as chamadas live à API-Sports. Em vez de cada
 * usuário/módulo disparar polling, este worker faz UMA chamada por
 * intervalo e fan-out via EventBus para:
 *
 *   - socket.io (footballRealtime)
 *   - alertas Telegram (footballAlerts)
 *   - persistência (footballHistory)
 *   - métricas
 *
 * Benefícios:
 *   - 1 chamada por tick mesmo com 1000 usuários conectados
 *   - Quota da API protegida
 *   - Cache do apiFootball já trata burst de subscribers
 *
 * Pode rodar embarcado no servidor (default) ou em um processo
 * separado (`node backend/worker.js`) lendo de um Redis Pub/Sub.
 *
 * Eventos emitidos:
 *   tick, matches:update, match:upsert, match:update, match:remove,
 *   fixture:goal, fixture:corner, fixture:card, fixture:pressure,
 *   fixture:btts-near, poller:error
 */

'use strict';

const apiFootball = require('../services/footballProvider');
const history     = require('../services/footballHistory');
const events      = require('../services/footballEvents');
const metrics     = require('../services/metrics');
const { normalizeFixture } = require('../services/fixtureNormalizer');
const { logger }  = require('../logger');

const log = logger.child({ module: 'liveFootballPoller' });

const m_ticks       = metrics.counter('poller_ticks_total');
const m_ticks_fail  = metrics.counter('poller_ticks_failed_total');
const m_tick_lat    = metrics.histogram('poller_tick_duration_ms');
const m_events_pub  = metrics.counter('poller_events_published_total');
const m_heartbeats  = metrics.counter('poller_heartbeats_total');
const m_fallback    = metrics.counter('poller_fallback_total', 'Ticks que usaram último cache válido');
const g_tracked     = metrics.gauge('poller_tracked_matches');
const g_running     = metrics.gauge('poller_running', '1 quando ativo, 0 quando parado');
const g_alive       = metrics.gauge('poller_alive', '1 = heartbeat recente (<2× intervalo)');
const w_events      = metrics.window('poller_events_window', { windowMs: 60_000 });

/** Códigos de erro que sempre devem virar fallback silencioso (nunca derruba o loop). */
const SOFT_ERROR_CODES = new Set([
  'API_NOT_CONFIGURED',
  'API_URL_INVALID',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'SAFE_MODE',
  'CIRCUIT_OPEN',
]);

function classifyError(err) {
  const code = err?.code || '';
  const status = err?.status || err?.response?.status;
  const msg = String(err?.message || '');
  if (code && SOFT_ERROR_CODES.has(code)) return { soft: true, reason: code };
  if (status === 429 || status === 403 || status === 401) return { soft: true, reason: `http_${status}` };
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN|ECONN|timeout/i.test(msg)) return { soft: true, reason: 'network' };
  return { soft: false, reason: code || 'unknown' };
}

// Intervalo de poll. Providers gratuitos (thesportsdb/sofascore) → 15s.
// API-Sports (pago/quota) → 5 min. Override via FOOTBALL_POLL_INTERVAL_MS.
const PROVIDER_NAME = String(process.env.FOOTBALL_PROVIDER || '').toLowerCase();
const DEFAULT_INTERVAL_MS = PROVIDER_NAME === 'apisports' ? 300_000 : 15_000;
const INTERVAL_MS         = Number(process.env.FOOTBALL_POLL_INTERVAL_MS || DEFAULT_INTERVAL_MS);

// Filtro de ligas excluídas (amador, categoria de base, reservas, feminino).
// Comparação case-insensitive contra league.name e league.country.
const EXCLUDE_LEAGUE_TOKENS = (process.env.FOOTBALL_EXCLUDE_LEAGUES || 'Reserve,Women,U23,U21,U20,U19,U17,U16,Amateur,Kreisliga,2e Klasse,Bezirksliga,Youth')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PRIORITY_LEAGUE_TOKENS = (process.env.FOOTBALL_PRIORITY_LEAGUES || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PRIORITY_ONLY = String(process.env.LIVE_IMPORTANT_LEAGUES_ONLY || 'false').toLowerCase() === 'true';

/** Quantos ticks seguidos um jogo precisa faltar do feed antes de emitir match:remove. */
const REMOVE_MISS_TICKS = Math.max(1, Number(process.env.POLLER_REMOVE_MISS_TICKS || 2));

function isExcludedLeague(match) {
  const l = match?.league;
  if (!l) return false;
  const haystack = `${l.name || ''} ${l.country || ''}`.toLowerCase();
  return EXCLUDE_LEAGUE_TOKENS.some((tok) => haystack.includes(tok));
}

function isPriorityLeague(match) {
  if (!PRIORITY_LEAGUE_TOKENS.length) return true;
  const l = match?.league;
  if (!l) return false;
  const haystack = `${l.name || ''} ${l.country || ''}`.toLowerCase();
  return PRIORITY_LEAGUE_TOKENS.some((tok) => haystack.includes(tok));
}
const PRESSURE_DELTA      = Number(process.env.FOOTBALL_PRESSURE_DELTA || 12);
const BTTS_NEAR_MIN_PRESS = Number(process.env.FOOTBALL_BTTS_NEAR_MIN_PRESSURE || 65);

/**
 * Backoff em falhas transitórias (rede, 5xx, timeout):
 *   - começa em FAILURE_BACKOFF_MIN_MS (10s)
 *   - dobra a cada falha até FAILURE_BACKOFF_MAX_MS (60s)
 *   - volta a 0 (intervalo base) no primeiro sucesso
 *
 * Quota (429) e API não configurada usam o intervalo BASE — não adianta
 * reentrar rapidinho se o limite é diário ou a env não vai mudar.
 */
const FAILURE_BACKOFF_MIN_MS = Number(process.env.FOOTBALL_POLL_BACKOFF_MIN_MS || 10_000);
const FAILURE_BACKOFF_MAX_MS = Number(process.env.FOOTBALL_POLL_BACKOFF_MAX_MS || 60_000);
const HEARTBEAT_MIN_MS       = Number(process.env.FOOTBALL_POLL_HEARTBEAT_MIN_MS || 30_000);

// Clock local que roda independente da API. Mesmo em safe-mode/fallback,
// emite `tick` com matches re-simulados a cada FALLBACK_CLOCK_MS para que o
// frontend nunca veja minute congelado em 0' ou 120'.
const FALLBACK_CLOCK_MS = Number(process.env.FOOTBALL_FALLBACK_CLOCK_MS || 5_000);
const LIVE_CLOCK_ENABLED = String(process.env.LIVE_CLOCK_ENABLED ?? 'true').toLowerCase() !== 'false';
const FORCE_REALTIME = String(process.env.FOOTBALL_FORCE_REALTIME ?? 'true').toLowerCase() !== 'false';

// Status enum por categoria. LIVE_STATUSES = whitelist estrita de partidas
// que devem aparecer no painel ao vivo. Qualquer outra categoria (FT/AET/PEN
// / "Finished" / "Match Finished" / etc.) é DROP imediato — sem cache, sem
// fake clock, sem nada. Evita o bug de jogos congelados em 120'.
const LIVE_STATUSES = new Set([
  '1H', 'HT', '2H', 'ET', 'BT', 'LIVE', 'INT', 'P',
  'LIVE', 'INPROGRESS', 'IN-PROGRESS',
]);
const FT_STATUSES = new Set([
  'FT', 'AET', 'PEN', 'AWD', 'WO', 'ABD', 'CANC',
  'FINISHED', 'MATCH FINISHED', 'AFTER PENALTIES', 'AFTER EXTRA TIME',
  'CANCELLED', 'POSTPONED', 'PST', 'SUSP', 'SUSPENDED',
]);
const HT_STATUSES = new Set(['HT', 'HALFTIME', 'HALF TIME', 'INT']);

/** Normaliza string de status (case + trim) e retorna categoria. */
function statusGroup(m) {
  const sRaw = String(m?.status || '').toUpperCase().trim();
  const longRaw = String(m?.statusLong || '').toUpperCase().trim();
  if (FT_STATUSES.has(sRaw) || FT_STATUSES.has(longRaw)) return 'FT';
  if (HT_STATUSES.has(sRaw) || HT_STATUSES.has(longRaw)) return 'HT';
  if (LIVE_STATUSES.has(sRaw) || LIVE_STATUSES.has(longRaw)) return 'LIVE';
  // Status desconhecido — só consideramos LIVE se há minute > 0 e não passou de 90.
  const min = Number(m?.minute || 0);
  if (min > 0 && min < 120) return 'LIVE';
  return 'FT'; // default conservador: drop
}

/** True se o match está realmente em andamento (deve aparecer no painel live). */
function isLiveMatch(m) {
  const grp = statusGroup(m);
  if (grp === 'FT') return false;
  // Defesa final contra jogos travados: minute >= 120 com qualquer status = drop
  const min = Number(m?.minute || 0);
  if (min >= 120) return false;
  return true;
}

/**
 * Fake Momentum Engine — random walk leve com bias por contexto.
 * Roda no clock local quando a API não enviou stats novas; mantém a UI
 * "viva" (pressureIndex variando) durante períodos sem atualização real.
 * Idempotente: se a API enviar enrichment novo, os valores são sobrescritos
 * pelo enricher normalmente.
 */
function applyFakeMomentumDrift(m) {
  if (!m) return;
  if (!m.momentum) m.momentum = { home: 50, away: 50, pressureIndex: 30 };
  const grp = statusGroup(m);
  if (grp !== 'LIVE') return; // sem drift quando HT/FT

  const min = Number(m.minute || 0);
  const sh  = Number(m.score?.home || 0);
  const sa  = Number(m.score?.away || 0);

  // 1) pressureIndex: random walk + bias por fase do jogo
  let p = Number(m.momentum.pressureIndex || 30) + (Math.random() - 0.5) * 4;
  if (min >= 60) p += 0.4;       // urgência no segundo tempo
  if (min >= 80) p += 0.4;       // pressão final
  m.momentum.pressureIndex = Math.max(0, Math.min(100, Math.round(p)));

  // 2) home/away momentum: drift com bias por placar (time perdendo pressiona)
  let home = Number(m.momentum.home || 50) + (Math.random() - 0.5) * 3;
  if (sh < sa) home += 0.6;
  else if (sa < sh) home -= 0.6;
  home = Math.max(20, Math.min(80, home));
  m.momentum.home = Math.round(home);
  m.momentum.away = 100 - m.momentum.home;
}

class LiveFootballPoller {
  constructor(opts = {}) {
    this.intervalMs = Number(opts.intervalMs || INTERVAL_MS);
    this.timer = null;
    this.heartbeatTimer = null;
    this.localClockTimer = null;
    this.running = false;
    this.ticking = false;
    this.lastTickAt = 0;
    this.lastSuccessAt = 0;
    this.lastHeartbeatAt = 0;
    this.lastError = null;
    this.lastFallbackReason = null;
    this.consecutiveFailures = 0;
    this.nextDelayMs = this.intervalMs;
    this.cache = new Map();
    /** id → ticks consecutivos ausentes do feed (antes de match:remove). */
    this._missCounts = new Map();
    this.lastRawSnapshot = [];
    this.stats = {
      ticks: 0,
      ticksSuccess: 0,
      ticksFailed: 0,
      ticksFallback: 0,
      heartbeats: 0,
      lastDurationMs: 0,
      lastSize: 0,
      backoffsApplied: 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    g_running.set(1);
    g_alive.set(1);
    this.lastHeartbeatAt = Date.now();
    log.info('poller started', { intervalMs: this.intervalMs, fallbackClockMs: FALLBACK_CLOCK_MS, backoffMin: FAILURE_BACKOFF_MIN_MS, backoffMax: FAILURE_BACKOFF_MAX_MS });
    this._scheduleHeartbeat();
    this._scheduleLocalClock();
    setTimeout(() => this._scheduleNext(500), 0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.localClockTimer) clearInterval(this.localClockTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    this.localClockTimer = null;
    this.running = false;
    g_running.set(0);
    g_alive.set(0);
    log.info('poller stopped');
  }

  /**
   * Self-scheduling loop: nunca usa setInterval, sempre re-agenda em `finally`,
   * de forma que NENHUM erro consegue parar o loop. Delay é dinâmico (backoff).
   */
  _scheduleNext(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Number(delayMs) || this.nextDelayMs || this.intervalMs);
    this.nextDelayMs = wait;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((e) => {
          // Defesa final — tick() já nunca deve throw, mas se acontecer
          // logamos sem derrubar o agendamento.
          log.error('tick threw despite guard', { err: e?.message, code: e?.code });
          this._recordFailure(e?.code || 'tick_threw');
        })
        .finally(() => this._scheduleNext(this._computeNextDelay()));
    }, wait);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Heartbeat independente do tick — atualiza "alive" mesmo durante falhas longas. */
  _scheduleHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const period = Math.max(5_000, Math.min(HEARTBEAT_MIN_MS, Math.floor(this.intervalMs / 2)));
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      this._heartbeat('keepalive');
    }, period);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  /**
   * Clock LOCAL — roda independente da API a cada FALLBACK_CLOCK_MS.
   * Mesmo em safe-mode/fallback com a API morta, garante que o frontend
   * receba `tick` periódico com matches simulados (minute progride,
   * pressureIndex faz drift). Sem isso, o painel congela no último estado.
   */
  _scheduleLocalClock() {
    if (!LIVE_CLOCK_ENABLED && !FORCE_REALTIME) {
      log.info('local clock desabilitado (LIVE_CLOCK_ENABLED=false)');
      return;
    }
    if (this.localClockTimer) clearInterval(this.localClockTimer);
    this.localClockTimer = setInterval(() => {
      if (!this.running) return;
      try { this.fallbackRealtimeClock(); }
      catch (e) { log.warn('fallbackRealtimeClock falhou', { err: e?.message }); }
    }, FALLBACK_CLOCK_MS);
    if (typeof this.localClockTimer.unref === 'function') this.localClockTimer.unref();
  }

  /**
   * Atualiza os matches em cache aplicando:
   *   - Progressão de minute (cresce ~1 por 60s desde a base do servidor)
   *   - Cap: LIVE max 90, HT trava em 45, FT trava em 90
   *   - Fake momentum (pressureIndex random walk com bias)
   * Emite `tick` para SSE/Socket.io com generatedAt atual.
   *
   * Idempotente: API real continua sendo a fonte primária. Sempre que `tick()`
   * recebe dados frescos, ele faz rebase de `_simBaseMinute`/`_simBaseAt`.
   */
  fallbackRealtimeClock() {
    if (this.cache.size === 0) return;
    const now = Date.now();
    const toRemove = [];

    for (const [id, m] of this.cache) {
      if (m._simBaseAt == null) {
        m._simBaseMinute = Number(m.minute || 0);
        m._simBaseAt = now;
      }

      const grp = statusGroup(m);

      if (grp === 'FT') {
        // Defense-in-depth: o filtro do tick() já tira FT, mas se algum
        // escapar para o cache (race condition), removemos aqui também.
        toRemove.push(id);
        continue;
      }

      if (grp === 'HT') {
        if (m.minute !== 45) m.minute = 45;
        m.flags = m.flags || {};
        m.flags.isLive = true;
        continue;
      }

      // LIVE — progressão por tempo decorrido desde o último rebase do servidor
      const ageMs = now - m._simBaseAt;
      const localBump = Math.floor(ageMs / 60_000);
      // Cap em 90 para nunca exibir 91+/120 enquanto o status seguir LIVE
      m.minute = Math.min(90, Number(m._simBaseMinute || 0) + localBump);
      m.flags = m.flags || {};
      m.flags.isLive = true;

      // Fake momentum drift (mantém pressure dinâmica entre polls)
      applyFakeMomentumDrift(m);
    }

    // Remove FT matches que escaparam para o cache + emite match:remove
    for (const id of toRemove) {
      const removed = this.cache.get(id);
      this.cache.delete(id);
      try { events.emit('match:remove', { matchId: id, match: removed }); } catch (_) {}
    }

    // Emite tick sempre para o frontend receber generatedAt fresco e
    // manter o indicador "Última atualização" correto. Em fallback, esse
    // é o ÚNICO sinal de vida do pipeline para o cliente.
    const payload = {
      matches: this.getMatches(),
      generatedAt: new Date().toISOString(),
      durationMs: 0,
      source: this.lastFallbackReason ? 'local-clock-fallback' : 'local-clock',
      fromClock: true,
      fallbackReason: this.lastFallbackReason,
    };
    try { events.emit('tick', payload); } catch (_) {}
    this._heartbeat('local-clock');
  }

  /**
   * Calcula próximo delay com base no estado atual:
   *   - sucesso recente / sem falhas → intervalo base
   *   - falha leve (rede / 5xx / timeout) → backoff exponencial (10s → 60s)
   *   - quota / API não configurada → intervalo base (não adianta retry rápido)
   */
  _computeNextDelay() {
    const reason = this.lastFallbackReason || this.lastError;
    if (!this.consecutiveFailures) return this.intervalMs;

    // Quota e config não devem virar retry rápido (custo / inutilidade)
    if (
      reason === 'api_not_configured' ||
      reason === 'http_429' ||
      reason === 'http_403' ||
      reason === 'http_401' ||
      reason === 'SAFE_MODE'
    ) {
      return this.intervalMs;
    }

    const exp = Math.min(this.consecutiveFailures - 1, 8); // teto p/ não overflow
    const backoff = Math.min(
      FAILURE_BACKOFF_MAX_MS,
      FAILURE_BACKOFF_MIN_MS * Math.pow(2, exp)
    );
    // Em produção o intervalo base pode ser muito maior que o backoff
    // (ex.: 5min). Nesse caso usamos o backoff (mais rápido) para se recuperar.
    return Math.min(this.intervalMs, backoff);
  }

  _recordFailure(reason) {
    this.consecutiveFailures++;
    this.lastError = reason || 'unknown';
    this.stats.ticksFailed++;
    this.stats.backoffsApplied++;
    try { events.emit('poller:error', { err: reason, code: reason, consecutive: this.consecutiveFailures }); } catch (_) {}
  }

  _recordSuccess() {
    if (this.consecutiveFailures) {
      log.info('poller recuperado — voltando ao intervalo base', {
        afterFailures: this.consecutiveFailures,
      });
    }
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSuccessAt = Date.now();
    this.stats.ticksSuccess++;
  }

  /** healthy / degraded / starting / stopped — para dashboards. */
  health() {
    if (!this.running) return 'stopped';
    if (!this.lastTickAt) return 'starting';
    if (this.consecutiveFailures > 0 || this.lastFallbackReason) return 'degraded';
    return 'healthy';
  }

  snapshot() {
    const since = this.lastHeartbeatAt ? Date.now() - this.lastHeartbeatAt : null;
    const alive = since != null && since <= Math.max(this.intervalMs, HEARTBEAT_MIN_MS) * 2;
    g_alive.set(alive ? 1 : 0);
    return {
      running: this.running,
      alive,
      health: this.health(),
      intervalMs: this.intervalMs,
      nextDelayMs: this.nextDelayMs,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      msSinceHeartbeat: since,
      lastError: this.lastError,
      lastFallbackReason: this.lastFallbackReason,
      consecutiveFailures: this.consecutiveFailures,
      stats: { ...this.stats },
      tracked: this.cache.size,
    };
  }

  /** Heartbeat barato: marca o poller "vivo" mesmo sem dados novos. */
  _heartbeat(reason) {
    this.lastHeartbeatAt = Date.now();
    this.stats.heartbeats++;
    m_heartbeats.inc(1, reason ? { reason } : undefined);
    g_alive.set(1);
    try { events.emit('poller:heartbeat', { at: this.lastHeartbeatAt, reason }); } catch (_) {}
  }

  /**
   * Wrapper sem-throw: sempre devolve um Array. Em qualquer erro de rede,
   * quota ou config, cai para o último snapshot válido (ou []).
   */
  async _safeFetchLiveFixtures() {
    try {
      const raw = await apiFootball.getLiveFixtures();
      if (Array.isArray(raw)) return raw;
      log.warn('getLiveFixtures devolveu não-array — usando fallback', { type: typeof raw });
      return this._fallbackSnapshot('non_array_response');
    } catch (err) {
      const { soft, reason } = classifyError(err);
      const level = soft ? 'warn' : 'error';
      log[level]('getLiveFixtures falhou — usando fallback', {
        err: err?.message,
        code: err?.code,
        reason,
      });
      try { events.emit('poller:error', { err: err?.message, code: err?.code, reason, soft }); } catch (_) {}
      return this._fallbackSnapshot(reason);
    }
  }

  _fallbackSnapshot(reason) {
    this.lastFallbackReason = reason;
    this.stats.ticksFallback++;
    m_fallback.inc(1, { reason });
    if (this.lastRawSnapshot && this.lastRawSnapshot.length) {
      const cloned = this.lastRawSnapshot.slice();
      Object.defineProperty(cloned, '__stale', { value: true, enumerable: false });
      Object.defineProperty(cloned, '__fallbackReason', { value: reason, enumerable: false });
      return cloned;
    }
    const empty = [];
    Object.defineProperty(empty, '__stale', { value: true, enumerable: false });
    Object.defineProperty(empty, '__fallbackReason', { value: reason, enumerable: false });
    return empty;
  }

  /**
   * Snapshot atual das partidas (sem custo de API — usa cache do poller).
   */
  getMatches() {
    return Array.from(this.cache.values());
  }

  getMatch(id) {
    return this.cache.get(String(id)) || null;
  }

  async tick() {
    if (this.ticking) {
      this._heartbeat('overlap-skip');
      return;
    }
    this.ticking = true;
    const t0 = Date.now();

    let raw = [];
    try {
      if (!apiFootball.hasAnyConfiguredProvider?.() && !apiFootball.isConfigured?.()) {
        // Não derruba o poller; mantém vivo com heartbeat e cache anterior.
        this.lastFallbackReason = 'no_provider_configured';
        raw = this._fallbackSnapshot('no_provider_configured');
        if (this.stats.ticks === 0 && this.stats.ticksFallback <= 1) {
          log.warn('poller em modo passivo — nenhum provider na FOOTBALL_PROVIDER_PRIORITY (heartbeat ativo)');
        }
      } else {
        raw = await this._safeFetchLiveFixtures();
      }
    } catch (e) {
      // _safeFetchLiveFixtures já é à prova de throw, mas defesa adicional aqui.
      raw = this._fallbackSnapshot('safe_fetch_threw');
      log.error('safe fetch lançou exceção inesperada', { err: e?.message });
    }

    try {
      const beforeFilter = (Array.isArray(raw) ? raw : [])
        .map((fx) => {
          try { return normalizeFixture(fx); }
          catch (_) { return null; }
        })
        .filter(Boolean);

      const noBlacklist = beforeFilter.filter((m) => !isExcludedLeague(m));
      const priorityFiltered = PRIORITY_ONLY
        ? noBlacklist.filter((m) => isPriorityLeague(m))
        : noBlacklist;
      // FILTRO ESTRITO DE STATUS: só matches realmente ao vivo passam.
      // FT/AET/PEN/Finished/etc. são descartados — não entram no cache.
      const matches = priorityFiltered.filter((m) => isLiveMatch(m));

      // Marca origem + qualidade dos dados (free vs full) em cada match.
      // 'partial' = provider só dá placar/minuto/status (TheSportsDB livescore);
      // 'full'    = provider entrega stats avançadas (API-Sports paga).
      const providerName = apiFootball.providerName || (apiFootball.status?.()?.provider) || 'unknown';
      const isPartialProvider = providerName === 'thesportsdb' || providerName === 'sofascore';
      for (const mm of matches) {
        mm.provider = providerName;
        mm.dataQuality = mm.dataQuality || (isPartialProvider ? 'partial' : 'full');
        if (mm.flags) mm.flags.source = providerName;
      }
      if (beforeFilter.length !== matches.length) {
        log.debug?.('poller aplicou filtros', {
          before: beforeFilter.length,
          afterBlacklist: noBlacklist.length,
          afterPriority: priorityFiltered.length,
          afterLiveStatus: matches.length,
          priorityOnly: PRIORITY_ONLY,
        });
      }
      // Log estruturado por match LIVE (verbose=true para debug)
      if (process.env.FOOTBALL_LIVE_VERBOSE === 'true') {
        for (const m of matches) {
          console.log(`[LIVE MATCH] ${m.id} ${m.minute || 0}' ${m.home} vs ${m.away} [${m.status}]`);
        }
      }

      // Rebase do clock simulado para esta tick (só quando dados são FRESH).
      // Em fallback (fromStale), preservamos a base anterior para não "voltar
      // no tempo" toda vez que a API estiver morta.
      const rebaseClock = !raw.__stale;
      if (rebaseClock) {
        const now = Date.now();
        for (const m of matches) {
          m._simBaseMinute = Number(m.minute || 0);
          m._simBaseAt = now;
        }
      }

      this.stats.lastSize = matches.length;
      this.stats.ticks++;
      this.lastTickAt = Date.now();
      this._heartbeat('tick');
      g_tracked.set(matches.length);

      const fromStale = !!raw.__stale;
      const fallbackReason = raw.__fallbackReason || null;

      if (fromStale) {
        m_ticks.inc(1, { source: 'fallback' });
        this._recordFailure(fallbackReason || 'fallback');
      } else {
        m_ticks.inc(1, { source: 'live' });
        this._recordSuccess();
        // Cache cru do último sucesso — usado como fallback nos próximos ticks
        if (raw.length) this.lastRawSnapshot = raw.slice();
      }

      const seen = new Set();

      // Detecta upsert / update / events
      for (const m of matches) {
        const id = String(m.id);
        seen.add(id);
        const prev = this.cache.get(id);

        // CRÍTICO: preserva enrichment anterior. O endpoint live não devolve
        // statistics — se regenerássemos o match do zero, perderíamos toda a
        // pressão/corners/cards/etc. acumulados pelo enricher. O enricher
        // refaz isso na sua cadência (default 30min).
        if (prev?.enriched && !m.enriched) {
          m.stats        = prev.stats;
          m.perMinute    = prev.perMinute;
          m.momentum     = prev.momentum;
          m.bttsLikelihood = prev.bttsLikelihood;
          m.events       = prev.events || [];
          m.enriched     = true;
          m.enrichedAt   = prev.enrichedAt;
          m.enrichedPartial = prev.enrichedPartial;
          m.insight      = prev.insight;
          m.signals      = prev.signals;
        } else if (!m.enriched && prev) {
          // Preserva partial enrichment entre ticks skeleton
          if (prev.enrichedPartial) {
            m.stats = prev.stats;
            m.perMinute = prev.perMinute;
            m.momentum = prev.momentum;
            m.bttsLikelihood = prev.bttsLikelihood;
            m.events = prev.events || [];
            m.enriched = true;
            m.enrichedPartial = true;
            m.enrichedAt = prev.enrichedAt;
            m.insight = prev.insight;
            m.signals = prev.signals;
          }
          // Preserva fake momentum aplicado pelo fallbackRealtimeClock
          // (mesmo sem enrichment real, queremos pressure dinâmica entre polls).
          if (!m.momentum && prev.momentum) m.momentum = prev.momentum;
        }

        // Persistência (não bloqueia loop)
        history.recordSnapshot(m, { prev }).catch(() => {});

        if (!prev) {
          this.cache.set(id, m);
          events.emit('match:upsert', { match: m });
          continue;
        }

        const deltas = computeDeltas(prev, m);
        this.cache.set(id, m);

        if (deltas.changed) {
          events.emit('match:update', { match: m, prev, deltas });

          // Eventos específicos para alertas/UI
          if (deltas.goalHome > 0) {
            events.emit('fixture:goal', { match: m, side: 'home', delta: deltas.goalHome });
            history.recordEvent({ matchId: m.fixtureId, kind: 'goal', side: 'home', minute: m.minute }).catch(() => {});
          }
          if (deltas.goalAway > 0) {
            events.emit('fixture:goal', { match: m, side: 'away', delta: deltas.goalAway });
            history.recordEvent({ matchId: m.fixtureId, kind: 'goal', side: 'away', minute: m.minute }).catch(() => {});
          }
          if (deltas.cornersTotal > 0) {
            const side = deltas.cornersHome > 0 ? 'home' : deltas.cornersAway > 0 ? 'away' : 'unknown';
            events.emit('fixture:corner', { match: m, side, delta: deltas.cornersTotal });
            history.recordEvent({ matchId: m.fixtureId, kind: 'corner', side, minute: m.minute }).catch(() => {});
          }
          if (deltas.yellowTotal > 0) {
            events.emit('fixture:card', { match: m, color: 'yellow', delta: deltas.yellowTotal });
            history.recordEvent({ matchId: m.fixtureId, kind: 'card-yellow', minute: m.minute }).catch(() => {});
          }
          if (deltas.redTotal > 0) {
            events.emit('fixture:card', { match: m, color: 'red', delta: deltas.redTotal });
            history.recordEvent({ matchId: m.fixtureId, kind: 'card-red', minute: m.minute }).catch(() => {});
          }
          if (deltas.pressureDelta >= PRESSURE_DELTA) {
            events.emit('fixture:pressure', {
              match: m,
              pressure: m.perMinute?.pressureIndex,
              delta: deltas.pressureDelta,
            });
          }
          // BTTS iminente: 1 time já marcou + pressão alta do outro
          if (isBttsNear(m, prev)) {
            events.emit('fixture:btts-near', { match: m, reason: 'pressão alta com 1×0' });
          }
        }
      }

      // Remoção de matches que sumiram (jogo encerrou ou saiu de live).
      // Exige REMOVE_MISS_TICKS ausências consecutivas — evita flicker quando
      // o provider (TheSportsDB/SofaScore) oscila entre ticks após restart.
      for (const id of seen) this._missCounts.delete(id);
      for (const id of [...this.cache.keys()]) {
        if (seen.has(id)) continue;
        const misses = (this._missCounts.get(id) || 0) + 1;
        this._missCounts.set(id, misses);
        if (misses < REMOVE_MISS_TICKS) {
          log.debug?.('poller remove adiado', { id, misses, need: REMOVE_MISS_TICKS });
          continue;
        }
        const removed = this.cache.get(id);
        this.cache.delete(id);
        this._missCounts.delete(id);
        console.log(`[LIVE FILTER] match:remove ${removed?.home || '?'} x ${removed?.away || '?'} (ausente ${misses} ticks)`);
        events.emit('match:remove', { matchId: id, match: removed });
      }

      this.stats.lastDurationMs = Date.now() - t0;
      try {
        m_tick_lat.observe(this.stats.lastDurationMs, { source: fromStale ? 'fallback' : 'live' });
      } catch (_) {}
      const payload = {
        matches,
        generatedAt: new Date().toISOString(),
        durationMs: this.stats.lastDurationMs,
        source: fromStale ? 'fallback-cache' : 'live',
        fromStale,
        fallbackReason,
      };
      try { events.emit('tick', payload); } catch (_) {}
      try { events.emit('matches:update', payload); } catch (_) {}

      try {
        const { getEnricher } = require('../services/fixtureEnricher');
        getEnricher().bootstrapTop(matches);
      } catch (_) { /* enricher opcional */ }

      m_events_pub.inc(2, { kind: 'tick' });
      w_events.hit(2);
    } catch (err) {
      // Erros no PROCESSAMENTO do snapshot (não na rede) — não derruba o loop.
      const msg = err?.message || String(err);
      m_ticks_fail.inc();
      log.error('tick processing error (não-fatal)', { err: msg, code: err?.code });
      this._recordFailure(err?.code || 'process_error');
      this._heartbeat('process-error');
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Força um refresh imediato (usado por endpoints REST que precisam de dados fresquinhos).
   * Não acumula ticks: se já tem um rodando, devolve o snapshot atual.
   */
  async forceRefresh() {
    if (!this.ticking) await this.tick();
    return this.getMatches();
  }
}

/* ============================================================
   HELPERS
   ============================================================ */
function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

function computeDeltas(prev, cur) {
  const out = {
    changed: false,
    goalHome: 0, goalAway: 0,
    cornersHome: 0, cornersAway: 0, cornersTotal: 0,
    yellowTotal: 0, redTotal: 0,
    pressureDelta: 0,
  };
  out.goalHome     = Math.max(0, n(cur.score?.home) - n(prev.score?.home));
  out.goalAway     = Math.max(0, n(cur.score?.away) - n(prev.score?.away));
  out.cornersHome  = Math.max(0, n(cur.stats?.corners?.home) - n(prev.stats?.corners?.home));
  out.cornersAway  = Math.max(0, n(cur.stats?.corners?.away) - n(prev.stats?.corners?.away));
  out.cornersTotal = out.cornersHome + out.cornersAway;
  out.yellowTotal  = Math.max(0, n(cur.stats?.cards?.yellow?.total) - n(prev.stats?.cards?.yellow?.total));
  out.redTotal     = Math.max(0, n(cur.stats?.cards?.red?.total)    - n(prev.stats?.cards?.red?.total));
  out.pressureDelta = n(cur.perMinute?.pressureIndex) - n(prev.perMinute?.pressureIndex);

  out.changed = !!(
    out.goalHome || out.goalAway ||
    out.cornersTotal ||
    out.yellowTotal || out.redTotal ||
    cur.minute !== prev.minute
  );
  return out;
}

function isBttsNear(cur, prev) {
  const sh = n(cur.score?.home), sa = n(cur.score?.away);
  const min = n(cur.minute);
  if (min < 30) return false;
  if (sh > 0 && sa > 0) return false; // BTTS já aconteceu
  if (sh === 0 && sa === 0) return false; // ninguém marcou
  const losingSidePressure = sh > sa
    ? n(cur.stats?.shotsOnTarget?.away) * 8 + n(cur.stats?.dangerousAttacks?.away) * 0.4
    : n(cur.stats?.shotsOnTarget?.home) * 8 + n(cur.stats?.dangerousAttacks?.home) * 0.4;
  return losingSidePressure >= BTTS_NEAR_MIN_PRESS;
}

/* ============================================================
   SINGLETON
   ============================================================ */
let _singleton = null;
function getPoller() {
  if (!_singleton) _singleton = new LiveFootballPoller();
  return _singleton;
}

module.exports = { LiveFootballPoller, getPoller };
