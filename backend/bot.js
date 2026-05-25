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
const { createPreliveScanner } = require('./prelive');
const { sendSignal } = require('./telegram');
const { logger } = require('./logger');
const metrics = require('./metrics');
const freshness = require('./freshness');

const SCAN_INTERVAL = Number(process.env.LIVE_SCAN_INTERVAL_MS || 15000);
const BASE_MIN_SCORE = Number(process.env.SIGNAL_MIN_SCORE || 80);
const SENT_TTL_MS = 30 * 60 * 1000; // limpa entradas com >30 min

const ENV = process.env.NODE_ENV || 'development';
const STRICT_REAL_ONLY = (() => {
  const raw = process.env.STRICT_REAL_ONLY;
  if (raw == null || raw === '') return ENV === 'production' || ENV === 'staging';
  return String(raw).toLowerCase() === 'true';
})();

class RobotrendBot {
  constructor(io) {
    this.io = io;
    this.live = createLiveScanner();
    this.prelive = createPreliveScanner();
    this.sentRecently = new Map(); // matchId -> timestamp
    this.lastMatches = [];
    this.lastAnalyses = [];
    this.minScore = BASE_MIN_SCORE;
    this.timer = null;
    this.cleanupTimer = null;
    this.log = logger.child({ module: 'bot' });

    // Toggles globais (sobrescrevíveis via .env)
    this.liveEnabled    = String(process.env.LIVE_ENABLED    || 'true').toLowerCase() !== 'false';
    this.preliveEnabled = String(process.env.PRELIVE_ENABLED || 'true').toLowerCase() !== 'false';
  }

  start() {
    this.log.info('scanner started', { interval: SCAN_INTERVAL, minScore: this.minScore,
      liveEnabled: this.liveEnabled, preliveEnabled: this.preliveEnabled });
    if (this.liveEnabled) {
      this.runOnce().catch((e) => this.log.error('tick error', { err: e.message }));
    } else {
      this.log.warn('[live] scanner iniciado em modo PAUSADO (LIVE_ENABLED=false)');
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

  setPreliveEnabled(value) {
    const next = !!value;
    if (this.preliveEnabled === next) return { changed: false, preliveEnabled: next };
    this.preliveEnabled = next;
    if (next) {
      this.log.info('[prelive] scanner retomado');
    } else {
      this.log.warn('[prelive] scanner pausado');
      // Congela análises pré-live no front
      this.io.emit('prelive:update', []);
    }
    this.io.emit('system:status', this.systemStatus());
    return { changed: true, preliveEnabled: next };
  }

  systemStatus() {
    return {
      liveEnabled: this.liveEnabled,
      preliveEnabled: this.preliveEnabled,
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
    let droppedAtBot = 0;
    const enriched = [];
    for (const { match, analysis } of results) {
      const fresh = checkFn(match);
      if (!fresh.ok) {
        droppedAtBot++;
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
      console.log(`[LIVE FILTER] ${droppedAtBot} jogos removidos por não serem reais`);
    }

    // Última camada de defesa pré-emit: refiltra com checkFn (paranoia).
    const safe = enriched.filter(({ match }) => checkFn(match).ok);
    const droppedPreEmit = enriched.length - safe.length;
    if (droppedPreEmit > 0) {
      console.log(`[LIVE FILTER] ${droppedPreEmit} jogos removidos por não serem reais (pre-emit)`);
    }

    this.lastMatches = safe.map((r) => r.match);
    this.lastAnalyses = safe.map((r) => r.analysis);
    db.bumpMonitored(safe.length);

    console.log(`[MATCH ENGINE] only real-time API data rendered (${safe.length} matches)`);

    this.io.emit('matches:update', this.lastMatches);
    this.io.emit('analyses:update', this.lastAnalyses);

    for (const { match, analysis } of safe) {
      if (!analysis.shouldSignal) continue;

      // FAKE-MATCH GUARD — defesa SEMPRE ativa (não depende de STRICT).
      // IDs `demo-*` ou matches sem origem real (source !== 'api-football'
      // / sem provider conhecido) NUNCA devem gerar signal Telegram.
      // Antes esse bloqueio só rodava em STRICT_REAL_ONLY → em dev o sistema
      // emitia signals fake (ex.: Chelsea x Arsenal) sobre os matches sintéticos
      // do DemoLiveScanner. Agora bloqueamos em todos os ambientes.
      const isDemoId = String(match.id || '').startsWith('demo-');
      const knownRealSource = match.source === 'api-football'
        || match.provider === 'sofascore'
        || match.provider === 'thesportsdb'
        || match.provider === 'apisports'
        || match.provider === 'football-data'
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

  async runPrelive() {
    if (!this.preliveEnabled) {
      this.log.debug('[prelive] requisição ignorada (scanner pausado)');
      return [];
    }
    const fixtures = await this.prelive.list();
    for (const fx of fixtures) {
      if (!fx.shouldSignal || fx.stale) continue;

      // STRICT: pré-live NÃO emite signal live — pré-live só pode emitir
      // signal pré-live (já segregado). Bloqueia qualquer escape.
      if (STRICT_REAL_ONLY) {
        // pré-live tem source=api-football-prelive (não é live), então
        // checkSignalSource intencionalmente passa? Não: exige isFromLiveAPI=true.
        // Aqui o pré-live é signal de mercado BTTS futuro — permitimos apenas
        // se vier da API real (source começa com "api-").
        const src = String(fx.source || '');
        if (!/^api-/i.test(src)) {
          console.log(`[SIGNAL BLOCK PRELIVE] ${fx.home} x ${fx.away} bloqueado: source="${src}"`);
          continue;
        }
      }

      const lastSent = this.sentRecently.get(`pre-${fx.matchId}`) || 0;
      if (Date.now() - lastSent < 30 * 60 * 1000) continue;
      this.sentRecently.set(`pre-${fx.matchId}`, Date.now());

      const saved = await db.saveSignal(fx, null);
      const tg = await sendSignal(fx);
      this.io.emit('signal:new', { ...saved, telegram: tg });
      metrics.recordSignal();
    }
    this.io.emit('prelive:update', fixtures);
    return fixtures;
  }

  snapshot() {
    return {
      matches: this.lastMatches,
      analyses: this.lastAnalyses,
      minScore: this.minScore,
      sentRecentlySize: this.sentRecently.size,
      liveEnabled: this.liveEnabled,
      preliveEnabled: this.preliveEnabled,
    };
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
