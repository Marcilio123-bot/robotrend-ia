/**
 * Robotrend IA — Fixture Enricher
 *
 * Faz o enrichment (statistics + events) de fixtures sob demanda.
 *
 * DESIGN — Subscription-driven para respeitar o free tier:
 *
 *   - NÃO enriquece todas as fixtures automaticamente. Free tier (95 req/dia)
 *     não suporta isso.
 *   - Enriquece somente fixtures com subscribers na room `fixture:<id>`
 *     (provido pelo footballRealtime).
 *   - Opcionalmente enriquece top N matches no boot (ENRICH_AUTO_TOP) para
 *     mostrar o painel "vivo" inicial.
 *   - `requestEnrich(id)` é chamado quando alguém abre uma fixture na UI.
 *     A primeira chamada bate na API; chamadas dentro do TTL do cacheStore
 *     são instantâneas (apiFootball já dedupa).
 *   - tick() periódico refaz enrichment APENAS para fixtures subscritas e
 *     somente se a última atualização tiver mais que ENRICH_REFRESH_MS.
 *   - Emite `match:enriched` no event bus → realtime broadcasta para a
 *     room + lobby, e a UI atualiza incremental.
 *
 * Custo por enrichment: 2 API calls (stats + events). Com cache de 30min
 * (AF_TTL_STATS=1800000) cada fixture custa ~2 calls a cada 30min mesmo
 * com 1000 spectators simultâneos (todos batem no mesmo cache).
 *
 * Métricas:
 *   - enricher_requests_total
 *   - enricher_skipped_total (cooldown / cache hit)
 *   - enricher_emitted_total
 *   - enricher_queue_size (gauge)
 *   - enricher_latency_ms
 */

'use strict';

const apiFootball = require('./apiFootball');
const events      = require('./footballEvents');
const metrics     = require('./metrics');
const { applyEnrichment, applyMinimalEnrichment } = require('./fixtureNormalizer');
const { logger }  = require('../logger');

const log = logger.child({ module: 'fixtureEnricher' });

const ENABLED            = String(process.env.ENRICH_ENABLED || 'true').toLowerCase() !== 'false';
const REFRESH_MS         = Number(process.env.ENRICH_REFRESH_MS || 30 * 60_000); // 30min default
const TICK_MS            = Number(process.env.ENRICH_TICK_MS || 30_000);          // checa pendências a cada 30s
const MAX_PER_TICK       = Number(process.env.ENRICH_MAX_PER_TICK || 2);
const AUTO_TOP           = Number(process.env.ENRICH_AUTO_TOP ?? 5);              // top-N no boot (default 5)
const POLLER_ENRICH_TOP  = Number(process.env.POLLER_ENRICH_TOP ?? 5);            // top-N a cada tick do poller
const INCLUDE_EVENTS     = String(process.env.ENRICH_INCLUDE_EVENTS || 'true').toLowerCase() !== 'false';

const m_req         = metrics.counter('enricher_requests_total');
const m_skip        = metrics.counter('enricher_skipped_total');
const m_emit        = metrics.counter('enricher_emitted_total');
const m_fail        = metrics.counter('enricher_failed_total');
const m_lat         = metrics.histogram('enricher_latency_ms');
const g_qsize       = metrics.gauge('enricher_queue_size');
const g_sub_fixt    = metrics.gauge('enricher_subscribed_fixtures');

class FixtureEnricher {
  constructor() {
    this.running = false;
    this.timer = null;
    this.lastEnrichedAt = new Map(); // fixtureId -> ts
    this.inflight = new Set();
    this.poller = null;              // injetado por enricher.setPoller()
    this.getSubscribers = null;      // injetado pelo realtime → ()=>Set<id>
    this.systemQueue = new Set();    // fixtures enfileiradas pelo poller (sem depender de socket subs)
    this._onTick = null;
    this.stats = { requests: 0, emitted: 0, failed: 0, skipped: 0, lastTickAt: 0, systemQueued: 0 };
  }

  /** Injeta o poller (precisamos do cache de matches para mesclar enrichment). */
  setPoller(poller) { this.poller = poller; }

  /** Injeta uma função que devolve a lista de fixtureIds subscritos. */
  setSubscriberSource(fn) { this.getSubscribers = fn; }

