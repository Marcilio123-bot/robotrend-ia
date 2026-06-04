/**
 * Robotrend IA — Orquestrador v4 Production
 *
 *  - Throttle de emits para Socket.io (evita flood em painéis abertos)
 *  - TTL cleanup do Map sentRecently (fix memory leak)
 *  - Cleanup periódico do histórico de partidas finalizadas
 *  - Aplica camada ML (reinforce) antes de decidir
 *  - Autotune do SIGNAL_MIN_SCORE com base em winrate
 */

'use strict';

const db = require('./database');
const ml = require('./ml');
const { createLiveScanner } = require('./live');
const { sendSignal } = require('./telegram');
const { logger } = require('./logger');
const metrics = require('./metrics');
const freshness = require('./freshness');
const footballEvents = require('./services/footballEvents');

const SCAN_INTERVAL = Number(process.env.LIVE_SCAN_INTERVAL_MS || 15000);
const BASE_MIN_SCORE = Number(process.env.SIGNAL_MIN_SCORE || 80);
const SENT_TTL_MS = 30 * 60 * 1000; // limpa entradas com >30 min

const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

// [MATCH DEBUG] gate — logs estruturados por estágio do pipeline.
// Quando habilitado (default), o bot imprime um payload com beforeFilter,
// afterFilter, provider, ids, statuses e reasons em cada gate. Usado para
// diagnosticar "provider → N matches" virando "0 rendered".
const MATCH_DEBUG_ENABLED = String(process.env.MATCH_DEBUG || 'true').toLowerCase() !== 'false';

class RobotrendBot {
  constructor(io) {
    this.io = io;
    this.live = createLiveScanner();
    this.sentRecently = new Map(); // matchId -> timestamp
    this.lastMatches = [];
    this.lastAnalyses = [];
    this.minScore = BASE_MIN_SCORE;
    this.timer = null;
    this.cleanupTimer = null;
    this.log = logger.child({ module: 'bot' });

    // Toggles globais (sobrescrevíveis via .env)
    this.liveEnabled    = String(process.env.LIVE_ENABLED    || 'true').toLowerCase() !== 'false';

    // Atualiza o dashboard assim que o enricher traz /fixtures/statistics
    // (sem esperar o próximo tick de 15s do scanner).
    this._onMatchEnriched = ({ match }) => {
      if (!this.liveEnabled || !match || !this.io) return;
      const legacy = this.live.mapNormalizedMatch(match);
      const id = String(legacy.id);
      const idx = this.lastMatches.findIndex((m) => String(m.id) === id);
      if (idx < 0) return;
      this.lastMatches[idx] = legacy;
      this.io.emit('matches:update', [legacy]);
    };
    footballEvents.on('match:enriched', this._onMatchEnriched);
  }

