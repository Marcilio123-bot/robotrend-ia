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

const apiFootball = require('./footballProvider');
const events      = require('./footballEvents');
const metrics     = require('./metrics');
const { applyEnrichment, applyMinimalEnrichment } = require('./fixtureNormalizer');
const { logger }  = require('../logger');

const log = logger.child({ module: 'fixtureEnricher' });

const ENABLED            = String(process.env.ENRICH_ENABLED || 'true').toLowerCase() !== 'false';
const REFRESH_MS         = Number(process.env.ENRICH_REFRESH_MS || 30 * 60_000); // 30min default (jogos fora da janela ativa)
// ============================================================
// REFRESH AO VIVO (Problema 1 — sinais atrasados).
// Para jogos ao vivo dentro da janela de sinais, as estatísticas (escanteios,
// chutes no gol, cartões, posse) precisam estar FRESCAS — senão os sinais são
// calculados sobre dados de até 30min atrás e chegam DEPOIS do evento.
// LIVE_REFRESH_MS (default 2min) reduz drasticamente essa defasagem.
// ⚠️ CUSTO DE QUOTA: cada refresh = 2 calls (stats+events). N jogos a cada
// LIVE_REFRESH_MS. Em plano free/limitado, suba o valor (ex.: 300000=5min) ou
// reduza ENRICH_QUEUE_MAX. Em safe-mode o enricher pausa automaticamente.
// ============================================================
const LIVE_REFRESH_MS    = Number(process.env.ENRICH_LIVE_REFRESH_MS || 120_000);          // 2min p/ jogos ao vivo
const LIVE_REFRESH_MIN_MINUTE = Number(process.env.ENRICH_LIVE_REFRESH_MIN_MINUTE || 1);
const LIVE_REFRESH_MAX_MINUTE = Number(process.env.ENRICH_LIVE_REFRESH_MAX_MINUTE || 88);
const TICK_MS            = Number(process.env.ENRICH_TICK_MS || 15_000);         // checa pendências a cada 15s
const MAX_PER_TICK       = Number(process.env.ENRICH_MAX_PER_TICK || 8);
const AUTO_TOP           = Number(process.env.ENRICH_AUTO_TOP ?? 12);            // top-N no boot
// 0 = enfileira TODOS os jogos live (até ENRICH_QUEUE_MAX)
const POLLER_ENRICH_TOP  = Number(process.env.POLLER_ENRICH_TOP ?? 0);
const ENRICH_QUEUE_MAX   = Number(process.env.ENRICH_QUEUE_MAX || 40);
const INCLUDE_EVENTS     = String(process.env.ENRICH_INCLUDE_EVENTS || 'true').toLowerCase() !== 'false';
// Diagnóstico cru de stats live. Ligue com LIVE_STATS_DEBUG=true para imprimir
// a resposta BRUTA de /fixtures/statistics + o objeto final mesclado em
// match.stats. Útil para responder A) API já devolve zeros vs B) Robotrend zera.
const LIVE_STATS_DEBUG   = String(process.env.LIVE_STATS_DEBUG || 'false').toLowerCase() === 'true';

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
    this.stats = {
      requests: 0,
      emitted: 0,
      failed: 0,
      skipped: 0,
      lastTickAt: 0,
      systemQueued: 0,
      // Diagnóstico /fixtures/statistics
      statsCalls: 0,           // total de tentativas (enabled+disabled)
      statsCalls200: 0,        // respostas com array preenchido
      statsCallsEmpty: 0,      // 200 mas array vazio (API sem stats p/ esse fixture)
      statsCallsFailed: 0,     // erros não-safe-mode
      statsCallsSafeMode: 0,
      lastStatsCallAt: 0,
    };
  }

  /** Injeta o poller (precisamos do cache de matches para mesclar enrichment). */
  setPoller(poller) { this.poller = poller; }

  /**
   * [SAFE MODE] — imprime o estado de quota que decide entre applyEnrichment
   * (real) e applyMinimalEnrichment (zeros). Se active=true, NENHUMA chamada
   * /fixtures/statistics é feita → todas as partidas saem zeradas.
   */
  _logSafeMode(where = '') {
    try {
      const snap = apiFootball.safeMode ? apiFootball.safeMode() : null;
      const active = snap ? snap.active : (apiFootball.isSafeMode?.() || false);
      const remainingRatio = snap?.ratio ?? (apiFootball.remainingRatio?.() ?? null);
      const dailyRemaining = snap?.quota?.dailyRemaining ?? null;
      const dailyLimit = snap?.quota?.dailyLimit ?? null;
      console.log('[SAFE MODE]', {
        where,
        active,
        remainingRatio,
        dailyRemaining,
        dailyLimit,
        bucketUsed: snap?.bucket?.dayUsed ?? null,
        bucketLimit: snap?.bucket?.dayLimit ?? null,
        threshold: snap?.threshold ?? null,
      });
    } catch (_) { /* nunca quebrar por log */ }
  }

  /**
   * Intervalo de refresh aplicável a UMA fixture.
   * Jogos ao vivo dentro da janela ativa usam LIVE_REFRESH_MS (rápido, p/ que
   * os sinais sejam preditivos); o resto usa REFRESH_MS (lento, economiza quota).
   */
  _refreshMsFor(match) {
    if (!match) return REFRESH_MS;
    const min = Number(match.minute || 0);
    const isLive = match.flags?.isLive || (match.status && !match.flags?.isFinished);
    if (isLive && min >= LIVE_REFRESH_MIN_MINUTE && min <= LIVE_REFRESH_MAX_MINUTE) {
      return LIVE_REFRESH_MS;
    }
    return REFRESH_MS;
  }

  /** Injeta uma função que devolve a lista de fixtureIds subscritos. */
  setSubscriberSource(fn) { this.getSubscribers = fn; }

  start() {
    if (!ENABLED) {
      log.warn('enricher desabilitado (ENRICH_ENABLED=false)');
      console.log('[STATS FETCH] DISABLED — ENRICH_ENABLED=false. /fixtures/statistics NÃO será chamado pelo pipeline automático. Sinais de corners dependem do baseline em betSignalEngine.');
      return;
    }
    if (this.running) return;
    this.running = true;
    log.info('enricher started', { refreshMs: REFRESH_MS, liveRefreshMs: LIVE_REFRESH_MS, tickMs: TICK_MS, maxPerTick: MAX_PER_TICK, autoTop: AUTO_TOP });
    console.log(`[STATS FETCH] ENABLED — enricher started, top=${AUTO_TOP} pollerTop=${POLLER_ENRICH_TOP} refresh=${REFRESH_MS}ms liveRefresh=${LIVE_REFRESH_MS}ms tick=${TICK_MS}ms`);
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
      liveRefreshMs: LIVE_REFRESH_MS,
      tickMs: TICK_MS,
      maxPerTick: MAX_PER_TICK,
      includeEvents: INCLUDE_EVENTS,
      lastTickAt: this.stats.lastTickAt,
      tracked: this.lastEnrichedAt.size,
      inflight: this.inflight.size,
      systemQueue: this.systemQueue.size,
      autoTop: AUTO_TOP,
      pollerEnrichTop: POLLER_ENRICH_TOP,
      enrichQueueMax: ENRICH_QUEUE_MAX,
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
  _sortedLiveMatches(matches) {
    return matches.slice().sort((a, b) => {
      const ga = (a.score?.home || 0) + (a.score?.away || 0);
      const gb = (b.score?.home || 0) + (b.score?.away || 0);
      if (gb !== ga) return gb - ga;
      return (b.minute || 0) - (a.minute || 0);
    });
  }

  /** limit<=0 → todos os jogos live (cap ENRICH_QUEUE_MAX). */
  _selectForQueue(matches, limit = POLLER_ENRICH_TOP) {
    const sorted = this._sortedLiveMatches(matches);
    if (!limit || limit <= 0) return sorted.slice(0, ENRICH_QUEUE_MAX);
    return sorted.slice(0, limit);
  }

  queueFromPoller(matches, limit = POLLER_ENRICH_TOP) {
    // [PIPELINE TRACE] — TEMPORÁRIO. Remover após diagnóstico (grep "[PIPELINE TRACE]").
    const TRACE = String(process.env.PIPELINE_TRACE ?? 'true').toLowerCase() !== 'false';
    if (!ENABLED || !matches?.length) {
      if (TRACE) console.log(`[PIPELINE TRACE] enricher.queueFromPoller SKIP | enabled=${ENABLED} received=${matches?.length || 0} (sem jogos ou enricher desabilitado)`);
      return;
    }
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      m_skip.inc(1, { reason: 'safe-mode' });
      if (TRACE) console.warn(`[PIPELINE TRACE] enricher.queueFromPoller SKIP safe-mode | received=${matches.length} — NENHUMA chamada /fixtures/statistics será feita (Enricher=0).`);
      return;
    }
    const top = this._selectForQueue(matches, limit);
    let added = 0;
    for (const m of top) {
      const id = String(m.fixtureId || m.id);
      if (!id) continue;
      if (!this.systemQueue.has(id)) added++;
      this.systemQueue.add(id);
    }
    this.stats.systemQueued = this.systemQueue.size;
    if (TRACE) {
      console.log(
        `[PIPELINE TRACE] enricher.queueFromPoller | received=${matches.length} ` +
        `selected=${top.length} newlyQueued=${added} queueSize=${this.systemQueue.size} ` +
        `inflight=${this.inflight.size} pollerEnrichTop=${POLLER_ENRICH_TOP}`
      );
    }
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
  /**
   * Enfileira jogos para enrichment REAL (/fixtures/statistics).
   * Não aplica mais applyMinimalEnrichment aqui — zeros marcados como
   * enriched bloqueavam o dashboard e a IA.
   */
  bootstrapTop(matches, limit = POLLER_ENRICH_TOP) {
    const TRACE = String(process.env.PIPELINE_TRACE ?? 'true').toLowerCase() !== 'false';
    if (!ENABLED || !matches?.length) {
      if (TRACE) console.log(`[PIPELINE TRACE] enricher.bootstrapTop SKIP | enabled=${ENABLED} received=${matches?.length || 0}`);
      return;
    }
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      this._logSafeMode('enricher.bootstrapTop');
      if (TRACE) console.warn(`[PIPELINE TRACE] enricher.bootstrapTop SKIP safe-mode | received=${matches.length} — Enricher permanece 0.`);
      return;
    }
    const top = this._selectForQueue(matches, limit);
    for (const m of top) {
      const id = String(m.fixtureId || m.id);
      if (id) this.systemQueue.add(id);
    }
    if (this.systemQueue.size > 0) {
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
      if (Date.now() - last < this._refreshMsFor(cached)) {
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
      this._logSafeMode('enricher.requestEnrich');
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
    // [PIPELINE TRACE] — TEMPORÁRIO. Remover após diagnóstico (grep "[PIPELINE TRACE]").
    const TRACE = String(process.env.PIPELINE_TRACE ?? 'true').toLowerCase() !== 'false';
    if (!this.running) {
      if (TRACE) console.log('[PIPELINE TRACE] enricher.tick SKIP | running=false (enricher não iniciado)');
      return;
    }
    this.stats.lastTickAt = Date.now();

    // Estado de quota a CADA tick — decide enrichment real vs zeros.
    this._logSafeMode('enricher.tick');

    // SAFE-MODE: o tick periódico não dispara chamadas de API. Apenas
    // socket subscribers explícitos (via requestEnrich) podem rodar e mesmo
    // assim recebem só enrichment mínimo local.
    if (apiFootball.isSafeMode && apiFootball.isSafeMode()) {
      m_skip.inc(1, { reason: 'safe-mode-tick' });
      g_qsize.set(0);
      if (TRACE) console.warn(`[PIPELINE TRACE] enricher.tick SKIP safe-mode | queue=${this.systemQueue.size} — 0 chamadas de stats neste tick.`);
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
      const refreshMs = this._refreshMsFor(match);
      if (needsFull || now - last >= refreshMs) {
        pending.push(String(id));
      }
    }
    g_qsize.set(pending.length);
    if (!pending.length) {
      if (TRACE) console.log(`[PIPELINE TRACE] enricher.tick | targets=${allIds.size} pending=0 (nada a enriquecer — todos em cooldown/já enriquecidos)`);
      return;
    }

    // Processa apenas MAX_PER_TICK por vez (evita pico de quota)
    const slice = pending.slice(0, MAX_PER_TICK);
    if (TRACE) {
      console.log(
        `[PIPELINE TRACE] enricher.tick DISPATCH | targets=${allIds.size} pending=${pending.length} ` +
        `willEnrich=${slice.length} (maxPerTick=${MAX_PER_TICK}) → vai chamar /fixtures/statistics ` +
        `para fixtureIds=${slice.join(',')}`
      );
    }
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
    if (!apiFootball.isConfigured()) {
      m_skip.inc(1, { reason: 'api-not-configured' });
      return { ok: false, reason: 'api-not-configured' };
    }
    // [ENRICH CLEANUP] Valida que a fixture ainda existe no cache do poller
    // ANTES de gastar chamadas de API. Jogos encerrados/purgados devolvem
    // getMatch=null; sem este guard, getFixtureStatistics + getFixtureEvents
    // seriam chamados (2 calls) só para descobrir o no-match logo depois.
    // Remove também da systemQueue + lastEnrichedAt para não reentrar como
    // pending a cada tick (o enricher não escuta match:remove).
    const sid = String(id);
    if (!this.poller?.getMatch?.(sid)) {
      this.systemQueue.delete(sid);
      this.lastEnrichedAt.delete(sid);
      this.inflight.delete(sid);
      m_skip.inc(1, { reason: 'no-match' });
      console.log(`[ENRICH CLEANUP] fixtureId=${id} removed reason=no-match`);
      return { ok: false, reason: 'no-match-in-poller' };
    }
    this.inflight.add(id);
    const t0 = Date.now();
    // [ENRICH REQUEST] — chegamos ao ponto que efetivamente chama
    // /fixtures/statistics. Se este log NÃO aparece para um fixture, o
    // enrichment real foi barrado ANTES (ver gates de safe-mode/cooldown).
    console.log('[ENRICH REQUEST]', id);
    try {
      const tasks = [apiFootball.getFixtureStatistics(id)];
      if (INCLUDE_EVENTS) tasks.push(apiFootball.getFixtureEvents(id));
      this.stats.statsCalls++;
      this.stats.lastStatsCallAt = Date.now();
      const [statsResp, eventsResp = []] = await Promise.all(tasks);
      if (Array.isArray(statsResp) && statsResp.length) this.stats.statsCalls200++;
      else this.stats.statsCallsEmpty++;

      // [RAW STATS DATA] — resposta BRUTA de /fixtures/statistics, ANTES de
      // qualquer normalização. Se aqui já vier [] ou valores zerados, a causa
      // é a API (cenário A). Se vier preenchido mas o FINAL STATS sair zerado,
      // a causa é o processamento do Robotrend (cenário B).
      if (LIVE_STATS_DEBUG) {
        console.log('RAW STATS DATA', id, JSON.stringify(statsResp));
      }

      // [STATS FETCH] — resposta da API antes de mesclar no match.
      // Confirma 1) que /fixtures/statistics foi chamado, 2) que veio 200
      // com array, 3) os números reais por time. Se vier [], a API não
      // está fornecendo estatísticas para esse fixture (pode ser jogo de
      // liga obscura, ou stats ainda não geradas no início do jogo).
      try {
        const isArr = Array.isArray(statsResp);
        const teams = isArr ? statsResp.map((t) => ({
          teamId: t?.team?.id,
          teamName: t?.team?.name,
          corners: (t?.statistics || []).find((s) => s?.type === 'Corner Kicks')?.value ?? null,
          shots: (t?.statistics || []).find((s) => s?.type === 'Total Shots')?.value ?? null,
          shotsOnTarget: (t?.statistics || []).find((s) => s?.type === 'Shots on Goal')?.value ?? null,
          dangerousAttacks: (t?.statistics || []).find((s) => s?.type === 'Dangerous Attacks')?.value ?? null,
        })) : [];
        const home = teams[0] || {};
        const away = teams[1] || {};
        console.log(
          `[STATS FETCH] fixtureId=${id} status=${isArr ? 200 : 'non-array'} teams=${teams.length} ` +
          `homeCorners=${home.corners} awayCorners=${away.corners} ` +
          `shots=${(home.shots ?? 0) + (away.shots ?? 0)} ` +
          `shotsOnTarget=${(home.shotsOnTarget ?? 0) + (away.shotsOnTarget ?? 0)} ` +
          `dur=${Date.now() - t0}ms events=${Array.isArray(eventsResp) ? eventsResp.length : 0}`
        );
        // Sample BRUTO do response — primeiro fixture de cada tick (controlado por _firstSampleTs).
        // Imprime types disponíveis + valores brutos. Útil pra detectar:
        // (a) array vazio = plano não cobre stats live para essa liga
        // (b) types diferentes = schema do provider mudou
        // (c) values null/string = parsing precisa ajustar
        const now = Date.now();
        if (!this._lastSampleAt || now - this._lastSampleAt > 60_000) {
          this._lastSampleAt = now;
          if (isArr && statsResp.length) {
            const sample0 = statsResp[0];
            const types = (sample0?.statistics || []).map((s) => s?.type);
            console.log(
              `[STATS FETCH SAMPLE] fixtureId=${id} ` +
              `team0=${sample0?.team?.name}#${sample0?.team?.id} ` +
              `typesAvailable=${JSON.stringify(types)} ` +
              `rawTeam0=${JSON.stringify(sample0).slice(0, 800)}`
            );
          } else {
            console.log(
              `[STATS FETCH SAMPLE] fixtureId=${id} EMPTY response — provider não retornou stats. ` +
              `Possíveis causas: (a) plano API-Football não inclui stats live nesta liga; ` +
              `(b) jogo recém-iniciado, stats ainda não disponíveis; ` +
              `(c) liga sem cobertura de live stats. Resp bruto: ${JSON.stringify(statsResp).slice(0, 200)}`
            );
          }
        }
      } catch (_) { /* log defensivo — nunca quebrar enrichment */ }

      // Garante que temos o match no cache do poller para mesclar.
      // Race: a fixture pode ter sido purgada (jogo encerrado) entre o guard
      // inicial e o retorno da API. Limpa fila + cooldown para não reentrar.
      let match = this.poller?.getMatch?.(id);
      if (!match) {
        this.systemQueue.delete(String(id));
        this.lastEnrichedAt.delete(String(id));
        m_skip.inc(1, { reason: 'no-match' });
        console.log(`[ENRICH CLEANUP] fixtureId=${id} removed reason=no-match`);
        return { ok: false, reason: 'no-match-in-poller' };
      }

      applyEnrichment(match, statsResp, eventsResp);
      match.enrichedPartial = false;

      // [FINAL STATS] — objeto final mesclado em match.stats, exatamente como
      // será servido por /api/football/live. Comparar com RAW STATS DATA acima
      // isola onde os números somem: se RAW tinha corners>0 mas FINAL=0, o bug
      // está em applyEnrichment/statName (teamId ou type não bateu).
      if (LIVE_STATS_DEBUG) {
        console.log('FINAL STATS', id, JSON.stringify(match.stats));
      }

      // [STAT TRACE 2/6] enricher — após o normalizer já ter mesclado em
      // match.stats. Confirma que o objeto enriquecido em cache reflete os
      // mesmos números do response cru.
      try {
        const statTrace = require('./statTrace');
        statTrace.trace('enricher', id, {
          stats: match.stats,
          extra: { enrichedAt: match.enrichedAt, enrichedPartial: false },
        });
      } catch (_) { /* defensivo */ }

      // [ENRICH SUCCESS] — applyEnrichment (FULL) rodou e mesclou stats reais.
      console.log('[ENRICH SUCCESS]', id);
      this._emitEnriched(match, id, false);
      return { ok: true, fixtureId: id };
    } catch (err) {
      // SAFE_MODE não é falha — é proteção de quota; downgrade silencioso
      const isSafeMode = err?.code === 'SAFE_MODE';
      // [ENRICH FAILED] — caímos no fallback applyMinimalEnrichment (zeros).
      console.log('[ENRICH FAILED]', id, err?.code || err?.message || String(err));
      if (!isSafeMode) {
        this.stats.failed++;
        this.stats.statsCallsFailed++;
        m_fail.inc(1, { kind: err.code || 'unknown' });
        log.warn('enrichment failed', { id, err: err.message, status: err.status });
        console.log(`[STATS FETCH] fixtureId=${id} status=ERROR code=${err.code || 'unknown'} message=${err.message}`);
      } else {
        m_skip.inc(1, { reason: 'safe-mode' });
        this.stats.statsCallsSafeMode++;
        console.log(`[STATS FETCH] fixtureId=${id} status=SAFE_MODE (quota baixa, fallback minimal)`);
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

/**
 * Bootstrap LOCAL (zero API) para o feed de sinais ao vivo.
 * Quando ENRICH_ENABLED=false o enricher automático não roda; sem stats o
 * betSignalEngine descarta 100% dos jogos. Esta função aplica
 * applyMinimalEnrichment nos top-N jogos live para destravar o pipeline
 * sem alterar regras de aposta (dados reais de placar/minuto).
 */
const BET_FEED_BOOTSTRAP_TOP = Number(process.env.BET_SIGNAL_BOOTSTRAP_TOP || 10);

function sortMatchesForBootstrap(matches) {
  return matches.slice().sort((a, b) => {
    const ga = (a.score?.home || 0) + (a.score?.away || 0);
    const gb = (b.score?.home || 0) + (b.score?.away || 0);
    if (gb !== ga) return gb - ga;
    return (b.minute || 0) - (a.minute || 0);
  });
}

function bootstrapMinimalForBetFeed(poller, matches, limit = BET_FEED_BOOTSTRAP_TOP) {
  if (!poller || !matches?.length || limit <= 0) return { applied: 0, candidates: 0 };
  const top = sortMatchesForBootstrap(matches).slice(0, limit);
  let applied = 0;
  for (const m of top) {
    const id = String(m.fixtureId || m.id);
    if (!id) continue;
    const cached = poller.getMatch?.(id) || poller.cache?.get?.(id) || m;
    // Não sobrescreve enrichment completo da API (stats reais).
    if (cached.enriched && cached.stats && !cached.enrichedPartial) continue;
    try {
      applyMinimalEnrichment(cached);
      poller.cache?.set?.(id, cached);
      applied++;
    } catch (e) {
      log.warn('bet-feed minimal bootstrap fail', { id, err: e.message });
    }
  }
  return { applied, candidates: top.length };
}

let _singleton = null;
function getEnricher() {
  if (!_singleton) _singleton = new FixtureEnricher();
  return _singleton;
}

module.exports = { FixtureEnricher, getEnricher, bootstrapMinimalForBetFeed };