  start() {
    if (!ENABLED) { log.warn('enricher desabilitado (ENRICH_ENABLED=false)'); return; }
    if (this.running) return;
    this.running = true;
    log.info('enricher started', { refreshMs: REFRESH_MS, tickMs: TICK_MS, maxPerTick: MAX_PER_TICK, autoTop: AUTO_TOP });
    this.timer = setInterval(() => this.tick().catch((e) => log.warn('tick error', { err: e.message })), TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    // Poller → enfileira top-N a cada tick (pipeline SYSTEM, subs=0 ok)
    this._onTick = (payload) => {
      if (payload?.matches?.length) this.queueFromPoller(payload.matches);
    };
    events.on('tick', this._onTick);

    // Auto-enrich top N matches no primeiro tick (após o poller popular)
    if (AUTO_TOP > 0) {
      setTimeout(() => this.autoEnrichTopMatches().catch(() => {}), 5_000);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this._onTick) {
      events.off('tick', this._onTick);
      this._onTick = null;
    }
    this.running = false;
    log.info('enricher stopped');
  }

  snapshot() {
    return {
      enabled: ENABLED,
      running: this.running,
      refreshMs: REFRESH_MS,
      tickMs: TICK_MS,
      maxPerTick: MAX_PER_TICK,
      includeEvents: INCLUDE_EVENTS,
      lastTickAt: this.stats.lastTickAt,
      tracked: this.lastEnrichedAt.size,
      inflight: this.inflight.size,
      systemQueue: this.systemQueue.size,
      autoTop: AUTO_TOP,
      pollerEnrichTop: POLLER_ENRICH_TOP,
      stats: { ...this.stats },
    };
  }

  /**
   * Enfileira fixtures do poller para enrichment SYSTEM (não depende de socket subs).
   * Chamado automaticamente no evento `tick` do poller.
   *
   * Em SAFE-MODE: não enfileira (cada fixture custaria 2 calls de API).
   * O usuário ainda pode subscrever uma fixture específica e disparar
   * enrichment via socket — passa pelo requestEnrich que respeita o gate.
   */
  queueFromPoller(matches, limit = POLLER_ENRICH_TOP) {
    if (!ENABLED || !matches?.length || limit <= 0) return;
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      m_skip.inc(1, { reason: 'safe-mode' });
      return;
    }
    const top = matches
      .slice()
      .sort((a, b) => {
        const ga = (a.score?.home || 0) + (a.score?.away || 0);
        const gb = (b.score?.home || 0) + (b.score?.away || 0);
        if (gb !== ga) return gb - ga;
        return (b.minute || 0) - (a.minute || 0);
      })
      .slice(0, limit);
    let added = 0;
    for (const m of top) {
      const id = String(m.fixtureId || m.id);
      if (!id) continue;
      if (!this.systemQueue.has(id)) added++;
      this.systemQueue.add(id);
    }
    this.stats.systemQueued = this.systemQueue.size;
    // SEMPRE dispara tick se há fila (mesmo IDs repetidos — pode estar pendente de enrich)
    if (this.systemQueue.size > 0) {
      log.debug?.('poller queue enrich', { queue: this.systemQueue.size, newIds: added });
      this.tick().catch((e) => log.warn('poller-trigger tick fail', { err: e.message }));
    }
  }

  /**
   * Bootstrap síncrono: enrichment mínimo (apenas signals locais, ZERO API).
   * Em SAFE-MODE só faz a parte mínima e NÃO enfileira chamadas reais.
   */
  bootstrapTop(matches, limit = POLLER_ENRICH_TOP) {
    if (!ENABLED || !matches?.length || !this.poller) return;
    const safeMode = apiFootball.isSafeMode && apiFootball.isSafeMode();
    const top = matches
      .slice()
      .sort((a, b) => {
        const ga = (a.score?.home || 0) + (a.score?.away || 0);
        const gb = (b.score?.home || 0) + (b.score?.away || 0);
        if (gb !== ga) return gb - ga;
        return (b.minute || 0) - (a.minute || 0);
      })
      .slice(0, limit);

    for (const m of top) {
      const id = String(m.fixtureId || m.id);
      if (!id) continue;
      const cached = this.poller.getMatch(id) || m;
      if (!cached.enriched || !cached.signals?.length) {
        try {
          applyMinimalEnrichment(cached);
          this.poller.cache?.set?.(id, cached);
          this._emitEnriched(cached, id, true);
        } catch (e) {
          log.warn('bootstrap minimal fail', { id, err: e.message });
        }
      }
      if (!safeMode) this.systemQueue.add(id);
    }
    // API enrichment em background SÓ se não estiver em safe-mode
    if (!safeMode) {
      this.tick().catch((e) => log.warn('bootstrap tick fail', { err: e.message }));
    }
  }