  start() {
    this.log.info('scanner started', { interval: SCAN_INTERVAL, minScore: this.minScore,
      liveEnabled: this.liveEnabled });
    if (this.liveEnabled) {
      console.log('[LIVE DEBUG] bot live scanner started (runOnce interval)', { intervalMs: SCAN_INTERVAL });
      this.runOnce().catch((e) => this.log.error('tick error', { err: e.message }));
    } else {
      this.log.warn('[live] scanner iniciado em modo PAUSADO (LIVE_ENABLED=false)');
      console.log('[LIVE DEBUG] bot live scanner PAUSED — LIVE_ENABLED=false');
    }
    this.timer = setInterval(
      () => this.runOnce().catch((e) => this.log.error('tick error', { err: e.message })),
      SCAN_INTERVAL
    );
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this._onMatchEnriched) {
      footballEvents.off('match:enriched', this._onMatchEnriched);
    }
  }

  /* ============================================================
     TOGGLES GLOBAIS
     ============================================================ */
  setLiveEnabled(value) {
    const next = !!value;
    if (this.liveEnabled === next) return { changed: false, liveEnabled: next };
    this.liveEnabled = next;
    if (next) {
      this.log.info('[live] scanner retomado');
      // Dispara um tick imediato (sem esperar o próximo intervalo)
      this.runOnce().catch((e) => this.log.error('resume tick error', { err: e.message }));
    } else {
      this.log.warn('[live] scanner pausado');
      // Limpa cache de partidas exibidas para "congelar" o front
      this.lastMatches = [];
      this.lastAnalyses = [];
      this.io.emit('matches:update', []);
      this.io.emit('analyses:update', []);
    }
    this.io.emit('system:status', this.systemStatus());
    return { changed: true, liveEnabled: next };
  }

  systemStatus() {
    return {
      liveEnabled: this.liveEnabled,
      minScore: this.minScore,
      monitored: this.lastMatches.length,
    };
  }

  cleanup() {
    const now = Date.now();
    let purged = 0;
    for (const [k, ts] of this.sentRecently) {
      if (now - ts > SENT_TTL_MS) { this.sentRecently.delete(k); purged++; }
    }
    // Cleanup do histórico em scanners que oferecem .history
    if (this.live.history?.forEach) {
      const liveIds = new Set(this.lastMatches.map((m) => m.id));
      for (const k of this.live.history.keys()) {
        if (!liveIds.has(k)) this.live.history.delete(k);
      }
    }
    if (purged) this.log.debug('janitor', { purged });
  }

  async runOnce() {
    if (!this.liveEnabled) {
      // Scanner pausado — limpa lista para não exibir jogos antigos
      this.lastMatches = [];
      this.lastAnalyses = [];
      this.io.emit('matches:update', []);
      this.io.emit('analyses:update', []);
      return;
    }

    // [MATCH REFRESH] sempre zera o estado anterior antes do tick.
    // Garante que nenhum jogo de ciclo anterior sobrevive.
    this.lastMatches = [];
    this.lastAnalyses = [];
    console.log('[MATCH REFRESH] cache reset - nova busca executada');

    const stats = await db.getStats();
    this.minScore = ml.autoTuneMinScore(BASE_MIN_SCORE, stats);

    const results = await this.live.tick();

    // Última camada de defesa: re-aplica freshness STRICT (ou normal) por match.
    // Conta e loga quantos foram descartados aqui (após scanner).
    const checkFn = STRICT_REAL_ONLY ? freshness.checkMatchStrict : freshness.checkMatch;
    const checkFnName = STRICT_REAL_ONLY ? 'checkMatchStrict' : 'checkMatch';
    let droppedAtBot = 0;
    const enriched = [];
    const checkFnDrops = [];
    for (const { match, analysis } of results) {
      const fresh = checkFn(match);
      if (!fresh.ok) {
        droppedAtBot++;
        checkFnDrops.push({
          id: match?.id != null ? String(match.id) : null,
          provider: match?.provider || match?.source || null,
          status: match?.status || null,
          minute: match?.minute ?? null,
          kickoffAt: match?.kickoffAt || match?.date || null,
          reason: fresh.reason,
        });
        this.log.debug('match descartado no bot', { id: match?.id, reason: fresh.reason });
        continue;
      }
      const history = this.live.history?.get?.(match.id) || [];
      const ml2 = ml.reinforce(analysis, { match, history });
      if (analysis.stale) {
        ml2.shouldSignal = false;
        ml2.stale = true;
        ml2.staleReason = analysis.staleReason;
      } else {
        ml2.shouldSignal = ml2.shouldSignal && ml2.confidence >= this.minScore && !ml2.ml.antiFake.fake;
      }
      ml2.kickoffAt = match.kickoffAt || match.date;
      ml2.status = match.status;
      ml2.isLive = match.isLive;
      enriched.push({ match, analysis: ml2 });
    }
    if (droppedAtBot > 0) {
      console.log(`[LIVE FILTER] ${droppedAtBot} jogos removidos por não serem reais (${checkFnName})`);
    }

    // Resolve provider ativo só pra debug log (não causa side-effects).
    let activeProvider = 'unknown';
    try { activeProvider = require('./services/footballProvider').providerName || 'unknown'; } catch (_) {}

    // [MATCH DEBUG] stage 3 — gate checkFn pós-scanner
    if (MATCH_DEBUG_ENABLED) {
      console.log('[MATCH DEBUG]', {
        stage: 'bot.runOnce:checkFn',
        beforeFilter: results.length,
        afterFilter: enriched.length,
        provider: activeProvider,
        strict: STRICT_REAL_ONLY,
        checkFn: checkFnName,
        ids: enriched.slice(0, 8).map(({ match }) => String(match.id)),
        statuses: enriched.slice(0, 8).map(({ match }) => ({
          id: String(match.id), status: match.status, minute: match.minute, provider: match.provider,
        })),
        reasons: checkFnDrops.slice(0, 8),
      });
    }

    // Última camada de defesa pré-emit: refiltra com checkFn (paranoia).
    const preEmitDrops = [];
    const safe = enriched.filter(({ match }) => {
      const r = checkFn(match);
      if (!r.ok) {
        preEmitDrops.push({
          id: match?.id != null ? String(match.id) : null,
          provider: match?.provider || match?.source || null,
          status: match?.status || null,
          reason: r.reason,
        });
      }
      return r.ok;
    });
    const droppedPreEmit = enriched.length - safe.length;
    if (droppedPreEmit > 0) {
      console.log(`[LIVE FILTER] ${droppedPreEmit} jogos removidos por não serem reais (pre-emit)`);
    }

    // [MATCH DEBUG] stage 4 — pre-emit (re-check final antes de socket.io)
    if (MATCH_DEBUG_ENABLED && (enriched.length || safe.length)) {
      console.log('[MATCH DEBUG]', {
        stage: 'bot.runOnce:pre-emit',
        beforeFilter: enriched.length,
        afterFilter: safe.length,
        provider: activeProvider,
        ids: safe.slice(0, 8).map(({ match }) => String(match.id)),
        statuses: safe.slice(0, 8).map(({ match }) => ({ id: String(match.id), status: match.status, minute: match.minute })),
        reasons: preEmitDrops.slice(0, 8),
      });
    }

    this.lastMatches = safe.map((r) => r.match);
    this.lastAnalyses = safe.map((r) => r.analysis);
    db.bumpMonitored(safe.length);

    // Snapshot completo do pipeline desta tick (consumido por
    // /api/admin/match-debug). NÃO incluir payloads enormes — só ids/contagens.
    this._lastDebugSnapshot = {
      ts: Date.now(),
      provider: activeProvider,
      strict: STRICT_REAL_ONLY,
      checkFn: checkFnName,
      scannerIn: results.length,
      afterCheckFn: enriched.length,
      afterPreEmit: safe.length,
      finalEmitted: safe.length,
      drops: {
        checkFn: checkFnDrops.slice(0, 16),
        preEmit: preEmitDrops.slice(0, 16),
      },
      emitted: safe.slice(0, 16).map(({ match }) => ({
        id: String(match.id),
        provider: match.provider,
        status: match.status,
        minute: match.minute,
      })),
    };

    console.log(`[MATCH ENGINE] only real-time API data rendered (${safe.length} matches)`);

    this.io.emit('matches:update', this.lastMatches);
    this.io.emit('analyses:update', this.lastAnalyses);

    for (const { match, analysis } of safe) {
      if (!analysis.shouldSignal) continue;

      // FAKE-MATCH GUARD — defesa SEMPRE ativa (não depende de STRICT).
      // IDs `demo-*` (ou qualquer prefixo sintético) e matches sem origem
      // real (source !== 'api-football') NUNCA devem gerar signal Telegram.
      // Cinto de segurança: provider sintético foi removido do sistema, mas
      // mantemos o guard para barrar qualquer regressão futura.
      const isDemoId = String(match.id || '').startsWith('demo-');
      const knownRealSource = match.source === 'api-football'
        || match.provider === 'api-football'
        || match.provider === 'apisports'
        || match.isFromLiveAPI === true;
      if (isDemoId || !knownRealSource) {
        console.log(`[SIGNAL BLOCK] ${match.home} x ${match.away} bloqueado: fonte sintética/desconhecida (id=${match.id}, source=${match.source || match.provider || 'unknown'})`);
        this.log.warn('signal blocked: fake-match guard', {
          match: `${match.home} x ${match.away}`,
          id: match.id,
          source: match.source || match.provider,
        });
        continue;
      }

      // SIGNAL SOURCE GUARD — última camada antes de emitir/persistir/enviar.
      // STRICT: bloqueia QUALQUER signal de origem não-API live confirmada.
      if (STRICT_REAL_ONLY) {
        const src = freshness.checkSignalSource(match);
        if (!src.ok) {
          console.log(`[SIGNAL BLOCK] ${match.home} x ${match.away} bloqueado: ${src.reason}`);
          this.log.warn('signal blocked: source guard', {
            match: `${match.home} x ${match.away}`,
            reason: src.reason,
          });
          continue;
        }
      }
      const lastSent = this.sentRecently.get(match.id) || 0;
      if (Date.now() - lastSent < 5 * 60 * 1000) continue;
      this.sentRecently.set(match.id, Date.now());

      const saved = await db.saveSignal(analysis, null);
      const tg = await sendSignal(analysis);
      this.io.emit('signal:new', { ...saved, telegram: tg });
      metrics.recordSignal();
      this.log.info('signal emitted', {
        match: `${match.home} x ${match.away}`,
        suggestion: analysis.suggestion,
        conf: analysis.confidence,
        risk: analysis.risk?.label,
      });
    }

    const newStats = await db.getStats();
    this.io.emit('stats:update', { ...newStats, currentMinScore: this.minScore });
  }

  snapshot() {
    return {
      matches: this.lastMatches,
      analyses: this.lastAnalyses,
      minScore: this.minScore,
      sentRecentlySize: this.sentRecently.size,
      liveEnabled: this.liveEnabled,
    };
  }

  /**
   * Snapshot do último tick do pipeline para diagnóstico.
   * Inclui contagens por estágio (scanner → checkFn → pre-emit → emitted)
   * e razões de drop. Consumido por GET /api/admin/match-debug.
   */
  getLastDebugSnapshot() {
    return this._lastDebugSnapshot || null;
  }

  /**
   * Força um refresh imediato (não espera o próximo intervalo do scanner).
   * Usado por GET /api/matches para garantir dados em tempo real.
   */
  async forceRefresh() {
    try {
      await this.runOnce();
    } catch (e) {
      this.log.error('forceRefresh error', { err: e.message });
    }
    return this.snapshot();
  }
}

module.exports = { RobotrendBot };