  /** IDs elegíveis: socket subs + fila SYSTEM do poller. */
  _allTargetIds() {
    const subscribed = this.getSubscribers ? this.getSubscribers() : new Set();
    const out = new Set();
    for (const id of subscribed) out.add(String(id));
    for (const id of this.systemQueue) out.add(String(id));
    return out;
  }

  /**
   * Marca uma fixture como pendente de enrichment.
   * Devolve uma Promise que resolve quando o enrichment estiver feito (ou pulado por cooldown).
   */
  async requestEnrich(fixtureId, { force = false } = {}) {
    if (!ENABLED) return { ok: false, reason: 'disabled' };
    if (!fixtureId) return { ok: false, reason: 'no-id' };
    const id = String(fixtureId);
    this.stats.requests++;
    m_req.inc(1, { source: force ? 'force' : 'request' });

    const cached = this.poller?.getMatch?.(id);
    const needsFullApi = !cached?.enriched || cached?.enrichedPartial;
    if (!force && !needsFullApi) {
      const last = this.lastEnrichedAt.get(id) || 0;
      if (Date.now() - last < REFRESH_MS) {
        this.stats.skipped++;
        m_skip.inc(1, { reason: 'cooldown' });
        return { ok: true, skipped: true, reason: 'cooldown' };
      }
    }
    if (this.inflight.has(id)) {
      this.stats.skipped++;
      m_skip.inc(1, { reason: 'inflight' });
      return { ok: true, skipped: true, reason: 'inflight' };
    }
    // SAFE-MODE: faz apenas enrichment mínimo local. Sem isso o usuário
    // ainda vê algum sinal mesmo com quota próxima do limite.
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      this.stats.skipped++;
      m_skip.inc(1, { reason: 'safe-mode' });
      const match = this.poller?.getMatch?.(id);
      if (match && !match.enriched) {
        try {
          applyMinimalEnrichment(match);
          this._emitEnriched(match, id, true);
          return { ok: true, skipped: true, reason: 'safe-mode', partial: true };
        } catch (_) {}
      }
      return { ok: true, skipped: true, reason: 'safe-mode' };
    }
    return this._enrichOne(id);
  }

  /**
   * Tick: refaz enrichment para todas as fixtures subscritas (com cooldown).
   * Respeita MAX_PER_TICK para não estourar quota se muitas fixtures forem
   * abertas ao mesmo tempo.
   */
  async tick() {
    if (!this.running) return;
    this.stats.lastTickAt = Date.now();

    // SAFE-MODE: o tick periódico não dispara chamadas de API. Apenas
    // socket subscribers explícitos (via requestEnrich) podem rodar e mesmo
    // assim recebem só enrichment mínimo local.
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      m_skip.inc(1, { reason: 'safe-mode-tick' });
      g_qsize.set(0);
      return;
    }

    const allIds = this._allTargetIds();
    g_sub_fixt.set(allIds.size);

    const now = Date.now();
    const pending = [];
    for (const id of allIds) {
      if (this.inflight.has(String(id))) continue;
      const match = this.poller?.getMatch?.(id);
      const needsFull = !match?.enriched || match?.enrichedPartial;
      const last = this.lastEnrichedAt.get(String(id)) || 0;
      if (needsFull || now - last >= REFRESH_MS) {
        pending.push(String(id));
      }
    }
    g_qsize.set(pending.length);
    if (!pending.length) return;

    // Processa apenas MAX_PER_TICK por vez (evita pico de quota)
    const slice = pending.slice(0, MAX_PER_TICK);
    log.debug?.('enricher tick', { pending: pending.length, willEnrich: slice.length });
    for (const id of slice) {
      try { await this._enrichOne(id); }
      catch (e) { log.warn('enrich fail', { id, err: e.message }); }
    }
  }

  /** Enriquece top N matches do poller (mais ataques, mais minutos avançados). */
  async autoEnrichTopMatches() {
    if (!this.poller || !AUTO_TOP) return;
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      log.warn('autoEnrichTopMatches: safe-mode ativo, pulando');
      return;
    }
    const matches = this.poller.getMatches();
    if (!matches.length) return;
    const top = matches
      .slice()
      .sort((a, b) => {
        const ga = (a.score?.home || 0) + (a.score?.away || 0);
        const gb = (b.score?.home || 0) + (b.score?.away || 0);
        if (gb !== ga) return gb - ga;
        return (b.minute || 0) - (a.minute || 0);
      })
      .slice(0, AUTO_TOP);
    log.info('auto-enriching top matches', { count: top.length });
    for (const m of top) {
      const id = String(m.fixtureId || m.id);
      if (id) this.systemQueue.add(id);
      try { await this.requestEnrich(id); }
      catch (e) { log.warn('auto-enrich fail', { id, err: e.message }); }
    }
  }

  /* ============================================================
     INTERNAL — executa stats+events, mescla no match cacheado e emite
     ============================================================ */
  async _enrichOne(id) {
    this.inflight.add(id);
    const t0 = Date.now();
    try {
      const tasks = [apiFootball.getFixtureStatistics(id)];
      if (INCLUDE_EVENTS) tasks.push(apiFootball.getFixtureEvents(id));
      const [statsResp, eventsResp = []] = await Promise.all(tasks);

      // Garante que temos o match no cache do poller para mesclar
      let match = this.poller?.getMatch?.(id);
      if (!match) {
        m_skip.inc(1, { reason: 'no-match' });
        return { ok: false, reason: 'no-match-in-poller' };
      }

      applyEnrichment(match, statsResp, eventsResp);
      match.enrichedPartial = false;
      this._emitEnriched(match, id, false);
      return { ok: true, fixtureId: id };
    } catch (err) {
      // SAFE_MODE não é falha — é proteção de quota; downgrade silencioso
      const isSafeMode = err?.code === 'SAFE_MODE';
      if (!isSafeMode) {
        this.stats.failed++;
        m_fail.inc(1, { kind: err.code || 'unknown' });
        log.warn('enrichment failed', { id, err: err.message, status: err.status });
      } else {
        m_skip.inc(1, { reason: 'safe-mode' });
      }

      // FALLBACK OBRIGATÓRIO: enrichment mínimo local — nunca deixar UI em 0/42
      const match = this.poller?.getMatch?.(id);
      if (match && !match.enriched) {
        try {
          applyMinimalEnrichment(match);
          this._emitEnriched(match, id, true);
          if (!isSafeMode) log.info('minimal enrichment fallback', { id });
          return { ok: true, fixtureId: id, partial: true, safeMode: isSafeMode };
        } catch (fbErr) {
          log.warn('minimal fallback fail', { id, err: fbErr.message });
        }
      }

      // Em safe-mode, espera o cooldown completo antes de tentar de novo
      // (evita martelo enquanto a quota não reseta).
      const backoffMs = isSafeMode ? REFRESH_MS : Math.floor(REFRESH_MS * 2 / 3);
      this.lastEnrichedAt.set(String(id), Date.now() - (REFRESH_MS - backoffMs));
      events.emit('match:enrich-fail', {
        fixtureId: Number(id),
        error: err.message,
        safeMode: isSafeMode,
      });
      return { ok: false, error: err.message, safeMode: isSafeMode };
    } finally {
      this.inflight.delete(id);
    }
  }

  _emitEnriched(match, id, partial = false) {
    this.poller.cache?.set?.(String(id), match);
    // Partial NÃO marca cooldown — API full enrich deve rodar em seguida
    if (!partial) this.lastEnrichedAt.set(String(id), Date.now());
    if (partial) this.systemQueue.add(String(id));
    else this.systemQueue.delete(String(id));
    this.stats.emitted++;
    m_emit.inc(1, { partial: partial ? '1' : '0' });
    events.emit('match:enriched', {
      match,
      fixtureId: Number(id),
      ts: Date.now(),
      partial: !!partial,
    });
  }
}

let _singleton = null;
function getEnricher() {
  if (!_singleton) _singleton = new FixtureEnricher();
  return _singleton;
}

module.exports = { FixtureEnricher, getEnricher };
