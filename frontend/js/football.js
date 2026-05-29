/**
 * Robotrend IA — Football Live (frontend)
 *
 * Dashboard estilo Bet365/Flashscore:
 *   - 3 painéis (Ligas | Partidas | Detalhe)
 *   - Realtime via Socket.io namespace /football (rooms: lobby / fixture / league)
 *   - Filtros avançados (liga, busca, minuto, pressão, BTTS)
 *   - Favoritos automáticos (localStorage)
 *   - Trends (sparklines de pressão, escanteios, gols por minuto)
 *   - Timeline minuto-a-minuto via /history/:id/snapshots
 *   - Toasts de eventos pontuais (gol, escanteio, cartão, BTTS iminente)
 */

(() => {
  'use strict';

  // === Estado ===
  const ALL_MARKETS = ['corners', 'goals', 'btts', 'cards', 'pressure'];
  /** Tempo que um jogo pode sumir do feed antes de ser removido da UI (evita flicker no restart). */
  const MATCH_VANISH_GRACE_MS = 90_000;
  /** Após disconnect do socket, não remove jogos por N ms (servidor reiniciando). */
  const RECONNECT_GRACE_MS = 120_000;

  function isLocalDev() {
    try {
      const h = location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '';
    } catch { return false; }
  }

  /** Modos legados 'live' / 'ao-vivo' → scanner (lista completa ao vivo). */
  function normalizeMode(mode) {
    const m = mode || 'scanner';
    if (m === 'live' || m === 'ao-vivo') return 'scanner';
    return m;
  }

  function effectiveMode() {
    return normalizeMode(state.mode);
  }

  const state = {
    matches: new Map(),     // id -> match
    leagues: new Map(),     // id|name -> { name, count, country, flag }
    activeLeague: null,     // id ou nome
    activeMatchId: null,
    favorites: new Set(loadJSON('rt:fb:favs', [])),
    filters: { search: '', scored: '', minute: '', pressureOnly: false, onlyFavorites: false, bttsNear: false },
    poller: null,
    socket: null,
    sseFallback: null,
    detailTab: 'ia', // default: leitura IA
    // --- RADAR / MERCADOS ---
    // mode: 'signals' (SignalCards filtrados, default)
    //     | 'scanner' (TODOS os jogos ao vivo, zero filtro IA)
    //     | 'radar'   (apenas jogos quentes — com signal acima do threshold)
    // Compat: legado 'live' é migrado para 'scanner' na inicialização.
    mode: (() => {
      const defaultMode = isLocalDev() ? 'scanner' : 'signals';
      const saved = loadJSON('rt:fb:mode', defaultMode);
      const migrated = normalizeMode(saved);
      if (migrated !== saved) {
        try { localStorage.setItem('rt:fb:mode', JSON.stringify(migrated)); } catch {}
      }
      return migrated;
    })(),
    // mercados ativos. Set de strings: 'corners','goals','btts','cards','pressure'.
    // 'all' = vazio (sem filtro). Persiste em localStorage.
    markets: new Set(loadJSON('rt:fb:markets', [])),
    minConfidence: Number(loadJSON('rt:fb:minConf', 70)),
    profile: loadJSON('rt:fb:profile', 'balanced'),
    /**
     * showAll: bypass dos filtros de confiança/mercado/perfil.
     *   - Cliente regular: false (toggle manual)
     *   - Master/admin: força true por default (mas pode desligar)
     *   - Demo mode: força true (provider=demo é só visualização)
     * Quando ativo, sinais abaixo do threshold aparecem com badge LOW
     * CONFIDENCE / BELOW TARGET / FILTERED em vez de serem escondidos.
     * O dashboard nunca pode parecer vazio se há matches enriquecidos.
     */
    showAll: Boolean(loadJSON('rt:fb:showAll', false)),
    /** Role do user logado (resolvida via RobotrendUser / RobotrendAuth). */
    role: '',
    /** Provider ativo (preenchido por feedMeta) — usado para auto-relax em demo. */
    activeProvider: '',
    // Signals indexados por matchId → array de signals recentes (max 5)
    signalsByMatch: new Map(),
    // Toasts: total emitidos & filtrados (debug)
    toastStats: { fired: 0, suppressed: 0 },

    // === SOURCE OF TRUTH ÚNICO — pipeline runtime ===
    // Toda a UI deve ler/escrever AQUI. Qualquer divergência = bug.
    runtime: {
      // Conexão
      conn: 'connecting',            // connecting | online | reconnecting | offline | stale
      reconnects: 0,
      transport: '–',

      // Timestamps reais (ms epoch, 0 = nunca aconteceu)
      lastPollAt: 0,                 // último 'tick' ou snapshot REST com matches
      lastSocketAt: 0,               // qualquer evento socket recebido
      lastEnrichedAt: 0,             // último 'match:enriched'
      lastSignalAt: 0,               // último 'signal:fire'

      // Contadores reais (não inflados, não fake)
      rawMatchesCount: 0,            // |state.matches|
      enrichedMatchesCount: 0,       // count where m.enriched=true
      filteredMatchesCount: 0,       // após filtros UI
      signalsCount: 0,               // total signals em todos os matches
      visibleSignalsCount: 0,        // após filtro de mercado/conf

      // Subscriptions e diagnóstico
      subsFixtures: new Set(),       // fixtures que assinamos (re-emit on reconnect)
      lastEvents: [],                // [{ ts, name, info }] — últimos 20
      reason: null,                  // motivo técnico se contadores=0

      // Grace após disconnect — evita sumir jogos um-a-um quando npm run dev reinicia o backend
      reconnectAt: 0,
      lastTickAt: 0,
      stableTicks: 0,

      // META do feed atual (vem do backend em /live e /scanner)
      // Usado pela barra "📡 87 recebidos · 75 exibidos · 12 filtrados · provider: sofascore"
      feedMeta: {
        totalReceived: 0,
        totalAfterFilter: 0,
        filteredOut: 0,
        provider: '—',
        safeMode: false,
        bySource: {},
        topLeagues: [],
      },

      // Pipeline health (computado por checkPipelineHealth)
      // status: 'ok' | 'no-poller' | 'no-socket' | 'no-enricher' | 'no-signals' | 'boot'
      pipeline: { status: 'boot', stage: null, since: Date.now(), warn: null },
      fallbackMode: false,   // após 10s sem enriched → mostra partial/raw
    },
  };

  // Alias retrocompatível para código antigo que ainda referencia state.diag
  // (mantemos o ponteiro porque é o mesmo objeto — qualquer write aparece nos 2)
  state.diag = state.runtime;

  // === Helpers ===
  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function fmtMin(m) { return (m || 0) + "'"; }
  function loadJSON(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // === Auth-aware fetch ===
  /** API do painel football — SEMPRE pública (sem Bearer que quebra bootstrap). */
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ============================================================
  //  SOCKET.IO REALTIME
  // ============================================================
  function initSocket() {
    if (!window.io) {
      console.warn('socket.io não carregado, tentando SSE');
      updateConn('offline', 'socket.io não carregou — usando SSE');
      state.runtime.reason = 'socket-io-missing';
      return initSSE();
    }
    updateConn('connecting', 'conectando…');
    // URL absoluta garante WSS em produção (Render) e HTTP em localhost.
    // Sem isso, alguns navegadores tratam '/football' como path do origin atual
    // e podem cair em proxies/extensions que bloqueiam o handshake.
    const origin = window.location.origin;
    const sock = io(`${origin}/football`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      withCredentials: true,
      // upgrade WS→polling em caso de falha persistente é o default;
      // mantemos polling no array para fallback automático.
    });
    state.socket = sock;
    console.log('[LIVE] socket.io → ' + origin + '/football (transports: websocket→polling)');

    sock.on('connect', () => {
      state.runtime.transport = sock.io?.engine?.transport?.name || 'ws';
      updateConn('online', `realtime online · ${state.runtime.transport}`);
      syncPrefs();
      logEvent('connect', { transport: state.runtime.transport });
      // Re-subscribe rooms ativas após reconnect
      for (const id of state.runtime.subsFixtures) sock.emit('subscribe', { type: 'fixture', id });
      // Subscribe top 5 do snapshot atual (dispara enricher no backend)
      const top = Array.from(state.matches.values())
        .sort((a, b) => ((b.score?.home || 0) + (b.score?.away || 0)) - ((a.score?.home || 0) + (a.score?.away || 0)))
        .slice(0, 5);
      for (const m of top) {
        sock.emit('subscribe', { type: 'fixture', id: m.id });
        state.runtime.subsFixtures.add(String(m.id));
      }
      bumpRuntime({ socket: true });
    });
    sock.io.on('reconnect_attempt', (n) => {
      state.runtime.reconnects = n;
      updateConn('reconnecting', `reconectando… (tent. ${n})`);
      logEvent('reconnect_attempt', { n });
    });
    sock.io.on('reconnect', () => { logEvent('reconnect_ok'); });
    sock.on('disconnect', (reason) => {
      state.runtime.reconnectAt = Date.now();
      state.runtime.stableTicks = 0;
      updateConn('offline', `desconectado: ${reason}`);
      logEvent('disconnect', { reason });
      console.log('[LIVE] socket disconnect — grace de remoção ativo por', RECONNECT_GRACE_MS / 1000, 's');
    });
    sock.on('connect_error', (err) => {
      const msg = err?.message || 'unknown';
      const transport = sock.io?.engine?.transport?.name || '?';
      updateConn('offline', `erro de conexão (${transport}): ${msg}`);
      logEvent('connect_error', { msg, transport, type: err?.type });
      console.warn(`[LIVE] connect_error transport=${transport} msg=${msg} — socket.io retry automático ativo`);
    });

    sock.on('hello', (h) => { logEvent('hello', h); bumpRuntime({ socket: true }); });
    sock.on('tick', (p) => {
      state.poller = p.poller || state.poller;
      const n = (p.matches || []).length;
      if (n > 0) {
        state.runtime.stableTicks = (state.runtime.stableTicks || 0) + 1;
        if (state.runtime.stableTicks >= 2) state.runtime.reconnectAt = 0;
      }
      state.runtime.lastTickAt = Date.now();
      replaceMatches(p.matches || [], p.generatedAt);
      // O tick socket NÃO carrega meta completa — sintetiza a partir do que
      // chegou para manter o painel SCANNER em sync (senão fica em 0/0/0).
      syncFeedMetaFromState({ source: 'socket-tick', generatedAt: p.generatedAt });
      const isStale = p.source === 'stale-cache';
      updateConn(isStale ? 'stale' : 'online',
        isStale ? '🟡 cache (API instável)' : `🟢 conectado · ${state.runtime.transport}`);
      logEvent('tick', { matches: p.matches?.length || 0, src: p.source });
      bumpRuntime({ poll: true, socket: true });
      render();
    });
    sock.on('match:upsert', ({ match }) => {
      hydrateClockBase(match);
      state.matches.set(String(match.id), match); flash(match.id, 'update');
      logEvent('match:upsert', { id: match.id, teams: `${match.home} vs ${match.away}` });
      bumpRuntime({ poll: true });
      render();
    });
    sock.on('match:update', ({ match, deltas }) => {
      hydrateClockBase(match);
      state.matches.set(String(match.id), match);
      const flashKind = deltas?.goalHome || deltas?.goalAway ? 'goal'
                      : deltas?.cornersTotal ? 'corner'
                      : (deltas?.yellowTotal || deltas?.redTotal) ? 'card' : 'update';
      flash(match.id, flashKind);
      logEvent('match:update', { id: match.id, deltas });
      bumpRuntime({ poll: true });
      if (state.activeMatchId === String(match.id)) renderDetail();
      render();
    });
    sock.on('match:remove', ({ matchId }) => {
      const id = String(matchId);
      const m = state.matches.get(id);
      if (!m) return;
      if (shouldHoldVanishedMatch(m)) {
        m._vanishedAt = m._vanishedAt || Date.now();
        logEvent('match:remove-deferred', { id, graceMs: MATCH_VANISH_GRACE_MS });
        return;
      }
      state.matches.delete(id);
      if (state.activeMatchId === id) state.activeMatchId = null;
      logEvent('match:remove', { id });
      bumpRuntime({});
      render();
    });

    sock.on('fixture:goal',      (p) => marketAllows('goals')   && toast('goal',   `⚽ GOL — ${p.match.home} ${p.match.score.home} x ${p.match.score.away} ${p.match.away}`, p.match.league?.name));
    sock.on('fixture:corner',    (p) => marketAllows('corners') && toast('corner', `🚩 Escanteio — ${p.match.home} vs ${p.match.away}`, `${fmtMin(p.match.minute)}`));
    sock.on('fixture:card',      (p) => marketAllows('cards')   && toast('card',   `${p.color === 'red' ? '🟥' : '🟨'} Cartão — ${p.match.home} vs ${p.match.away}`, `${fmtMin(p.match.minute)}`));
    sock.on('fixture:btts-near', (p) => marketAllows('btts')    && toast('btts',   `🎯 BTTS iminente — ${p.match.home} vs ${p.match.away}`, p.reason));
    sock.on('fixture:pressure',  (p) => {
      if (state.filters.pressureOnly) render(); // mostra na lista de "alta pressão"
    });
    sock.on('quota:low',         (p) => { toast('btts', `⚠️ Quota API baixa`, `restam ${p.remaining}/${p.limit}`); logEvent('quota:low', p); });
    sock.on('circuit:open',      (p) => { updateConn('stale', `API instável (${p.name})`); logEvent('circuit:open', p); });
    sock.on('circuit:close',     ()  => { updateConn('online',  `realtime online · ${state.runtime.transport}`); logEvent('circuit:close'); });
    sock.on('signal:fire', (s) => {
      logEvent('signal:fire', { type: s.type, conf: s.confidence, market: s.market });
      onSignalFire(s);
      bumpRuntime({ signal: true });
    });

    // Enrichment de stats/events incremental (statistics + events + insight + signals)
    sock.on('match:enriched', ({ match, partial }) => {
      if (!match) return;
      if (partial) match.enrichedPartial = true;
      state.matches.set(String(match.id), match);
      flash(match.id, 'update');
      patchCard(match);
      patchSignalBadge(String(match.id));
      logEvent('match:enriched', { id: match.id, signals: match.signals?.length || 0 });
      bumpRuntime({ enriched: true });
      if (effectiveMode() === 'signals') {
        renderMatches();
        updateRadarStatus();
      }
      if (state.activeMatchId === String(match.id)) renderDetail();
    });
    // Alias: alguns clientes pedem 'fixture:update' explicitamente. Como
    // o backend emite 'match:update', criamos um alias defensivo para
    // futura compatibilidade. Se o evento existir, reaproveita o mesmo handler.
    sock.on('fixture:update', (p) => {
      const match = p?.match;
      if (!match) return;
      state.matches.set(String(match.id), match);
      flash(match.id, 'update');
      logEvent('fixture:update', { id: match.id });
      if (state.activeMatchId === String(match.id)) renderDetail();
      render();
    });

    // Catch-all opcional via onAny (debug) — apenas registra no painel
    if (typeof sock.onAny === 'function') {
      sock.onAny((eventName, ...args) => {
        if (['tick', 'match:update', 'match:upsert', 'match:enriched', 'match:remove',
             'fixture:goal', 'fixture:corner', 'fixture:card', 'fixture:btts-near',
             'fixture:pressure', 'signal:fire', 'hello', 'fixture:update',
             'quota:low', 'circuit:open', 'circuit:close', 'match:enrich-fail'].includes(eventName)) return;
        logEvent(`any:${eventName}`, { args: args.length });
      });
    }

    sock.on('match:enrich-fail', ({ fixtureId, reason }) => {
      console.warn('[enrich-fail]', fixtureId, reason);
      logEvent('match:enrich-fail', { id: fixtureId, reason });
      if (state.activeMatchId === String(fixtureId)) {
        const el = document.querySelector('#detail-tab-content .fb-skeleton');
        if (el) el.innerHTML = `<div class="fb-empty">não foi possível carregar (${escapeHtml(reason || 'erro')})</div>`;
      }
    });

    // Heartbeat watchdog: com poll de 15s, 30s sem tick = 2 ciclos perdidos.
    // → marca como offline (🔴). Volta a 'online' (🟢) no próximo tick recebido.
    setInterval(() => {
      const rt = state.runtime;
      const sinceTick = rt.lastPollAt ? Date.now() - rt.lastPollAt : Infinity;
      if (rt.lastPollAt && sinceTick > 30_000 && rt.conn !== 'offline') {
        updateConn('offline', `🔴 sem tick há ${Math.round(sinceTick/1000)}s`);
      }
      checkPipelineHealth();
      renderDebugPanel();
    }, 5_000);

    // Clock local: localClockEngine() roda a cada 1s. Incrementa minute
    // visualmente entre ticks do servidor, atualiza "tick há Xs" e marca
    // matches FT como encerrando após 60s.
    setInterval(() => localClockEngine(), 1_000);
  }

  // SSE fallback (caso WS bloqueado)
  function initSSE() {
    try {
      const es = new EventSource('/api/football/live/stream');
      state.sseFallback = es;
      es.addEventListener('tick', (e) => {
        const p = JSON.parse(e.data);
        replaceMatches(p.matches || [], p.generatedAt);
        bumpRuntime({ poll: true, socket: true });
        updateConn('online', '🟢 conectado · SSE'); render();
      });
      es.addEventListener('match:update', (e) => {
        const { match } = JSON.parse(e.data);
        hydrateClockBase(match);
        state.matches.set(String(match.id), match);
        flash(match.id, 'update');
        render();
      });
      es.addEventListener('match:upsert', (e) => {
        const { match } = JSON.parse(e.data);
        hydrateClockBase(match);
        state.matches.set(String(match.id), match);
        flash(match.id, 'update');
        render();
      });
      es.addEventListener('match:remove', (e) => {
        const { matchId } = JSON.parse(e.data);
        state.matches.delete(String(matchId));
        render();
      });
      es.addEventListener('fixture:goal',   (e) => { const p = JSON.parse(e.data); flash(p.match?.id, 'goal'); toast('goal', `⚽ GOL — ${p.match.home} x ${p.match.away}`); });
      es.addEventListener('fixture:corner', (e) => { const p = JSON.parse(e.data); toast('corner', `🚩 Escanteio`); });
      es.onopen = () => updateConn('online', '🟢 conectado · SSE');
      es.onerror = () => {
        const ready = es.readyState;
        // 0 = CONNECTING (auto-reconnect em progresso), 2 = CLOSED
        if (ready === 0) updateConn('reconnecting', '🟡 reconectando SSE…');
        else updateConn('offline', '🔴 SSE desconectado');
      };
    } catch (e) { console.warn('SSE indisponível', e); }
  }

  /**
   * Estados:
   *   online       → 🟢 (verde pulsando)   — recebendo ticks ok
   *   stale        → 🟡 (amarelo fixo)     — cache em uso / API instável
   *   connecting   → 🟡 (amarelo piscando) — handshake inicial
   *   reconnecting → 🟡 (amarelo piscando) — perda de conexão, tentando voltar
   *   offline      → 🔴 (vermelho)         — sem conexão
   */
  function updateConn(connState, label) {
    const pill = $('#rt-pill');
    if (!pill) return;
    state.runtime.conn = connState;
    pill.classList.remove('live', 'stale', 'off', 'connecting', 'reconnecting');
    const cls = connState === 'online'        ? 'live'
              : connState === 'stale'         ? 'stale'
              : connState === 'connecting'    ? 'connecting'
              : connState === 'reconnecting'  ? 'reconnecting'
              :                                 'off';
    pill.classList.add(cls);
    const lbl = $('#rt-pill-label');
    if (lbl) lbl.textContent = label;
  }

  /* ============================================================
     DIAGNÓSTICO / DEBUG PANEL — single source of truth
     ============================================================ */
  /** Atualiza state.runtime.* e força re-render dos contadores reais. */
  function bumpRuntime(patch = {}) {
    const rt = state.runtime;
    if (patch.poll)     rt.lastPollAt = Date.now();
    if (patch.socket)   rt.lastSocketAt = Date.now();
    if (patch.enriched) rt.lastEnrichedAt = Date.now();
    if (patch.signal)   rt.lastSignalAt = Date.now();
    // Sempre recomputar contadores a partir do estado canônico
    rt.rawMatchesCount = state.matches.size;
    let enriched = 0, sigs = 0;
    for (const m of state.matches.values()) {
      if (m.enriched) enriched++;
      if (Array.isArray(m.signals)) sigs += m.signals.length;
    }
    rt.enrichedMatchesCount = enriched;
    rt.signalsCount = sigs;
    rt.visibleSignalsCount = typeof collectSignals === 'function' ? collectSignals().length : 0;
    rt.filteredMatchesCount = effectiveMode() === 'signals'
      ? rt.visibleSignalsCount
      : (typeof getFiltered === 'function' ? getFiltered().length : rt.rawMatchesCount);
    // Mantém feedMeta.totalReceived sincronizado com state.matches mesmo
    // quando socket events (match:upsert / match:remove) entram entre fetches.
    // Sem isso, scanner mostra "0 recebidos" embora state tenha N matches.
    if (typeof syncFeedMetaFromState === 'function' && state.matches.size > 0) {
      const cur = state.runtime.feedMeta || {};
      if ((cur.totalReceived || 0) < state.matches.size) {
        syncFeedMetaFromState({ source: 'bumpRuntime' });
      }
    }
    checkPipelineHealth();
    renderDebugPanel();
    if (typeof renderModeMeta === 'function') renderModeMeta();
  }

  function logEvent(name, info = {}) {
    state.runtime.lastSocketAt = Date.now();
    state.runtime.lastEvents.unshift({ ts: Date.now(), name, info });
    if (state.runtime.lastEvents.length > 20) state.runtime.lastEvents.length = 20;
    renderDebugPanel();
  }

  /* ============================================================
     PIPELINE HEALTH — single source of truth para "está vivo?"
     ============================================================
     Stages:
       1. POLLER   → backend está chamando API-Football?  (lastPollAt)
       2. SOCKET   → estamos conectados e recebendo eventos? (conn + lastSocketAt)
       3. ENRICHER → enriquecimento está chegando? (lastEnrichedAt vs lastPollAt)
       4. SIGNALS  → IA está gerando sinais? (signalsCount > 0)
     Stage que falha primeiro é o stage "quebrado".
  */
  function checkPipelineHealth() {
    const rt = state.runtime;
    const now = Date.now();
    const ageMs = (t) => t ? now - t : Infinity;

    // 1) Boot — primeira meia segundo é normal estar vazio
    if (now - rt.pipeline.since < 500 && rt.pipeline.status === 'boot') {
      return rt.pipeline;
    }

    // 2) SOCKET — desconectado é o primeiro problema crítico
    if (rt.conn === 'offline') {
      return setPipeline('no-socket', 'SOCKET',
        'WebSocket desconectado — o navegador não está recebendo eventos do servidor.');
    }
    if (rt.conn === 'connecting' || rt.conn === 'reconnecting') {
      return setPipeline('boot', 'SOCKET',
        `Aguardando conexão (${rt.conn})…`);
    }

    // 3) POLLER — socket ok, mas não chegou tick em 60s nem snapshot REST
    if (rt.rawMatchesCount === 0 && ageMs(rt.lastPollAt) > 60_000) {
      const reason = rt.reason
        ? `Backend respondeu com: ${rt.reason}.`
        : 'Poller não está retornando partidas (verifique API-Football quota/key).';
      return setPipeline('no-poller', 'POLLER', reason);
    }

    // 4) ENRICHER — poller traz matches, mas nenhum enriquecido em 30s
    if (rt.rawMatchesCount > 0 && rt.enrichedMatchesCount === 0 && ageMs(rt.lastEnrichedAt) > 30_000) {
      if (!rt.fallbackMode) activateFallbackMode();
      return setPipeline('no-enricher', 'ENRICHER',
        `${rt.rawMatchesCount} jogo(s) no poller, enricher sem match:enriched. ` +
        `Modo fallback ${rt.fallbackMode ? 'ATIVO' : 'pendente'}.`);
    }

    // 5) SIGNALS — pipeline ok mas IA não gerou nada (warning, não fatal)
    if (rt.enrichedMatchesCount > 0 && rt.signalsCount === 0) {
      rt.pipeline = { status: 'ok', stage: null, since: rt.pipeline.since, warn:
        `${rt.enrichedMatchesCount} jogo(s) enriquecido(s) mas zero signals gerados. ` +
        `IA pode não ter encontrado setup ou signalGenerator falhou silenciosamente.` };
      return rt.pipeline;
    }

    // Tudo ok
    rt.pipeline = { status: 'ok', stage: null, since: rt.pipeline.since, warn: null };
    return rt.pipeline;
  }

  function setPipeline(status, stage, msg) {
    state.runtime.pipeline = { status, stage, since: state.runtime.pipeline.since, warn: msg };
    return state.runtime.pipeline;
  }

  /**
   * Debug panel permanente — não é mais oculto. Mostra:
   *   - pipeline health badge (POLLER / SOCKET / ENRICHER / OK)
   *   - timestamps reais (ageMs)
   *   - contadores reais
   *   - últimos eventos socket
   */
  function renderDebugPanel() {
    if (!window.__ROBOTREND_DEBUG) return; // produção: skip silencioso
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const setHtml = (id, v) => { const el = document.getElementById(id); if (el) el.innerHTML = v; };
    const fmtAgo = (t) => t ? `${Math.round((Date.now() - t) / 1000)}s` : 'nunca';
    const rt = state.runtime;
    const sock = state.socket;

    // Pipeline badge
    const p = rt.pipeline;
    const badge = p.status === 'ok' && !p.warn ? `<span style="color:#22c55e">✅ OK</span>`
                : p.status === 'ok' && p.warn  ? `<span style="color:#facc15">⚠ OK·warn</span>`
                : p.status === 'boot'          ? `<span style="color:#94a3b8">⏳ ${p.stage || 'boot'}</span>`
                : `<span style="color:#ef4444">🔴 ${p.stage} quebrado</span>`;
    setHtml('dbg-pipeline', badge);
    setText('dbg-pipeline-msg', p.warn || (p.status === 'ok' ? 'todos os estágios ok' : ''));

    // Conexão
    setHtml('dbg-socket', sock?.connected
      ? `<span style="color:#22c55e">✅ ${sock.id?.slice(0, 8) || 'ok'}</span>`
      : `<span style="color:#ef4444">❌ ${rt.conn}</span>`);
    setText('dbg-transport', rt.transport);
    setText('dbg-recon', String(rt.reconnects));

    // Timestamps reais
    setText('dbg-last-poll',     fmtAgo(rt.lastPollAt));
    setText('dbg-last-socket',   fmtAgo(rt.lastSocketAt));
    setText('dbg-last-enriched', fmtAgo(rt.lastEnrichedAt));
    setText('dbg-last-signal',   fmtAgo(rt.lastSignalAt));

    // Contadores reais
    setText('dbg-raw',          String(rt.rawMatchesCount));
    setText('dbg-enriched',     String(rt.enrichedMatchesCount));
    setText('dbg-filtered',     String(rt.filteredMatchesCount));
    setText('dbg-sig-all',      String(rt.signalsCount));
    setText('dbg-sig-vis',      String(rt.visibleSignalsCount));
    setText('dbg-subs',         `${rt.subsFixtures.size} fixtures`);
    setText('dbg-poll-ms',      state.poller?.intervalMs ? `${state.poller.intervalMs}ms` : '–');

    // Últimos eventos
    const evRoot = document.getElementById('dbg-events');
    if (evRoot) {
      evRoot.innerHTML = rt.lastEvents.slice(0, 8).map((e) => {
        const t = new Date(e.ts).toLocaleTimeString('pt-BR');
        const info = Object.keys(e.info || {}).length
          ? ` <span style="color:#94a3b8">${escapeHtml(JSON.stringify(e.info).slice(0, 50))}</span>`
          : '';
        return `<div class="ev"><span class="ts">${t}</span> <span class="name">${escapeHtml(e.name)}</span>${info}</div>`;
      }).join('') || '<div style="color:#64748b;font-style:italic">aguardando eventos…</div>';
    }

    // Pipeline banner (acima da lista principal) — bloqueia render se quebrado
    renderPipelineBanner();
  }

  /**
   * Banner crítico no topo da área principal quando pipeline está quebrado.
   * O usuário NÃO pode ignorar — ocupa o lugar dos cards/signals.
   */
  function renderPipelineBanner() {
    const main = document.getElementById('matches');
    if (!main) return;
    const p = state.runtime.pipeline;
    const rt = state.runtime;
    if ((p.status === 'ok' || p.status === 'boot') && !rt.fallbackMode) {
      const old = document.getElementById('pipe-banner');
      if (old) old.remove();
      return;
    }
    if (rt.fallbackMode && rt.enrichedMatchesCount > 0) {
      let banner = document.getElementById('pipe-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'pipe-banner';
        main.parentNode.insertBefore(banner, main);
      }
      banner.style.cssText = `
        background: linear-gradient(135deg,#713f12,#854d0e);color:#fef3c7;
        padding:10px 14px;border-radius:8px;margin-bottom:12px;
        border-left:4px solid #facc15;font-size:12px;`;
      banner.innerHTML = `
        <strong>⚠ Modo fallback</strong> — sinais parciais (enrichment API indisponível).
        ${rt.enrichedMatchesCount}/${rt.rawMatchesCount} jogos com leitura básica.
      `;
      return;
    }
    let banner = document.getElementById('pipe-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pipe-banner';
      banner.style.cssText = `
        background: linear-gradient(135deg,#7f1d1d,#991b1b);color:#fee2e2;
        padding:14px 18px;border-radius:10px;margin-bottom:14px;
        border-left:4px solid #ef4444;font-size:13px;line-height:1.5;`;
      main.parentNode.insertBefore(banner, main);
    }
    banner.innerHTML = `
      <div style="font-weight:800;font-size:14px;margin-bottom:4px">
        🔴 Pipeline interrompido em: ${p.stage}
      </div>
      <div style="opacity:.9">${escapeHtml(p.warn || '')}</div>
      <div style="margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:11px;opacity:.75">
        socket=${state.runtime.conn} · matches=${state.runtime.rawMatchesCount} ·
        enriched=${state.runtime.enrichedMatchesCount} · signals=${state.runtime.signalsCount}
      </div>
      <button class="btn btn-ghost" style="margin-top:10px"
        onclick="document.getElementById('btn-refresh').click()">↻ Forçar resync</button>
    `;
  }

  /**
   * Painel debug é OCULTO em produção. Só inicializa se o usuário fez opt-in
   * explícito (window.__ROBOTREND_DEBUG = true via ?debug=1 / localStorage.fbDebug).
   * Caso contrário, nem o `classList.add('open')` é aplicado para evitar qualquer
   * reveal visual acidental por CSS de terceiros.
   */
  function bindDebugPanel() {
    if (!window.__ROBOTREND_DEBUG) return;
    const el = document.getElementById('fb-debug');
    if (!el) return;
    el.classList.add('open');
    renderDebugPanel();
  }

  function bumpLastUpdated(generatedAt) {
    const el = document.getElementById('last-updated');
    if (!el) return;
    const d = generatedAt ? new Date(generatedAt) : new Date();
    const t = isNaN(d.getTime()) ? new Date() : d;
    el.textContent = `Última atualização: ${t.toLocaleTimeString('pt-BR')}`;
  }

  function flash(id, kind) {
    const el = $(`[data-mid="${id}"]`);
    if (!el) return;
    el.classList.add(`flash-${kind}`);
    setTimeout(() => el.classList.remove(`flash-${kind}`), 900);
  }

  // ============================================================
  //  ROLE / SHOW-ALL — controles de UX por perfil
  // ============================================================
  /** Roles com privilégios de "ver tudo" mesmo abaixo do threshold. */
  const MASTER_ROLES_FB = new Set(['master', 'admin', 'owner', 'super_admin']);

  function resolveCurrentRole() {
    try {
      const us = window.RobotrendUser?.get?.();
      if (us) return String(us.role || us.user?.role || '').toLowerCase();
      const u = window.RobotrendAuth?.getUser?.();
      return String(u?.role || '').toLowerCase();
    } catch { return ''; }
  }
  function isMasterRoleFb(role) {
    return MASTER_ROLES_FB.has(String(role || '').toLowerCase());
  }
  function isDemoActive() {
    return String(state.activeProvider || '').toLowerCase() === 'demo';
  }
  /**
   * Master e modo demo SEMPRE veem tudo. Cliente regular respeita o toggle
   * "Mostrar tudo" persistido. Use isShowAllActive() em renderSignalBoard
   * e collectSignals para decidir se aplica filtros rígidos.
   */
  function isShowAllActive() {
    if (isMasterRoleFb(state.role)) return true;
    if (isDemoActive()) return true;
    return !!state.showAll;
  }
  function setShowAll(v) {
    state.showAll = !!v;
    saveJSON('rt:fb:showAll', state.showAll);
    updateShowAllButton();
    render();
  }
  function updateShowAllButton() {
    const btn = document.getElementById('btn-show-all');
    if (!btn) return;
    const forced = isMasterRoleFb(state.role) || isDemoActive();
    const active = isShowAllActive();
    btn.classList.toggle('active', active);
    btn.disabled = forced; // master/demo não desligam
    btn.title = forced
      ? (isDemoActive()
          ? 'Modo demo: análises completas sempre visíveis'
          : 'Master admin: análises completas sempre visíveis')
      : (active
          ? 'Mostrando análises IA completas (inclusive abaixo do threshold)'
          : 'Apenas sinais operáveis acima do threshold');
    btn.textContent = active ? '👁 Mostrar tudo' : '🎯 Apenas operáveis';
  }

  // ============================================================
  //  MERCADOS / RADAR — filtro de operação
  // ============================================================
  /** true se o mercado está habilitado (vazio = todos). */
  function marketAllows(market) {
    if (!state.markets || state.markets.size === 0) return true;
    return state.markets.has(market);
  }

  /**
   * Avaliação do sinal contra os filtros atuais. Devolve sempre um objeto
   * com:
   *   - allowed: true se o sinal passa em modo cliente strict
   *   - reasons: lista de chaves explicando por que foi filtrado, usadas
   *     para badges no modo "Mostrar tudo" / master.
   * Reasons possíveis:
   *   - 'confidence_low'    confidence < state.minConfidence
   *   - 'market_mismatch'   sinal não bate com nenhum mercado ativo
   *   - 'profile_filtered'  perfil conservador/agressivo rejeita
   *   - 'no_edge'           IA marcou sem edge (s.noEdge / s.edge<=0)
   */
  function evaluateSignal(s) {
    const reasons = [];
    if (!s) return { allowed: false, reasons: ['invalid'] };
    if ((s.confidence || 0) < state.minConfidence) reasons.push('confidence_low');
    if (state.markets.size) {
      const markets = s.markets || (s.market ? [s.market] : []);
      if (!markets.some((m) => state.markets.has(m))) reasons.push('market_mismatch');
    }
    if (state.profile === 'conservative') {
      const p = s.profile || 'balanced';
      if (p !== 'conservative' && p !== 'balanced') reasons.push('profile_filtered');
    } else if (state.profile === 'aggressive' && (s.confidence || 0) < 50) {
      reasons.push('profile_filtered');
    }
    if (s.noEdge === true || (typeof s.edge === 'number' && s.edge <= 0)) reasons.push('no_edge');
    return { allowed: reasons.length === 0, reasons };
  }

  /** true se um signal pode passar pelo filtro atual (compat). */
  function signalAllowed(s) {
    return evaluateSignal(s).allowed;
  }

  function onSignalFire(s) {
    if (!s) return;
    state.toastStats.fired++;
    // Indexa por matchId para o card mostrar badge + radar ordenar
    const id = String(s.matchId);
    const arr = state.signalsByMatch.get(id) || [];
    arr.unshift(s); arr.length = Math.min(arr.length, 5);
    state.signalsByMatch.set(id, arr);

    if (!signalAllowed(s)) { state.toastStats.suppressed++; }
    else {
      const icon = s.classification?.emoji
        || (s.type === 'btts-imminent' ? '🎯'
        :   s.type === 'pressure-surge' ? '🔥'
        :   s.type === 'corners-momentum' ? '🚩'
        :   s.type === 'over-corners' ? '📈'
        :   s.type === 'over-goals' ? '⚽'
        :   s.type === 'cards-surge' ? '🟨' : '⚡');
      toast('btts', `${icon} ${s.suggestion}`, `${s.home} vs ${s.away} · ${s.minute}' · conf ${s.confidence}%`);
    }
    // Atualiza badges em tempo real
    patchSignalBadge(id);
    if (state.mode === 'radar') renderMatches();
    if (state.activeMatchId === id) renderDetail();
    updateRadarStatus();
  }

  /** Atualiza badge de signal num card específico sem repintar a lista. */
  function patchSignalBadge(matchId) {
    const card = document.querySelector(`[data-mid="${matchId}"]`);
    if (!card) return;
    const existing = card.querySelector('.fb-sig-badge');
    if (existing) existing.remove();
    const top = topSignalFor(matchId);
    if (!top) {
      card.classList.remove('has-signal', 'hot');
      return;
    }
    card.classList.add('has-signal');
    if (top.confidence >= 85) card.classList.add('hot'); else card.classList.remove('hot');
    const b = document.createElement('div');
    b.className = 'fb-sig-badge';
    b.textContent = `${top.classification?.emoji || '⚡'} ${top.confidence}%`;
    b.title = `${top.suggestion} · ${top.type}`;
    card.appendChild(b);
  }

  /**
   * Retorna o sinal mais forte e permitido pelo filtro de mercados para um
   * match. Em modo "Mostrar tudo" (master/demo/toggle) cai para o sinal
   * de maior confiança mesmo abaixo do threshold — para que os mini-cards
   * exibam algo informativo ao invés de ficarem "—".
   */
  function topSignalFor(matchId) {
    const arr = state.signalsByMatch.get(String(matchId)) || [];
    if (!arr.length) return null;
    const allowed = arr.filter(signalAllowed);
    if (allowed.length) {
      return allowed.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    }
    if (isShowAllActive()) {
      return arr.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    }
    return null;
  }

  function updateRadarStatus() {
    const el = $('#radar-status'); if (!el) return;
    const profIcon = state.profile === 'conservative' ? '🛡'
                   : state.profile === 'aggressive'    ? '⚡'
                   :                                     '⚖';
    const mk = state.markets.size === 0 ? 'todos' : Array.from(state.markets).join('+');
    if (effectiveMode() === 'signals') {
      const count = collectSignals().length;
      el.textContent = `🎯 ${count} sinais · ${mk} · ${profIcon} · ≥${state.minConfidence}%`;
      el.classList.add('radar');
    } else if (effectiveMode() === 'radar') {
      const visibleSignals = Array.from(state.signalsByMatch.values())
        .flat().filter(signalAllowed).length;
      el.textContent = `📈 ${visibleSignals} eventos · ${mk} · ${profIcon} · ≥${state.minConfidence}%`;
      el.classList.add('radar');
    } else if (effectiveMode() === 'scanner') {
      const total = Math.max(state.runtime.feedMeta?.totalReceived || 0, state.matches.size);
      el.textContent = `📡 SCANNER · ${total} jogos ao vivo · zero filtro IA`;
      el.classList.remove('radar');
    } else {
      el.textContent = `📡 Ao vivo · ${mk} · ${profIcon} ${state.profile}`;
      el.classList.remove('radar');
    }
  }

  /**
   * Quando usuário entra no modo Sinais e nada está enriched, faz subscribe
   * automático aos top 5 matches com mais ação. Isso dispara enrichment via
   * room fixture:<id> respeitando o budget (cache 30min, dedup, breaker).
   */
  function autoEnrichTop() {
    if (!state.socket) return;
    const enriched = Array.from(state.matches.values()).filter((m) => m.enriched);
    if (enriched.length >= 3) return; // já tem material
    const top = Array.from(state.matches.values())
      .sort((a, b) => {
        const ga = (a.score?.home || 0) + (a.score?.away || 0);
        const gb = (b.score?.home || 0) + (b.score?.away || 0);
        if (gb !== ga) return gb - ga;
        return (b.minute || 0) - (a.minute || 0);
      })
      .slice(0, 5);
    for (const m of top) {
      state.socket.emit('subscribe', { type: 'fixture', id: m.fixtureId });
      state.runtime.subsFixtures.add(String(m.fixtureId));
    }
    logEvent('auto-enrich', { count: top.length });
  }

  /** Envia preferências do usuário para o backend filtrar emits server-side. */
  function syncPrefs() {
    if (!state.socket) return;
    const prefs = {
      markets: Array.from(state.markets),
      profile: state.profile,
      minConfidence: state.minConfidence,
    };
    state.socket.emit('prefs', prefs);
  }

  /** Filtra picks aplicando profile + markets localmente (para o insight tab). */
  function filterPicksLocal(picks) {
    if (!Array.isArray(picks) || !picks.length) return picks;
    let out = picks.slice();
    if (state.markets.size) out = out.filter((p) => state.markets.has(p.market));
    if (state.profile === 'conservative') {
      out = out.filter((p) =>
        (p.kind === 'best' || p.kind === 'conservative')
        && (p.risk?.tag === 'BAIXO' || p.risk?.tag === 'MÉDIO')
        && p.confidence >= 70);
    } else if (state.profile === 'aggressive') {
      out = out.filter((p) => p.confidence >= 50);
    }
    if (state.minConfidence) out = out.filter((p) => p.confidence >= state.minConfidence);
    return out;
  }

  /** Carrega snapshot inicial de sinais recentes na primeira renderização. */
  async function loadInitialSignals() {
    try {
      const qs = new URLSearchParams({ limit: '100' });
      if (state.markets.size) qs.set('markets', Array.from(state.markets).join(','));
      if (state.minConfidence) qs.set('minConfidence', String(state.minConfidence));
      if (state.profile) qs.set('profile', state.profile);
      const r = await api(`/api/football/signals/board?${qs}`);
      const signals = r.signals || [];
      for (const s of signals.reverse()) {
        const id = String(s.matchId);
        const arr = state.signalsByMatch.get(id) || [];
        arr.unshift(s); arr.length = Math.min(arr.length, 5);
        state.signalsByMatch.set(id, arr);
      }
      logEvent('signals-snapshot', { count: signals.length });
      if (signals.length) bumpRuntime({ signal: true });
      else bumpRuntime({});
      updateRadarStatus();
      for (const id of state.signalsByMatch.keys()) patchSignalBadge(id);
    } catch (e) {
      console.warn('signals snapshot fail', e.message);
      logEvent('signals-snapshot-fail', { err: e.message });
    }
  }

  // ============================================================
  //  TOASTS
  // ============================================================
  function toast(kind, title, desc = '') {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = `fb-toast ${kind}`;
    el.innerHTML = `<div class="t-title">${escapeHtml(title)}</div>${desc ? `<div class="t-desc">${escapeHtml(desc)}</div>` : ''}`;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 5000);
  }

  // ============================================================
  //  DATA / FILTERS / RENDER
  // ============================================================
  /**
   * Substitui o mapa de matches com a lista mais recente do servidor.
   * - `generatedAt` (ISO ou epoch ms) vem do payload do tick e dita o
   *   horário exibido em "Última atualização".
   * - Marca `_serverMinute` / `_serverMinuteAt` em cada match para o
   *   clock local saber a partir de qual minute incrementar.
   * - Mantém matches em "encerrando" (>=120') por até 60s antes de remover.
   */
  /** Mantém jogo na UI durante grace (restart do backend / tick instável). */
  function shouldHoldVanishedMatch(m) {
    if (!m) return false;
    const now = Date.now();
    if (state.runtime.reconnectAt && (now - state.runtime.reconnectAt) < RECONNECT_GRACE_MS) {
      return true;
    }
    if (m._vanishedAt && (now - m._vanishedAt) < MATCH_VANISH_GRACE_MS) {
      return true;
    }
    return false;
  }

  function replaceMatches(list, generatedAt) {
    if (window.__ROBOTREND_DEBUG) {
      console.log('[LIVE MATCHES RECEIVED]', list?.length || 0, 'matches @', generatedAt);
    }
    const now = Date.now();
    const incoming = new Set();
    for (const m of list) {
      const id = String(m.id);
      incoming.add(id);
      const prev = state.matches.get(id);
      m._serverMinute = Number(m.minute || 0);
      m._serverMinuteAt = now;
      m._vanishedAt = 0;
      if (prev?._finishingAt) m._finishingAt = prev._finishingAt;
      state.matches.set(id, m);
    }
    // Sumiu do tick: marca _vanishedAt em vez de apagar na hora (evita lista
    // esvaziar um-a-um após npm run dev / provider instável).
    for (const [id, m] of state.matches) {
      if (incoming.has(id)) continue;
      if (m._finishingAt) continue;
      if (shouldHoldVanishedMatch(m)) {
        if (!m._vanishedAt) m._vanishedAt = now;
        continue;
      }
      state.matches.delete(id);
    }
    const anyEnriched = list.some((m) => m.enriched);
    rebuildLeagues();
    bumpLastUpdated(generatedAt);
    if (anyEnriched) state.runtime.lastEnrichedAt = Date.now();
    syncFeedMetaFromState({ source: 'replaceMatches', generatedAt });
  }

  /**
   * localClockEngine — clock visual roda a cada 1s. Atualiza:
   *   1. m.minute (LIVE) baseado em (now - _serverMinuteAt) / 60s, cap 90
   *   2. HT trava em 45, FT em 90 + marca para remover após 60s
   *   3. Contador "tick há Xs" no header
   *   4. DOM in-place do .min de cada card (sem full re-render — smooth)
   * Re-render completo só quando partida é adicionada/removida.
   */
  const FT_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'ABD', 'CANC']);
  const HT_STATUSES = new Set(['HT']);

  /**
   * Carrega base do clock no match recebido do servidor. Chamado por
   * match:upsert e match:update para que o localClockEngine saiba a
   * partir de qual minuto incrementar localmente.
   */
  function hydrateClockBase(match) {
    if (!match || typeof match !== 'object') return;
    const prev = state.matches.get(String(match.id));
    match._serverMinute = Number(match.minute || 0);
    match._serverMinuteAt = Date.now();
    if (prev?._finishingAt) match._finishingAt = prev._finishingAt;
  }

  function localClockEngine() {
    const now = Date.now();
    let needsRender = false;

    // Remove jogos que ficaram "vanished" além do grace
    for (const [id, m] of state.matches) {
      if (m._vanishedAt && !shouldHoldVanishedMatch(m)) {
        state.matches.delete(id);
        if (state.activeMatchId === id) state.activeMatchId = null;
        needsRender = true;
      }
    }

    for (const [id, m] of state.matches) {
      const status = String(m.status || '').toUpperCase();
      const prevMinute = m.minute;

      if (FT_STATUSES.has(status)) {
        m.minute = 90;
        m.flags = m.flags || {};
        m.flags.isFinished = true;
        m.flags.isLive = false;
        if (!m._finishingAt) {
          m._finishingAt = now;
          m.statusLong = m.statusLong || 'Encerrado';
        }
        if (now - m._finishingAt > 60_000) {
          state.matches.delete(id);
          if (state.activeMatchId === id) state.activeMatchId = null;
          needsRender = true;
        }
      } else if (HT_STATUSES.has(status)) {
        m.minute = 45;
        m.flags = m.flags || {};
        m.flags.isLive = true;
      } else {
        // LIVE — minuto evolui suavemente, CAP em 90 (nunca 120)
        const base = Number(m._serverMinute || 0);
        const ageMs = now - (m._serverMinuteAt || now);
        const localBump = Math.floor(ageMs / 60_000);
        m.minute = Math.min(90, base + localBump);
        m.flags = m.flags || {};
        m.flags.isLive = true;
      }

      // Patch DOM in-place se o minuto mudou (sem rerender completo)
      if (prevMinute !== m.minute) {
        const el = document.querySelector(`[data-mid="${CSS.escape(String(id))}"] .min`);
        if (el) {
          const isLive = !!m.flags?.isLive;
          el.className = `min${isLive ? ' live' : ''}`;
          el.innerHTML = `${(m.minute || 0) + "'"}<br><span style="font-size:9px;color:var(--muted);font-weight:600;letter-spacing:.1em">${(m.status || '').replace(/[<>"']/g, '')}</span>`;
        }
      }
    }

    // Contador "tick há Xs"
    const ageEl = document.getElementById('last-tick-age');
    if (ageEl) {
      const lp = state.runtime.lastPollAt;
      if (lp) {
        const sec = Math.round((Date.now() - lp) / 1000);
        ageEl.textContent = `tick há ${sec}s`;
        ageEl.style.color = sec > 30 ? 'var(--rt-red, #ef4444)' : '';
      } else {
        ageEl.textContent = 'aguardando tick…';
      }
    }

    if (needsRender) {
      rebuildLeagues();
      try { render(); } catch (_) {}
    }
  }

  function rebuildLeagues() {
    state.leagues.clear();
    for (const m of state.matches.values()) {
      const key = m.league?.id || m.league?.name || 'unknown';
      if (!state.leagues.has(key)) {
        state.leagues.set(key, { id: m.league?.id, name: m.league?.name, country: m.league?.country, flag: m.league?.flag, count: 0 });
      }
      state.leagues.get(key).count++;
    }
  }

  function getFiltered() {
    let arr = Array.from(state.matches.values());
    if (state.activeLeague) {
      arr = arr.filter((m) => (m.league?.id || m.league?.name) === state.activeLeague);
    }
    if (state.filters.search) {
      const s = state.filters.search.toLowerCase();
      arr = arr.filter((m) => (`${m.home} ${m.away}`).toLowerCase().includes(s));
    }
    // SCANNER MODE: pula filtros que dependem de enrichment ou de heurística IA.
    // Mantém só os filtros de NAVEGAÇÃO (search + league já aplicados acima).
    // O propósito do Scanner é mostrar TODOS os jogos reais.
    const isScanner = effectiveMode() === 'scanner';

    if (!isScanner && state.filters.scored === 'btts') {
      arr = arr.filter((m) => (m.score.home > 0) && (m.score.away > 0));
    }
    if (!isScanner && state.filters.scored === 'noBtts') {
      arr = arr.filter((m) => !((m.score.home > 0) && (m.score.away > 0)));
    }
    if (!isScanner && state.filters.minute) {
      const [a, b] = state.filters.minute.split('-').map(Number);
      arr = arr.filter((m) => (m.minute >= a) && (m.minute <= b));
    }
    if (!isScanner && state.filters.pressureOnly) {
      arr = arr.filter((m) => m.enriched && (m.perMinute?.pressureIndex || 0) >= 50);
    }
    if (!isScanner && state.filters.onlyFavorites) {
      arr = arr.filter((m) => state.favorites.has(String(m.id)));
    }
    if (!isScanner && state.filters.bttsNear) {
      arr = arr.filter((m) => m.enriched && isBttsNear(m));
    }

    // === RADAR MODE: só matches com signal permitido pelos filtros de mercado ===
    if (effectiveMode() === 'radar') {
      arr = arr.filter((m) => !!topSignalFor(m.id));
      // ordena por confiança do top signal desc
      arr.sort((a, b) => (topSignalFor(b.id)?.confidence || 0) - (topSignalFor(a.id)?.confidence || 0));
      return arr;
    }

    // === SCANNER MODE: zero ranking por IA. Apenas ordena por
    // liga > minuto desc para o usuário enxergar os jogos mais "ativos" primeiro.
    if (isScanner) {
      arr.sort((a, b) => {
        const la = String(a.league?.name || '').localeCompare(String(b.league?.name || ''));
        if (la !== 0) return la;
        return (b.minute || 0) - (a.minute || 0);
      });
      return arr;
    }

    // === LIVE MODE (legado): ordenação padrão (favoritos > signal forte > pressão) ===
    arr.sort((a, b) => {
      const fa = state.favorites.has(String(a.id)) ? 1 : 0;
      const fb = state.favorites.has(String(b.id)) ? 1 : 0;
      if (fb !== fa) return fb - fa;
      const sa = topSignalFor(a.id)?.confidence || 0;
      const sb = topSignalFor(b.id)?.confidence || 0;
      if (sb !== sa) return sb - sa;
      return (b.perMinute?.pressureIndex || 0) - (a.perMinute?.pressureIndex || 0);
    });
    return arr;
  }

  function isBttsNear(m) {
    const sh = m.score?.home || 0, sa = m.score?.away || 0;
    if (m.minute < 30) return false;
    if (sh > 0 && sa > 0) return false;
    if (sh === 0 && sa === 0) return false;
    const sotLosing = sh > sa ? m.stats?.shotsOnTarget?.away : m.stats?.shotsOnTarget?.home;
    return (sotLosing || 0) >= 3;
  }

  function render() {
    renderKpis();
    renderLeagues();
    renderMatches();
    renderPollerMeta();
    updateRadarStatus();
    renderModeMeta();
    // Esconde toolbar de filtros antigos no modo signals (radar usa só barra superior)
    const tb = document.querySelector('.fb-toolbar');
    if (tb) tb.style.display = state.mode === 'signals' ? 'none' : '';
    // Esconde controles IA da radar-bar quando estamos em SCANNER
    const bar = document.getElementById('radar-bar');
    if (bar) bar.classList.toggle('scanner-mode', effectiveMode() === 'scanner');
  }

  /**
   * Atualiza a barra de meta logo abaixo dos botões de modo:
   *   📡 SCANNER · 87 recebidos · 87 exibidos · 0 filtrados · provider: sofascore
   *   🎯 SINAIS  · 87 recebidos · 12 exibidos · 75 filtrados pela IA · provider: sofascore
   *
   * Lê `state.runtime.feedMeta` (vem do backend) e dos contadores locais.
   */
  function renderModeMeta() {
    const bar = document.getElementById('fb-mode-meta');
    if (!bar) return;
    syncFeedMetaFromState({ source: 'renderModeMeta' });
    const meta = state.runtime.feedMeta || {};
    const rt = state.runtime;

    // TEMP DEBUG (remove após validação): mostra estado real no console
    if (window.__ROBOTREND_DEBUG) {
      console.log('FEED META', meta);
      console.log('MODE', state.mode, '· rawMatches=', rt.rawMatchesCount);
    }

    // Totais: o backend manda totalReceived (raw do poller, antes de qualquer
    // filtro UI). Se chegou em zero/null OU o state local tem mais matches
    // (caso do socket que não traz meta), usamos o tamanho do state.matches.
    const totalReceived = Math.max(
      Number(meta.totalReceived) || 0,
      rt.rawMatchesCount || 0,
    );
    let shown, filteredLabel;
    if (effectiveMode() === 'signals') {
      shown = rt.visibleSignalsCount;
      filteredLabel = `${Math.max(0, rt.rawMatchesCount - shown)} filtrados pela IA`;
    } else if (effectiveMode() === 'radar') {
      shown = rt.filteredMatchesCount;
      filteredLabel = `${Math.max(0, totalReceived - shown)} filtrados`;
    } else {
      // scanner: shown = total exibido após filtros de navegação (search/league)
      shown = typeof getFiltered === 'function' ? getFiltered().length : totalReceived;
      filteredLabel = `${Math.max(0, totalReceived - shown)} ocultos`;
    }

    const label = effectiveMode() === 'scanner' ? `📡 SCANNER · ${totalReceived} jogo${totalReceived === 1 ? '' : 's'} ao vivo`
                : effectiveMode() === 'signals' ? '🎯 SINAIS IA · apenas operáveis'
                : '📈 RADAR · jogos quentes';

    const provider = meta.provider || '—';
    const filteredOut = Math.max(0, totalReceived - shown);
    document.getElementById('meta-mode-label').textContent = label;
    document.getElementById('meta-total').textContent = String(totalReceived);
    document.getElementById('meta-shown').textContent = String(shown);
    document.getElementById('meta-filtered').textContent = String(filteredOut);
    document.getElementById('meta-provider').textContent = provider;

    // Tooltips ricos com breakdown por source
    const breakdownEl = document.getElementById('meta-source-breakdown');
    const breakdownSep = document.getElementById('meta-source-sep');
    if (meta.bySource && Object.keys(meta.bySource).length > 1) {
      // Mais de 1 provider = mostrar breakdown inline (modo agregado ou múltiplas fontes)
      const sourceText = Object.entries(meta.bySource)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}: ${v}`).join(' · ');
      document.getElementById('meta-provider').title = `Fontes ativas — ${sourceText}`;
      if (breakdownEl) {
        breakdownEl.innerHTML = Object.entries(meta.bySource)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `<span class="fb-src-chip" data-src="${escapeHtml(k)}">${escapeHtml(k)} <strong>${v}</strong></span>`)
          .join(' ');
        breakdownEl.hidden = false;
        if (breakdownSep) breakdownSep.hidden = false;
      }
    } else {
      if (breakdownEl) breakdownEl.hidden = true;
      if (breakdownSep) breakdownSep.hidden = true;
    }

    // Top ligas com mais jogos ao vivo (vem do backend em meta.topLeagues)
    const leaguesEl = document.getElementById('meta-top-leagues');
    const leaguesSep = document.getElementById('meta-leagues-sep');
    if (Array.isArray(meta.topLeagues) && meta.topLeagues.length && effectiveMode() === 'scanner') {
      const top5 = meta.topLeagues.slice(0, 5);
      if (leaguesEl) {
        leaguesEl.innerHTML = '🏆 ' + top5
          .map((l) => `<span class="fb-league-chip" title="${escapeHtml(l.name)} — ${l.count} ao vivo">${escapeHtml((l.name || '').slice(0, 18))} <strong>${l.count}</strong></span>`)
          .join(' ');
        leaguesEl.hidden = false;
        if (leaguesSep) leaguesSep.hidden = false;
      }
    } else {
      if (leaguesEl) leaguesEl.hidden = true;
      if (leaguesSep) leaguesSep.hidden = true;
    }

    // Aviso de safe-mode (provider em modo cacheado / breaker aberto)
    const warn = document.getElementById('meta-warn');
    if (meta.safeMode) {
      warn.hidden = false;
      warn.textContent = '⚠ safe-mode (dados cacheados)';
    } else if (effectiveMode() === 'signals' && rt.signalsCount === 0 && rt.enrichedMatchesCount > 0) {
      warn.hidden = false;
      warn.textContent = '⚠ nenhum sinal acima do threshold — tente reduzir confiança';
    } else {
      warn.hidden = true;
    }

    bar.hidden = false;
    bar.classList.toggle('scanner', effectiveMode() === 'scanner');

    // Tooltip rico explicando o número de filtrados conforme o modo
    const filteredEl = document.getElementById('meta-filtered');
    if (filteredEl?.parentElement) filteredEl.parentElement.title = filteredLabel;
  }

  function renderKpis() {
    const all = Array.from(state.matches.values());
    const n = all.length;
    $('#kpi-live').textContent = n;
    const leagues = new Set(all.map((m) => m.league?.id || m.league?.name));
    $('#kpi-live-sub').textContent = `ligas: ${leagues.size}`;

    if (!n) {
      $('#kpi-corners').textContent = '—';
      $('#kpi-goals').textContent = '0';
      $('#kpi-btts').textContent = '0%';
      return;
    }
    const enriched = all.filter((m) => m.enriched);
    let c = 0, g = 0, btts = 0;
    for (const m of all) {
      g += (m.score.home || 0) + (m.score.away || 0);
      if ((m.score.home || 0) > 0 && (m.score.away || 0) > 0) btts++;
    }
    for (const m of enriched) c += (m.stats?.corners?.total || 0);
    // Corners médios só faz sentido sobre enriched. Se 0 enriched, mostra "—".
    $('#kpi-corners').textContent = enriched.length ? (c / enriched.length).toFixed(1) : '—';
    $('#kpi-goals').textContent = (g / n).toFixed(1);
    $('#kpi-btts').textContent = Math.round((btts / n) * 100) + '%';
  }

  function renderLeagues() {
    const term = ($('#league-search')?.value || '').toLowerCase();
    const list = Array.from(state.leagues.values())
      .filter((l) => !term || (l.name || '').toLowerCase().includes(term))
      .sort((a, b) => b.count - a.count);
    const root = $('#league-list');
    if (!list.length) { root.innerHTML = '<div class="fb-empty">sem ligas</div>'; return; }
    const all = `<div class="fb-league-item ${state.activeLeague === null ? 'active' : ''}" data-lid="">
      <span>🌍 Todas</span><span class="badge">${state.matches.size}</span>
    </div>`;
    root.innerHTML = all + list.map((l) => {
      const key = l.id || l.name;
      const flag = l.flag ? `<img src="${escapeHtml(l.flag)}" style="width:14px;height:10px;margin-right:4px;border-radius:2px;vertical-align:middle">` : '';
      return `<div class="fb-league-item ${state.activeLeague === key ? 'active' : ''}" data-lid="${escapeHtml(String(key))}">
        <span title="${escapeHtml(l.country || '')}">${flag}${escapeHtml(l.name || '')}</span>
        <span class="badge">${l.count}</span>
      </div>`;
    }).join('');
    $$('#league-list .fb-league-item').forEach((el) => {
      el.addEventListener('click', () => {
        const lid = el.dataset.lid || null;
        state.activeLeague = lid && lid === String(lid) ? (lid === '' ? null : lid) : null;
        if (lid && state.socket) {
          state.socket.emit('subscribe', { type: 'league', id: lid });
        }
        renderLeagues(); renderMatches();
      });
    });
  }

  function renderMatches() {
    const root = $('#matches');

    // ============ MODO SIGNALS: SignalCards (decision board) ============
    if (effectiveMode() === 'signals') {
      return renderSignalBoard(root);
    }

    // ============ MODO LIVE/RADAR: lista tradicional de matches ============
    const arr = getFiltered();
    if (window.__ROBOTREND_DEBUG) {
      console.log('[NORMALIZED MATCHES]', state.matches.size, 'no state ·', state.mode, 'mode');
      console.log('[RENDERED MATCHES]', arr.length, 'após filtros');
    }
    if (!arr.length) {
      const totalLive = state.matches.size;
      const totalEnriched = Array.from(state.matches.values()).filter((m) => m.enriched).length;
      const filterActive = !!(state.filters.search || state.filters.scored || state.filters.minute || state.filters.pressureOnly || state.filters.onlyFavorites || state.filters.bttsNear || state.activeLeague);
      const tech = buildTechReason({ totalLive, totalEnriched, filterActive });
      const inlineMatches = totalLive ? buildInlineMatchGridHTML() : '';
      root.innerHTML = `
        <div class="fb-empty" style="text-align:center;padding:28px 16px">
          <div style="font-size:32px;margin-bottom:8px">${tech.icon}</div>
          <strong>${tech.title}</strong><br>
          <span style="opacity:.85">${tech.body}</span>
          ${tech.action ? `<br><button class="btn btn-ghost" style="margin-top:10px" onclick="document.getElementById('btn-refresh').click()">${tech.action}</button>` : ''}
        </div>
        ${inlineMatches}`;
      wireInlineMatchCards(root);
      return;
    }
    root.innerHTML = arr.map((m) => matchCardHTML(m)).join('');
    $$('#matches .fb-match').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('fav')) return;
        selectMatch(el.dataset.mid);
      });
      const fav = el.querySelector('.fav');
      fav?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleFav(el.dataset.mid);
      });
    });
  }

  /* ============================================================
     DECISION BOARD — renderiza SignalCards filtrados (modo signals)
     Não lista jogos; lista SINAIS.
     ============================================================ */
  /**
   * Modo fallback: após 10s sem enriched, libera sinais parciais e jogos raw.
   */
  function activateFallbackMode() {
    if (state.runtime.fallbackMode) return;
    if (state.runtime.enrichedMatchesCount > 0) return;
    if (state.runtime.rawMatchesCount === 0) return;
    state.runtime.fallbackMode = true;
    logEvent('fallback-mode', { matches: state.runtime.rawMatchesCount });
    for (const m of state.matches.values()) {
      if (m.enriched && Array.isArray(m.signals) && m.signals.length) continue;
      const gh = m.score?.home || 0, ga = m.score?.away || 0;
      const min = m.minute || 1;
      const total = gh + ga;
      m.enriched = true;
      m.enrichedPartial = true;
      m.signals = [
        {
          market: 'goals',
          signal: total >= 2 ? `Over 1.5 gols (${total} no placar)` : `Under 2.5 gols`,
          confidence: Math.min(65, 40 + total * 12),
          risk: 'high',
          reasoning: `Fallback local: ${gh}×${ga} aos ${min}′ (enricher não respondeu).`,
          partial: true,
          match: { id: m.id, home: m.home, away: m.away, minute: min, score: m.score },
          profile: 'balanced',
          generatedAt: Date.now(),
        },
      ];
    }
    toast('card', '⚠ Modo fallback ativo', 'Sinais parciais gerados localmente — enrichment API indisponível.');
    render();
    bumpRuntime({ enriched: true });
  }

  /**
   * Coleta sinais para o board.
   *   - cliente strict: devolve apenas os que passam em todos os filtros
   *   - master/showAll/demo: devolve TODOS os sinais com flag _filterReasons
   *     populada (vazia se passa). O caller decide rotular como
   *     LOW CONFIDENCE / FILTERED etc.
   *
   * Filtros estruturais (liga selecionada, busca, favoritos, minute) seguem
   * sempre ativos — afinal o user pediu para focar nesse subset.
   */
  function collectSignals() {
    const showAll = isShowAllActive();
    const out = [];
    const minConf = state.runtime.fallbackMode
      ? Math.min(state.minConfidence, 35)
      : state.minConfidence;
    for (const m of state.matches.values()) {
      if (!m.enriched || !Array.isArray(m.signals)) continue;
      // filtros estruturais — aplicados SEMPRE (mesmo em showAll)
      if (state.activeLeague && (m.league?.id || m.league?.name) !== state.activeLeague) continue;
      if (state.filters.search) {
        const q = state.filters.search.toLowerCase();
        if (!(`${m.home} ${m.away}`).toLowerCase().includes(q)) continue;
      }
      if (state.filters.onlyFavorites && !state.favorites.has(String(m.id))) continue;
      if (state.filters.minute) {
        const [a, b] = state.filters.minute.split('-').map(Number);
        if (!(m.minute >= a && m.minute <= b)) continue;
      }
      for (const s of m.signals) {
        const reasons = [];
        if ((s.confidence || 0) < minConf) reasons.push('confidence_low');
        if (state.markets.size) {
          const mk = s.market;
          if (mk && !state.markets.has(mk)) reasons.push('market_mismatch');
        }
        if (state.profile === 'conservative'
            && s.profile && s.profile !== 'conservative' && s.profile !== 'balanced') {
          reasons.push('profile_filtered');
        } else if (state.profile === 'aggressive' && (s.confidence || 0) < 50) {
          reasons.push('profile_filtered');
        }
        if (s.noEdge === true || (typeof s.edge === 'number' && s.edge <= 0)) reasons.push('no_edge');
        if (reasons.length && !showAll) continue;
        // Clona para não mutar estado; anexa motivo p/ badges
        out.push({ ...s, _filterReasons: reasons });
      }
    }
    out.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return out;
  }

  /**
   * Renderiza o painel de sinais (decision board).
   *   1) Master/demo/showAll → mostra TODOS os sinais coletados com badge
   *      por motivo de filtro (LOW CONFIDENCE, FILTERED, etc).
   *   2) Cliente strict → mostra apenas operáveis; quando vazio, em vez de
   *      "Selecione/aguarde", desce para um GRID DE MATCH CARDS com mini
   *      analytics (pressão, momentum, BTTS, projeções) para que o painel
   *      nunca pareça morto.
   */
  function renderSignalBoard(root) {
    const all = collectSignals();
    const totalEnriched = Array.from(state.matches.values()).filter((m) => m.enriched).length;
    const totalLive = state.matches.size;
    const showAll = isShowAllActive();

    // Header sumário do board — mostra contagem por estado quando em
    // showAll, ajudando master a entender o pipeline rapidamente.
    const operable = all.filter((s) => !s._filterReasons || !s._filterReasons.length).length;
    const filtered = all.length - operable;
    const headerHtml = (all.length || totalEnriched)
      ? `<div class="sig-board-head">
          <span class="sig-board-pill">🎯 ${operable} operáveis</span>
          ${showAll && filtered ? `<span class="sig-board-pill warn">⚠ ${filtered} abaixo do filtro</span>` : ''}
          ${totalEnriched ? `<span class="sig-board-pill ghost">${totalEnriched}/${totalLive} jogos enriquecidos</span>` : ''}
          ${isMasterRoleFb(state.role) ? `<span class="sig-board-pill master">MASTER • ver tudo</span>` : ''}
        </div>` : '';

    if (!all.length) {
      // Nada que mostrar pelo board → cai para o grid de matches inline (nunca vazio).
      const filterActive = state.markets.size > 0 || state.profile !== 'balanced' || state.minConfidence > 50;
      const techReason = buildTechReason({ totalLive, totalEnriched, filterActive });
      const inlineMatches = buildInlineMatchGridHTML();
      root.innerHTML = `
        ${headerHtml}
        <div class="sig-empty">
          <div style="font-size:32px;margin-bottom:8px">${techReason.icon}</div>
          <strong>${techReason.title}</strong><br>
          ${techReason.body}
          <br><span style="font-size:11px;opacity:.7;margin-top:6px;display:block">
            Filtro: ${state.markets.size ? Array.from(state.markets).join(' + ') : 'todos mercados'} ·
            ${state.profile} · ≥${state.minConfidence}%
          </span>
          ${techReason.action ? `<br><button class="btn btn-ghost" style="margin-top:10px" onclick="document.getElementById('btn-refresh').click()">${techReason.action}</button>` : ''}
          ${!showAll && totalEnriched ? `<br><button class="btn btn-ghost" style="margin-top:8px" onclick="window.RobotrendFB && window.RobotrendFB.setShowAll(true)">👁 Mostrar análises IA completas</button>` : ''}
        </div>
        ${inlineMatches}
      `;
      wireInlineMatchCards(root);
      return;
    }

    root.innerHTML = `
      ${headerHtml}
      <div class="sig-grid">${all.map(signalCardHTML).join('')}</div>
    `;
    $$('.sig-card', root).forEach((el) => {
      el.addEventListener('click', () => selectMatch(el.dataset.mid));
    });
  }

  /**
   * Constrói um grid inline com os match cards "leves" (mini analytics)
   * usado em duas situações:
   *   - sigBoard ficou vazio mas há matches enriquecidos
   *   - detail panel sem activeMatchId
   * Mostra: liga, score, minuto, pressão, momentum, BTTS%, top signal (se houver)
   */
  function buildInlineMatchGridHTML() {
    const matches = Array.from(state.matches.values());
    if (!matches.length) return '';
    const enriched = matches.filter((m) => m.enriched);
    // Prioriza enriquecidos com sinais, depois enriquecidos sem sinal, depois cru.
    const sorted = matches.slice().sort((a, b) => {
      const sa = (a.signals?.length || 0);
      const sb = (b.signals?.length || 0);
      if (sa !== sb) return sb - sa;
      const ea = a.enriched ? 1 : 0;
      const eb = b.enriched ? 1 : 0;
      if (ea !== eb) return eb - ea;
      const ga = (a.score?.home || 0) + (a.score?.away || 0);
      const gb = (b.score?.home || 0) + (b.score?.away || 0);
      return gb - ga;
    });
    const top = sorted.slice(0, 12);
    return `
      <div class="sig-board-head" style="margin-top:14px">
        <span class="sig-board-pill ghost">📊 Análises IA em andamento</span>
        <span class="sig-board-pill ghost">${enriched.length}/${matches.length} jogos enriquecidos</span>
      </div>
      <div class="sig-mini-grid">${top.map(miniMatchCardHTML).join('')}</div>
    `;
  }

  function wireInlineMatchCards(root) {
    $$('.sig-mini-card', root).forEach((el) => {
      el.addEventListener('click', () => selectMatch(el.dataset.mid));
    });
  }

  function miniMatchCardHTML(m) {
    const press = Math.round(m.perMinute?.pressureIndex || 0);
    const mom = m.momentum || { home: 50, away: 50 };
    const btts = Math.round(m.bttsLikelihood || 0);
    const corners = m.stats?.corners?.total ?? '—';
    const shots = m.stats?.shots?.total ?? '—';
    const top = topSignalFor(m.id);
    const sigPill = top
      ? `<span class="sig-mini-pill ok">${top.classification?.emoji || '⚡'} ${top.confidence}%</span>`
      : (m.signals?.length
          ? `<span class="sig-mini-pill warn">${m.signals.length} análise${m.signals.length > 1 ? 's' : ''} IA</span>`
          : `<span class="sig-mini-pill ghost">aguardando setup</span>`);
    return `
      <article class="sig-mini-card" data-mid="${escapeHtml(String(m.id))}">
        <header>
          <span class="lg">${escapeHtml(m.league?.name || '')}</span>
          <span class="mn">${m.minute || 0}'</span>
        </header>
        <div class="tt">
          <span class="tm">${escapeHtml(m.home || '—')}</span>
          <span class="sc">${m.score?.home ?? 0} – ${m.score?.away ?? 0}</span>
          <span class="tm rt">${escapeHtml(m.away || '—')}</span>
        </div>
        <div class="kpis">
          <div><span>Pressão</span><strong>${press}</strong></div>
          <div><span>Mom H</span><strong>${mom.home}</strong></div>
          <div><span>Mom A</span><strong>${mom.away}</strong></div>
          <div><span>BTTS</span><strong>${btts}%</strong></div>
          <div><span>Esc</span><strong>${corners}</strong></div>
          <div><span>Fin</span><strong>${shots}</strong></div>
        </div>
        <footer>${sigPill}</footer>
      </article>
    `;
  }

  /** Label humano para cada motivo de filtro emitido por collectSignals. */
  const FILTER_REASON_BADGES = {
    confidence_low:   { label: 'LOW CONFIDENCE', cls: 'low' },
    market_mismatch:  { label: 'FILTERED',       cls: 'filtered' },
    profile_filtered: { label: 'BELOW TARGET',   cls: 'filtered' },
    no_edge:          { label: 'NO EDGE',        cls: 'low' },
    invalid:          { label: 'INVALID',        cls: 'low' },
  };

  function reasonBadgesHTML(reasons) {
    if (!Array.isArray(reasons) || !reasons.length) return '';
    return reasons.map((r) => {
      const b = FILTER_REASON_BADGES[r] || { label: r.toUpperCase(), cls: 'low' };
      return `<span class="sig-reason-badge ${b.cls}" title="motivo: ${escapeHtml(r)}">${escapeHtml(b.label)}</span>`;
    }).join('');
  }

  function signalCardHTML(s) {
    const m = s.match || {};
    const markets = { corners: '🚩 CORNERS', goals: '⚽ GOALS', btts: '🤝 BTTS', cards: '🟨 CARDS' };
    const riskLabel = { low: '🟢 BAIXO', medium: '🟡 MÉDIO', high: '🔴 ALTO' };
    const projHtml = buildProjectionHTML(s);
    const reasons = Array.isArray(s._filterReasons) ? s._filterReasons : [];
    const filteredCls = reasons.length ? 'is-filtered' : '';
    const badgesHtml = reasonBadgesHTML(reasons);
    return `
      <div class="sig-card market-${s.market} ${filteredCls}" data-mid="${escapeHtml(String(m.id))}" data-market="${escapeHtml(s.market)}">
        <div class="sig-h">
          <span class="mkt">${markets[s.market] || s.market}</span>
          <span class="risk ${s.risk}">${riskLabel[s.risk] || s.risk}</span>
          <span class="conf">${s.confidence}%</span>
        </div>
        ${badgesHtml ? `<div class="sig-reason-badges">${badgesHtml}</div>` : ''}
        <div class="sig-signal">${escapeHtml(s.signal)}</div>
        <div class="sig-match">
          <span>${escapeHtml(m.home || '')} <span style="color:var(--muted)">×</span> ${escapeHtml(m.away || '')}</span>
          <span class="score">${m.score?.home ?? 0}–${m.score?.away ?? 0}</span>
          <span class="min">${m.minute || 0}'</span>
        </div>
        <div class="sig-league">${escapeHtml(m.league || '')}${m.country ? ` · ${escapeHtml(m.country)}` : ''}</div>
        ${projHtml}
        <div class="sig-reason">${escapeHtml(s.reasoning || '')}</div>
        <div class="sig-conf-bar"><div style="width:${s.confidence}%"></div></div>
      </div>`;
  }

  /**
   * Devolve mensagem técnica explicando POR QUE não há sinais.
   * Usa state.runtime.reason (vindo do backend /poller/resync) + estado local.
   */
  function buildTechReason({ totalLive, totalEnriched, filterActive }) {
    // 1) Sem matches do poller — motivo técnico do backend
    if (totalLive === 0) {
      const r = state.runtime.reason;
      if (r === 'circuit-open') {
        return { icon: '⛔', title: 'Circuit breaker aberto', body: 'API-Football instável — usando cache se houver. Aguarde reabertura automática.', action: '↻ Tentar resync' };
      }
      if (r === 'quota-exhausted') {
        return { icon: '📉', title: 'Quota diária esgotada', body: 'Plano free da API-Sports atingiu o limite (100/dia). Aguarde reset à meia-noite UTC.' };
      }
      if (r === 'poller-not-ticked-yet') {
        return { icon: '⏱', title: 'Poller ainda não rodou', body: 'O scanner está fazendo a primeira chamada à API. Aguarde alguns segundos.', action: '↻ Tentar agora' };
      }
      if (r === 'no-live-matches') {
        return { icon: '😴', title: 'Sem jogos ao vivo agora', body: 'A API não retornou nenhuma partida em andamento. Volte daqui a pouco.', action: '↻ Verificar novamente' };
      }
      if (state.runtime.conn === 'offline') {
        return { icon: '🔴', title: 'Sem conexão realtime', body: `Socket: <strong>${state.runtime.conn}</strong>. Verifique sua internet ou se o servidor está online.`, action: '↻ Tentar reconectar' };
      }
      return { icon: '⏳', title: 'Aguardando dados do servidor…', body: 'Nenhum tick recebido ainda. Verifique o painel de debug (tecla D) para detalhes.', action: '↻ Forçar sincronização' };
    }
    // 2) Há jogos mas nenhum enriquecido
    if (totalEnriched === 0) {
      return {
        icon: '⏳',
        title: 'Jogos detectados, aguardando enriquecimento',
        body: `${totalLive} partida${totalLive !== 1 ? 's' : ''} ao vivo. Abrindo automaticamente os top 5 para enriquecer stats…`,
        action: '↻ Forçar enriquecimento',
      };
    }
    // 3) Há jogos enriquecidos mas filtro bloqueia
    if (filterActive) {
      return {
        icon: '🔍',
        title: 'Filtro está bloqueando todos os sinais',
        body: `${totalEnriched}/${totalLive} jogos enriquecidos têm sinais, mas nenhum bate com o filtro atual. <strong>Relaxe os critérios</strong> ou aguarde novo setup.`,
      };
    }
    // 4) Caso geral: IA ainda não encontrou setups
    return {
      icon: '🤖',
      title: 'IA aguardando setup acionável',
      body: `${totalEnriched}/${totalLive} jogos enriquecidos. Nenhum cenário com confiança suficiente neste momento.`,
    };
  }

  /**
   * "FT" só é exibido se o status REAL da partida for FT/AET/PEN. Caso
   * contrário (jogo em andamento), os ranges são PROJEÇÕES IA — rotulamos
   * como "Projeção IA — X" para não enganar o usuário com placar fake.
   */
  function buildProjectionHTML(s) {
    const p = s.projection || {};
    const status = String(s.match?.status || '').toUpperCase().trim();
    const isReallyFT = /^(FT|AET|PEN|AWD|WO|ABD|CANC|FINISHED|MATCH FINISHED)$/i.test(status);
    const ftSuffix = isReallyFT ? 'FT' : 'IA';

    const items = [];
    const labels = isReallyFT
      ? { corners: 'Corners FT', goals: 'Gols FT', cards: 'Cartões FT' }
      : { corners: 'Projeção IA — Corners', goals: 'Projeção IA — Gols', cards: 'Projeção IA — Cartões' };

    if (p.corners) items.push(`<div class="item"><span class="lbl">${labels.corners}</span><span class="val">${escapeHtml(p.corners)}</span></div>`);
    if (p.goals)   items.push(`<div class="item"><span class="lbl">${labels.goals}</span><span class="val">${escapeHtml(p.goals)}</span></div>`);
    if (p.cards)   items.push(`<div class="item"><span class="lbl">${labels.cards}</span><span class="val">${escapeHtml(p.cards)}</span></div>`);
    if (typeof p.bttsPct === 'number') items.push(`<div class="item"><span class="lbl">BTTS prob.</span><span class="val">${p.bttsPct}%</span></div>`);
    if (typeof p.ratePerMin === 'number') items.push(`<div class="item"><span class="lbl">Ritmo/min</span><span class="val">${p.ratePerMin}</span></div>`);
    if (!items.length) return '';
    return `<div class="sig-proj" data-projection-kind="${ftSuffix}">${items.join('')}</div>`;
  }

  /**
   * Badge de qualidade da fonte (consensus engine).
   *   - verified      → 3 fontes concordam, alta certeza
   *   - partial       → ≥2 fontes concordam (pequena divergência ok)
   *   - single-source → apenas 1 fonte tem o jogo (poller só, ou scanner mode)
   *
   * Vem do backend em `match.sourceQuality`. Tooltip mostra detalhes do
   * `match.consensus` (sources que confirmaram, score, missing, modo).
   */
  function sourceQualityBadgeHTML(m) {
    const q = m.sourceQuality;
    if (!q) return '';
    const c = m.consensus || {};
    const srcList = Array.isArray(c.sources) ? c.sources.join(', ') : '-';
    const missing = Array.isArray(c.missingSources) && c.missingSources.length
      ? ` · faltou: ${c.missingSources.join(', ')}` : '';
    const score = (typeof c.score === 'number') ? ` · score ${c.score}/100` : '';
    const mode = c.mode ? ` · modo: ${c.mode}` : '';
    const tip = `Fontes confirmadas: ${srcList}${missing}${score}${mode}`;

    if (q === 'verified') {
      return `<span class="fb-src-badge verified" title="${escapeHtml(tip)}">🟢 verified</span>`;
    }
    if (q === 'partial') {
      return `<span class="fb-src-badge partial" title="${escapeHtml(tip)}">🟡 partial</span>`;
    }
    return `<span class="fb-src-badge single" title="${escapeHtml(tip)}">⚪ single-source</span>`;
  }

  function matchCardHTML(m) {
    const id = String(m.id);
    const isFav = state.favorites.has(id);
    const isActive = state.activeMatchId === id;
    const winHome = (m.score.home > m.score.away);
    const winAway = (m.score.away > m.score.home);
    const isLive = m.flags?.isLive;
    const top = topSignalFor(id);
    const sigClass = top ? (top.confidence >= 85 ? 'has-signal hot' : 'has-signal') : '';
    const sigBadge = top
      ? `<div class="fb-sig-badge" title="${escapeHtml(top.suggestion)} · ${escapeHtml(top.type)}">${top.classification?.emoji || '⚡'} ${top.confidence}%</div>`
      : '';
    const partialBadge = (m.dataQuality === 'partial')
      ? `<span class="fb-data-partial" title="Provider gratuito (${escapeHtml(m.provider || '')}) — sem stats avançadas (corners, posse, finalizações)">🟡 Dados limitados</span>`
      : '';
    const sourceBadge = sourceQualityBadgeHTML(m);
    return `
      <div class="fb-match ${isActive ? 'active' : ''} ${m.enriched ? 'enriched' : 'skeleton'} ${m.dataQuality === 'partial' ? 'partial-data' : ''} ${sigClass}" data-mid="${id}">
        ${sigBadge}
        <div class="min ${isLive ? 'live' : ''}">${fmtMin(m.minute)}<br><span style="font-size:9px;color:var(--muted);font-weight:600;letter-spacing:.1em">${escapeHtml(m.status || '')}</span></div>
        <div class="teams">
          <div class="row"><span class="name ${winHome ? 'winning' : ''}">${escapeHtml(m.home)}</span><span class="score">${m.score.home}</span></div>
          <div class="row"><span class="name ${winAway ? 'winning' : ''}">${escapeHtml(m.away)}</span><span class="score">${m.score.away}</span></div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">${escapeHtml(m.league?.name || '')} ${sourceBadge} ${partialBadge}</div>
        </div>
        <div class="stats" data-stats="${id}" title="🚩 escanteios · ⚡ ataques perigosos · 🔥 pressão · 🎯 BTTS likelihood">
          ${cardStatsHTML(m)}
        </div>
        <div class="fav ${isFav ? 'on' : ''}" title="favoritar">${isFav ? '★' : '☆'}</div>
      </div>
    `;
  }

  function cardStatsHTML(m) {
    if (!m.enriched) {
      return `<span class="muted" style="font-size:10px;color:var(--muted);font-style:italic">aguardando…</span>`;
    }
    // === MICROINDICADORES — só o essencial, contextual ===
    // 1) Mostra IA tag se há pick BEST acima do threshold do usuário e no mercado ativo
    const allPicks = m.insight?.picks || [];
    const localFiltered = filterPicksLocal(allPicks);
    const bestPick = localFiltered.find((p) => p.kind === 'best') || localFiltered[0];
    const iaTag = bestPick
      ? `<span class="fb-ia-tag" title="${escapeHtml(bestPick.reason || '')}">🧠 ${escapeHtml(bestPick.market.toUpperCase())} ${bestPick.confidence}%</span>`
      : '';

    // 2) Quando IA tag está presente, mostra 1-2 microstats relevantes ao mercado do pick
    if (bestPick) {
      const mk = bestPick.market;
      if (mk === 'corners') {
        const tot = m.stats?.corners?.total ?? 0;
        return `<span title="escanteios totais">🚩 ${tot}</span>${iaTag}`;
      }
      if (mk === 'goals' || mk === 'btts') {
        const sot = m.stats?.shotsOnTarget?.total ?? 0;
        return `<span title="chutes no alvo">🎯 ${sot}</span>${iaTag}`;
      }
      if (mk === 'cards') {
        const cy = m.stats?.cards?.yellow?.total ?? 0;
        const cr = m.stats?.cards?.red?.total ?? 0;
        return `<span title="amarelos/vermelhos">🟨 ${cy}${cr ? ` 🟥 ${cr}` : ''}</span>${iaTag}`;
      }
      // pressure ou genérico: mostra apenas a tag IA + pressão
      const press = Math.round(m.perMinute?.pressureIndex || 0);
      return `<span title="pressão IA">🔥 ${press}</span>${iaTag}`;
    }

    // 3) Sem IA tag (nenhum pick passou no filtro do usuário) → minimalista
    // Mostra apenas placar (já está nas teams) e nada mais. Layout limpo.
    return `<span style="font-size:10px;color:var(--muted)">—</span>`;
  }

  /** Atualiza UM card sem re-render geral — evita flicker no painel. */
  function patchCard(m) {
    const slot = document.querySelector(`[data-stats="${String(m.id)}"]`);
    if (slot) {
      slot.innerHTML = cardStatsHTML(m);
      const card = slot.closest('.fb-match');
      if (card) {
        card.classList.toggle('enriched', !!m.enriched);
        card.classList.toggle('skeleton', !m.enriched);
      }
    }
    // KPIs (corners médios) também precisam atualizar
    renderKpis();
  }

  function toggleFav(id) {
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    saveJSON('rt:fb:favs', Array.from(state.favorites));
    render();
  }

  function selectMatch(id) {
    state.activeMatchId = id;
    if (state.socket) {
      state.socket.emit('subscribe', { type: 'fixture', id });
      state.runtime.subsFixtures.add(id);
    }
    renderMatches();
    renderDetail();
  }

  function renderPollerMeta() {
    const p = state.poller;
    if (!p) return;
    $('#poller-meta').textContent = `poll ${p.intervalMs}ms · ${p.tracked || 0} tracked`;
  }

  // ============================================================
  //  DETAIL PANEL
  // ============================================================
  function renderDetail() {
    const root = $('#detail');
    const id = state.activeMatchId;
    if (!id) {
      // UX premium: em vez de mensagem fria, mostra um preview compacto dos
      // top jogos enriquecidos com mini stats (pressão, momentum, BTTS, top
      // sinal). O usuário clica no card → vira active e renderDetail completo.
      const matches = Array.from(state.matches.values());
      if (!matches.length) {
        root.innerHTML = `<div class="fb-empty">
          <div style="font-size:24px;margin-bottom:6px">⏳</div>
          aguardando jogos ao vivo<br>
          <span style="font-size:11px;opacity:.7">stats, timeline, IA e predictions assim que houver partida no ar</span>
        </div>`;
        return;
      }
      const grid = buildInlineMatchGridHTML();
      root.innerHTML = `
        <div class="fb-empty" style="padding:14px 6px">
          <div style="font-size:22px;margin-bottom:4px">🎯</div>
          <strong>Análises IA em tempo real</strong><br>
          <span style="font-size:11px;opacity:.75">Toque em qualquer jogo para timeline, pressão, momentum e predictions</span>
        </div>
        ${grid}`;
      wireInlineMatchCards(root);
      return;
    }
    const m = state.matches.get(String(id));
    if (!m) { root.innerHTML = `<div class="fb-empty">partida indisponível</div>`; return; }

    root.innerHTML = `
      <div class="fb-detail-h">
        <div>
          <div style="font-weight:800;font-size:14px">${escapeHtml(m.home)} <span style="color:var(--muted)">vs</span> ${escapeHtml(m.away)}</div>
          <div style="font-size:11px;color:var(--muted)">${escapeHtml(m.league?.name || '')} · ${escapeHtml(m.league?.country || '')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'JetBrains Mono',monospace;font-weight:800;font-size:22px;color:var(--text)">${m.score.home} : ${m.score.away}</div>
          <div style="font-size:11px;color:var(--brand);font-weight:700">${fmtMin(m.minute)} ${escapeHtml(m.status || '')}</div>
        </div>
      </div>

      <div class="fb-tabs">
        <button class="fb-tab ${state.detailTab === 'ia' ? 'active' : ''}" data-tab="ia">🧠 IA</button>
        <button class="fb-tab ${state.detailTab === 'stats' ? 'active' : ''}" data-tab="stats">Stats</button>
        <button class="fb-tab ${state.detailTab === 'trends' ? 'active' : ''}" data-tab="trends">Trends</button>
        <button class="fb-tab ${state.detailTab === 'timeline' ? 'active' : ''}" data-tab="timeline">Timeline</button>
        <button class="fb-tab ${state.detailTab === 'events' ? 'active' : ''}" data-tab="events">Eventos</button>
        <button class="fb-tab ${state.detailTab === 'h2h' ? 'active' : ''}" data-tab="h2h">H2H</button>
        <button class="fb-tab ${state.detailTab === 'preds' ? 'active' : ''}" data-tab="preds">Predict</button>
      </div>

      <div id="detail-tab-content"></div>
    `;
    $$('.fb-tabs .fb-tab', root).forEach((tab) => {
      tab.addEventListener('click', () => {
        state.detailTab = tab.dataset.tab;
        renderDetail();
      });
    });
    renderDetailTab(m);
  }

  function statBar(label, h, a) {
    const total = (h + a) || 1;
    const ph = Math.round((h / total) * 100);
    return `
      <div class="fb-stat-bar">
        <div class="lhalf"><div class="fill" style="width:${ph}%"></div></div>
        <div class="rhalf"><div class="fill" style="width:${100 - ph}%"></div></div>
      </div>
      <div class="fb-stat-row"><div class="l">${h}</div><div class="lbl">${escapeHtml(label)}</div><div class="r">${a}</div></div>
    `;
  }

  function renderDetailTab(m) {
    const root = $('#detail-tab-content');
    if (state.detailTab === 'ia') {
      return renderInsightTab(m, root);
    }
    if (state.detailTab === 'stats') {
      if (!m.enriched || !m.stats) {
        root.innerHTML = `<div class="fb-skeleton" style="padding:20px;text-align:center">
          <span class="fb-spinner"></span>
          <div style="margin-top:12px;color:var(--muted);font-size:12px">carregando estatísticas…</div>
          <div style="margin-top:4px;color:var(--muted);font-size:10px;opacity:.7">
            cada fixture custa 2 calls da API • cache 30min
          </div>
        </div>`;
        return;
      }
      const mom = m.momentum || { home: 50, away: 50 };
      const btts = Math.round(m.bttsLikelihood || 0);
      root.innerHTML =
        statBar('Posse',           m.stats.possession.home, m.stats.possession.away) +
        statBar('Escanteios',      m.stats.corners.home,    m.stats.corners.away) +
        statBar('Chutes',          m.stats.shots.home,      m.stats.shots.away) +
        statBar('No alvo',         m.stats.shotsOnTarget.home, m.stats.shotsOnTarget.away) +
        statBar('Ataques perig.',  m.stats.dangerousAttacks.home, m.stats.dangerousAttacks.away) +
        statBar('Ataques',         m.stats.attacks.home,    m.stats.attacks.away) +
        statBar('Amarelos',        m.stats.cards.yellow.home, m.stats.cards.yellow.away) +
        statBar('Vermelhos',       m.stats.cards.red.home,    m.stats.cards.red.away) +
        statBar('Momentum',        mom.home,                mom.away) +
        `<div style="margin-top:10px;padding:10px;background:var(--surface);border-radius:8px;font-size:11px;color:var(--muted)">
          <strong style="color:var(--text)">🔥 Pressão IA:</strong> ${(m.perMinute?.pressureIndex || 0).toFixed(1)}<br>
          <strong style="color:var(--text)">🚩 Escanteios/min:</strong> ${(m.perMinute?.corners || 0).toFixed(3)}<br>
          <strong style="color:var(--text)">🎯 Chutes/min:</strong> ${(m.perMinute?.shots || 0).toFixed(3)}<br>
          <strong style="color:var(--text)">🟰 BTTS likelihood:</strong> ${btts}%<br>
          <span style="opacity:.6">atualizado ${m.enrichedAt ? new Date(m.enrichedAt).toLocaleTimeString() : '—'}</span>
        </div>`;
    } else if (state.detailTab === 'trends') {
      root.innerHTML = `<div id="trends-container">
        <div class="fb-empty"><span class="fb-spinner"></span> carregando histórico…</div>
      </div>`;
      loadTrends(m).catch(() => { $('#trends-container').innerHTML = '<div class="fb-empty">sem histórico ainda</div>'; });
    } else if (state.detailTab === 'timeline') {
      root.innerHTML = `<div id="timeline-container">
        <div class="fb-empty"><span class="fb-spinner"></span> carregando timeline…</div>
      </div>`;
      loadTimeline(m).catch(() => { $('#timeline-container').innerHTML = '<div class="fb-empty">sem timeline</div>'; });
    } else if (state.detailTab === 'events') {
      root.innerHTML = `<div id="events-container">
        <div class="fb-empty"><span class="fb-spinner"></span> carregando eventos…</div>
      </div>`;
      api(`/api/football/fixtures/${m.fixtureId}/events`).then((r) => {
        const evs = r.response || r.events || [];
        if (!evs.length) return $('#events-container').innerHTML = '<div class="fb-empty">sem eventos ainda</div>';
        $('#events-container').innerHTML = `<div class="fb-timeline">${evs.map((e) => `
          <div class="fb-tl-row">
            <div class="min">${e.time?.elapsed ?? '-'}'</div>
            <div class="icon">${eventEmoji(e.type)}</div>
            <div class="desc"><strong>${escapeHtml(e.team?.name || '')}</strong> — ${escapeHtml(e.player?.name || e.detail || '')}</div>
          </div>
        `).join('')}</div>`;
      }).catch(() => { $('#events-container').innerHTML = '<div class="fb-empty">erro ao carregar eventos</div>'; });
    } else if (state.detailTab === 'h2h') {
      const t1 = m.teams?.home?.id, t2 = m.teams?.away?.id;
      root.innerHTML = `<div id="h2h-container"><div class="fb-empty"><span class="fb-spinner"></span> carregando…</div></div>`;
      if (!t1 || !t2) { $('#h2h-container').innerHTML = '<div class="fb-empty">IDs indisponíveis</div>'; return; }
      api(`/api/football/h2h?team1=${t1}&team2=${t2}&last=10`).then((r) => {
        const items = r.fixtures || [];
        if (!items.length) return $('#h2h-container').innerHTML = '<div class="fb-empty">sem H2H</div>';
        $('#h2h-container').innerHTML = items.slice(0, 8).map((fx) => `
          <div class="fb-tl-row" style="grid-template-columns:60px 1fr 60px">
            <div class="min" style="font-size:10px">${(fx.kickoffAt || fx.date || '').slice(0,10)}</div>
            <div class="desc"><strong>${escapeHtml(fx.home)}</strong> ${fx.score?.home}-${fx.score?.away} <strong>${escapeHtml(fx.away)}</strong></div>
            <div class="min" style="font-size:10px;color:var(--muted);text-align:right">${escapeHtml(fx.league?.name || '')}</div>
          </div>
        `).join('');
      }).catch(() => { $('#h2h-container').innerHTML = '<div class="fb-empty">erro ao carregar H2H</div>'; });
    } else if (state.detailTab === 'preds') {
      root.innerHTML = `<div id="preds-container"><div class="fb-empty"><span class="fb-spinner"></span> carregando predictions…</div></div>`;
      api(`/api/football/predictions/${m.fixtureId}`).then((r) => {
        const p = r.prediction || r.predictions?.[0];
        if (!p) return $('#preds-container').innerHTML = '<div class="fb-empty">sem predictions</div>';
        const pp = p.predictions || {};
        $('#preds-container').innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
            <div style="text-align:center;padding:8px;background:var(--surface);border-radius:8px"><div style="font-size:10px;color:var(--muted)">CASA</div><div style="font-family:JetBrains Mono;font-weight:800">${pp.percent?.home || '-'}</div></div>
            <div style="text-align:center;padding:8px;background:var(--surface);border-radius:8px"><div style="font-size:10px;color:var(--muted)">EMPATE</div><div style="font-family:JetBrains Mono;font-weight:800">${pp.percent?.draw || '-'}</div></div>
            <div style="text-align:center;padding:8px;background:var(--surface);border-radius:8px"><div style="font-size:10px;color:var(--muted)">FORA</div><div style="font-family:JetBrains Mono;font-weight:800">${pp.percent?.away || '-'}</div></div>
          </div>
          ${pp.advice ? `<div style="padding:10px;background:var(--brand-soft);border-radius:8px;font-size:12px"><strong>Dica IA:</strong> ${escapeHtml(pp.advice)}</div>` : ''}
          ${pp.under_over ? `<div style="margin-top:8px;font-size:11px;color:var(--muted)">Over/Under: <strong style="color:var(--text)">${escapeHtml(pp.under_over)}</strong></div>` : ''}
          ${pp.win_or_draw !== undefined ? `<div style="font-size:11px;color:var(--muted)">Win or draw: <strong style="color:var(--text)">${pp.win_or_draw ? 'sim' : 'não'}</strong></div>` : ''}
        `;
      }).catch(() => { $('#preds-container').innerHTML = '<div class="fb-empty">erro ao carregar predictions</div>'; });
    }
  }

  function eventEmoji(t) {
    const s = String(t || '').toLowerCase();
    if (s.includes('goal')) return '⚽';
    if (s.includes('card')) return '🟨';
    if (s.includes('subst')) return '🔄';
    if (s.includes('var')) return '📺';
    return '•';
  }

  // ============================================================
  //  IA INSIGHT TAB — leitura do jogo + picks recomendados
  // ============================================================
  const TREND_LABEL = {
    goals:     { low: 'Baixa',    mid: 'Média',       high: 'Alta' },
    corners:   { low: 'Baixa',    mid: 'Média',       high: 'Alta' },
    intensity: { weak: 'Travado', balanced: 'Equilibrado', high: 'Intenso' },
    moment:    { control: 'Controle', attack: 'Pressão', 'final-pressure': 'Final de jogo' },
  };
  const PICK_KIND_LABEL = {
    best:         'Melhor entrada',
    alt:          'Alternativa',
    aggressive:   'Agressivo',
    conservative: 'Conservador',
  };

  function renderInsightTab(m, root) {
    if (!m.enriched || !m.insight) {
      root.innerHTML = `
        <div class="fb-skeleton" style="padding:24px;text-align:center">
          <span class="fb-spinner"></span>
          <div style="margin-top:12px;color:var(--muted);font-size:12px">
            preparando leitura IA…
          </div>
          <div style="margin-top:6px;color:var(--muted);font-size:10px;opacity:.7">
            necessário enrichment (statistics + events) — pode levar alguns segundos
          </div>
        </div>`;
      if (m.fixtureId) {
        api(`/api/football/fixture/${m.fixtureId}/insight`)
          .then((r) => { if (r.insight) { state.matches.get(String(m.id)).insight = r.insight; renderDetailTab(state.matches.get(String(m.id))); } })
          .catch(() => {});
      }
      return;
    }
    const ins = m.insight;
    const visiblePicks = filterPicksLocal(ins.picks || []);
    const allCount = (ins.picks || []).length;
    const filterActive = state.markets.size > 0 || state.profile !== 'balanced' || state.minConfidence > 50;
    const filterHint = filterActive
      ? `<span style="font-size:10px;color:var(--muted);font-weight:600;margin-left:auto">
          filtro: ${state.markets.size ? Array.from(state.markets).join('+') : 'todos'} · ${state.profile} · ≥${state.minConfidence}%
        </span>`
      : '';

    root.innerHTML = `
      ${ins.summary ? `<div class="ia-summary"><strong>🧠 Leitura IA:</strong> ${escapeHtml(ins.summary)}</div>` : ''}

      <div class="ia-trends">
        ${trendChip('⚽ Tendência de gols',    ins.trends.goals,     TREND_LABEL.goals)}
        ${trendChip('🚩 Tendência escanteios', ins.trends.corners,   TREND_LABEL.corners)}
        ${trendChip('⚔️ Ritmo do jogo',        ins.trends.intensity, TREND_LABEL.intensity)}
        ${trendChip('⏱ Momento',               ins.trends.moment,    TREND_LABEL.moment)}
      </div>

      <div class="ia-reads">
        ${ins.reads.map((r) => `
          <div class="ia-read">
            <span class="ic">${escapeHtml(r.icon || '•')}</span>
            <span>${escapeHtml(r.text)}</span>
          </div>
        `).join('')}
      </div>

      <div class="ia-picks-h" style="display:flex;align-items:center;gap:8px">
        <span>📊 Decisão sugerida</span>${filterHint}
      </div>

      ${visiblePicks.length
        ? visiblePicks.slice(0, 3).map(pickCardHTML).join('')
        : `<div class="fb-empty" style="padding:16px">
            ${filterActive
              ? `Nenhum sinal bate com o filtro ativo. ${allCount > 0 ? `(${allCount} sinal${allCount > 1 ? 'is' : ''} disponível${allCount > 1 ? 'is' : ''} — relaxe o filtro para ver)` : ''}`
              : 'Sem sinais com confiança suficiente ainda.'}
          </div>`}

      <div class="ia-disclaimer">
        ⚠ Análise estatística automática — não é recomendação financeira. Avalie risco antes de operar.
      </div>
    `;
  }

  function trendChip(label, value, dict) {
    const text = (dict && dict[value]) || value || '—';
    return `<div class="ia-trend">
      <span class="lbl">${escapeHtml(label)}</span>
      <span class="val ${escapeHtml(value || '')}">${escapeHtml(text)}</span>
    </div>`;
  }

  function pickCardHTML(p) {
    return `<div class="ia-pick ${escapeHtml(p.kind)}">
      <span class="kind">${escapeHtml(PICK_KIND_LABEL[p.kind] || p.kind)}</span>
      <div class="body">
        <div class="lbl">${escapeHtml(p.label)}</div>
        <div class="rsn">${escapeHtml(p.reason || '')}</div>
      </div>
      <div class="meta">
        <div class="conf">${p.confidence}%</div>
        <div class="risk">${escapeHtml(p.risk?.emoji || '')} ${escapeHtml(p.risk?.tag || '')}</div>
      </div>
    </div>`;
  }

  async function loadTrends(m) {
    const r = await api(`/api/football/history/${m.fixtureId}/snapshots?limit=120`);
    const snaps = r.snapshots || [];
    if (!snaps.length) { $('#trends-container').innerHTML = '<div class="fb-empty">sem histórico</div>'; return; }
    const press = snaps.map((s) => Number(s.pressure_idx || s.pressureIdx || 0));
    const corners = snaps.map((s) => Number((s.corners_home || s.cornersHome || 0) + (s.corners_away || s.cornersAway || 0)));
    const goals = snaps.map((s) => Number((s.score_home || s.scoreHome || 0) + (s.score_away || s.scoreAway || 0)));
    $('#trends-container').innerHTML = `
      <div class="fb-panel-h" style="margin-top:0">🔥 Pressão</div>
      ${sparkline(press, '#22c55e')}
      <div class="fb-panel-h" style="margin-top:14px">🚩 Escanteios (acumulado)</div>
      ${sparkline(corners, '#facc15')}
      <div class="fb-panel-h" style="margin-top:14px">⚽ Gols (acumulado)</div>
      ${sparkline(goals, '#06b6d4')}
    `;
  }

  function sparkline(values, color = '#22c55e') {
    if (!values.length) return '<div class="fb-empty">sem dados</div>';
    const w = 340, h = 60, pad = 4;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const stepX = (w - pad * 2) / Math.max(1, values.length - 1);
    const pts = values.map((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const fill = `${pts[0].split(',')[0]},${h} ${pts.join(' ')} ${pts[pts.length-1].split(',')[0]},${h}`;
    return `
      <svg viewBox="0 0 ${w} ${h}" class="fb-trend-chart" preserveAspectRatio="none">
        <polygon points="${fill}" fill="${color}" opacity="0.15"/>
        <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace">
        <span>min: ${min.toFixed(1)}</span><span>max: ${max.toFixed(1)}</span>
      </div>
    `;
  }

  async function loadTimeline(m) {
    const r = await api(`/api/football/history/${m.fixtureId}/snapshots?limit=200`);
    const snaps = r.snapshots || [];
    const evR = await api(`/api/football/history/${m.fixtureId}/events?limit=200`).catch(() => ({ events: [] }));
    const events = evR.events || [];
    if (!snaps.length && !events.length) { $('#timeline-container').innerHTML = '<div class="fb-empty">sem timeline</div>'; return; }
    // Mistura snapshots em "marcos" (apenas mudanças significativas) + eventos
    const rows = [];
    let lastScore = '0-0', lastCorners = 0;
    for (const s of snaps) {
      const sc = `${s.score_home || 0}-${s.score_away || 0}`;
      const c = (s.corners_home || 0) + (s.corners_away || 0);
      if (sc !== lastScore) {
        rows.push({ min: s.minute, icon: '⚽', desc: `<strong>Placar:</strong> ${sc}` });
        lastScore = sc;
      }
      if (c > lastCorners) {
        rows.push({ min: s.minute, icon: '🚩', desc: `<strong>Escanteios:</strong> ${c} total` });
        lastCorners = c;
      }
    }
    for (const e of events) {
      rows.push({ min: e.minute || 0, icon: eventEmoji(e.kind), desc: `<strong>${escapeHtml(e.kind)}</strong> ${escapeHtml(e.side || '')}` });
    }
    rows.sort((a, b) => (a.min || 0) - (b.min || 0));
    if (!rows.length) { $('#timeline-container').innerHTML = '<div class="fb-empty">sem variações ainda</div>'; return; }
    $('#timeline-container').innerHTML = `<div class="fb-timeline">${rows.map((r) => `
      <div class="fb-tl-row">
        <div class="min">${r.min}'</div>
        <div class="icon">${r.icon}</div>
        <div class="desc">${r.desc}</div>
      </div>
    `).join('')}</div>`;
  }

  // ============================================================
  //  TOOLBAR / FILTERS
  // ============================================================
  function bindToolbar() {
    $('#search').addEventListener('input', (e) => { state.filters.search = e.target.value; renderMatches(); });
    $('#filter-scored').addEventListener('change', (e) => { state.filters.scored = e.target.value; renderMatches(); });
    $('#filter-minute').addEventListener('change', (e) => { state.filters.minute = e.target.value; renderMatches(); });
    $('#league-search').addEventListener('input', () => renderLeagues());

    $$('.fb-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const t = chip.dataset.chip;
        chip.classList.toggle('on');
        if (t === 'pressure')    state.filters.pressureOnly = chip.classList.contains('on');
        if (t === 'favorites')   state.filters.onlyFavorites = chip.classList.contains('on');
        if (t === 'goal-near')   state.filters.bttsNear = chip.classList.contains('on');
        renderMatches();
      });
    });

    $('#btn-refresh').addEventListener('click', () => doRefresh());
  }

  /**
   * Refresh estrutural:
   *   1. Spinner visual no botão
   *   2. Chama /poller/resync (público) — pega snapshot atualizado do poller
   *   3. Re-subscreve sockets das fixtures ativas
   *   4. Carrega signals recentes
   *   5. Mostra timestamp da última atualização
   *
   * Se chegar zero matches, propaga `reason` técnico para o empty state.
   */
  /**
   * Refresh estrutural — não é cosmético. Executa em ordem:
   *   1. POST /poller/resync           (REST — snapshot atualizado)
   *   2. loadInitialSignals            (signals snapshot)
   *   3. re-emit subscribes            (sockets das fixtures ativas)
   *   4. AGUARDA match:enriched em 5s  (valida ENRICHER vivo)
   *   5. Toast com diagnóstico técnico (sucesso ou stage quebrado)
   */
  async function doRefresh() {
    const btn = $('#btn-refresh');
    if (btn) btn.classList.add('loading');
    const startedAt = Date.now();
    const sock = state.socket;
    const enrichedBefore = state.runtime.lastEnrichedAt;

    try {
      const r = await api('/api/football/poller/resync', { method: 'POST' });
      state.poller = r.poller || state.poller;
      if (Array.isArray(r.matches)) replaceMatches(r.matches, r.generatedAt);
      state.runtime.reason = r.reason || null;
      logEvent('resync', { count: r.count, reason: r.reason });
      bumpRuntime({ poll: !!r.count });

      await loadInitialSignals();

      if (sock?.connected) {
        for (const id of state.runtime.subsFixtures) {
          sock.emit('subscribe', { type: 'fixture', id });
        }
        // Se não há sub ainda, força enrich nos top 3
        if (state.runtime.subsFixtures.size === 0 && r.matches?.length) {
          const top = r.matches.slice(0, 3);
          for (const m of top) {
            sock.emit('subscribe', { type: 'fixture', id: m.id });
            state.runtime.subsFixtures.add(String(m.id));
          }
        }
        syncPrefs();
      } else {
        try { sock?.connect?.(); } catch {}
      }

      render();
      bumpLastUpdated();

      // VALIDAÇÃO: esperar match:enriched chegar em até 5s
      let enrichedArrived = false;
      const expected = sock?.connected && r.count > 0;
      if (expected) {
        enrichedArrived = await waitForEnriched(5000, enrichedBefore);
      }

      // Diagnóstico técnico — não é "tudo certo" automático
      let title = '↻ Painel sincronizado';
      let body = `${r.count || 0} jogos · ${state.runtime.subsFixtures.size} subs`;
      let accent = 'btts';
      if (!sock?.connected) {
        title = '⚠ Socket desconectado';
        body = `REST ok (${r.count} jogos) mas socket offline. Reconectando…`;
        accent = 'card';
      } else if (r.count === 0) {
        title = '⚠ Backend sem dados';
        body = `Motivo: ${r.reason || 'desconhecido'}`;
        accent = 'card';
      } else if (expected && !enrichedArrived) {
        title = '⚠ Enricher silencioso';
        body = `Socket conectado, ${r.count} jogos, mas nenhum match:enriched em 5s. Verifique fixtureEnricher.`;
        accent = 'card';
      } else if (expected && enrichedArrived) {
        body += ` · enriched em ${Date.now() - startedAt}ms ✅`;
      }
      toast(accent, title, body);
    } catch (e) {
      logEvent('resync-fail', { err: e.message });
      toast('card', '❌ Resync falhou', e.message || 'erro desconhecido');
    } finally {
      if (btn) btn.classList.remove('loading');
      checkPipelineHealth();
      renderDebugPanel();
    }
  }

  /**
   * Sintetiza `feedMeta` a partir do estado canônico (`state.matches`).
   * Usado por eventos socket (tick/upsert) que NÃO trazem o bloco meta.
   * Preserva campos já vindos do backend (provider, safeMode, bySource)
   * e só atualiza contadores. Sem isso a barra "📡 SCANNER · X recebidos"
   * fica congelada em 0 mesmo recebendo matches via WebSocket.
   */
  function syncFeedMetaFromState({ source, generatedAt } = {}) {
    const all = Array.from(state.matches.values());
    const bySource = {};
    for (const m of all) {
      const src = m.provider || m.flags?.source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }
    const prev = state.runtime.feedMeta || {};
    state.runtime.feedMeta = {
      ...prev,
      totalReceived: all.length,
      // totalAfterFilter é recalculado por renderModeMeta; manter consistência
      totalAfterFilter: prev.totalAfterFilter ?? all.length,
      filteredOut: prev.filteredOut ?? 0,
      // Atualiza bySource sempre que o socket emite (provider pode trocar entre ticks)
      bySource: Object.keys(bySource).length ? bySource : prev.bySource || {},
      provider: prev.provider || Object.keys(bySource)[0] || '—',
      lastUpdate: generatedAt || new Date().toISOString(),
      lastSource: source || 'unknown',
    };
    // Mantém state.activeProvider sincronizado para isShowAllActive()/demo.
    state.activeProvider = state.runtime.feedMeta.provider || state.activeProvider;
    if (state.activeProvider) updateShowAllButton();
    if (window.__ROBOTREND_DEBUG) {
      console.log('[FEED META synced]', source, state.runtime.feedMeta);
    }
  }

  /**
   * Refetch do feed em MODO SCANNER — bate em /api/football/scanner que
   * devolve TODOS os jogos ao vivo sem nenhum filtro IA + bloco meta com
   * provider e contadores. Usado ao alternar para o modo scanner e em
   * boot (quando o modo persistido for scanner).
   *
   * TEMP DEBUG: loga a resposta crua para facilitar diagnóstico do feed.
   */
  async function refreshScannerFeed() {
    try {
      const r = await api('/api/football/scanner');
      console.log('SCANNER RESPONSE', r);
      if (r?.meta) {
        state.runtime.feedMeta = {
          ...r.meta,
          provider: r.meta.provider?.active || '—',
          safeMode: !!r.meta.provider?.safeMode,
          bySource: r.meta.bySource || {},
          topLeagues: r.meta.topLeagues || [],
          lastUpdate: r.generatedAt,
          lastSource: 'scanner-rest',
        };
      } else {
        console.warn('SCANNER RESPONSE sem r.meta — sintetizando a partir do estado');
      }
      if (Array.isArray(r?.matches)) {
        replaceMatches(r.matches, r.generatedAt);
        bumpRuntime({ poll: true });
      }
      // Mesmo com meta vindo do backend, garante que totalReceived bate com state.matches
      syncFeedMetaFromState({ source: 'scanner-rest-sync', generatedAt: r?.generatedAt });
      console.log('FEED META', state.runtime.feedMeta);
      console.log('MODE', state.mode);
      logEvent('scanner-refresh', {
        matches: r?.matches?.length || 0,
        provider: r?.meta?.provider?.active,
      });
      render();
    } catch (e) {
      console.error('SCANNER REFRESH FAIL', e);
      logEvent('scanner-refresh-fail', { err: e.message });
    }
  }

  /**
   * Helper de console para resetar o painel — útil quando o usuário tem
   * estado antigo travado em localStorage. Use no devtools:
   *     window.__forceScanner()
   * Faz: força state.mode='scanner', limpa localStorage do modo,
   * dispara refreshScannerFeed e renderiza.
   */
  window.__forceScanner = function forceScanner() {
    try { localStorage.removeItem('rt:fb:mode'); } catch {}
    try { localStorage.setItem('rt:fb:mode', JSON.stringify('scanner')); } catch {}
    state.mode = 'scanner';
    document.querySelectorAll('.fb-mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === 'scanner');
    });
    console.log('🔄 FORÇADO modo=scanner — atualizando feed…');
    refreshScannerFeed().then(() => {
      console.log('✅ scanner refresh OK', { mode: state.mode, feedMeta: state.runtime.feedMeta });
    });
  };

  /** Aguarda lastEnrichedAt avançar (= novo evento match:enriched chegou). */
  function waitForEnriched(timeoutMs, baseline) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (state.runtime.lastEnrichedAt > baseline) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  // ============================================================
  //  RADAR BAR — bindings
  // ============================================================
  function bindRadarBar() {
    // MODE buttons (signals / scanner / radar)
    $$('.fb-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        saveJSON('rt:fb:mode', state.mode);
        $$('.fb-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
        render();
        // Modo signals: se nenhum match enriquecido, dispara enrich dos top 5 visíveis
        if (state.mode === 'signals') autoEnrichTop();
        // Modo scanner: refetch direto do endpoint /scanner (raw, sem filtros)
        if (state.mode === 'scanner') refreshScannerFeed();
      });
    });

    // MARKET chips
    function reflectChips() {
      $$('.fb-mkt-chip').forEach((c) => {
        const mk = c.dataset.mkt;
        if (mk === 'all') c.classList.toggle('active', state.markets.size === 0);
        else c.classList.toggle('active', state.markets.has(mk));
      });
    }
    reflectChips();
    $$('.fb-mkt-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const mk = chip.dataset.mkt;
        if (mk === 'all') {
          state.markets.clear();
        } else {
          if (state.markets.has(mk)) state.markets.delete(mk);
          else state.markets.add(mk);
        }
        saveJSON('rt:fb:markets', Array.from(state.markets));
        reflectChips();
        for (const id of state.matches.keys()) patchSignalBadge(id);
        syncPrefs();
        render();
      });
    });

    // PROFILE buttons (conservative / balanced / aggressive)
    function reflectProfile() {
      $$('.fb-prof-btn').forEach((b) => b.classList.toggle('active', b.dataset.prof === state.profile));
    }
    reflectProfile();
    $$('.fb-prof-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.profile = btn.dataset.prof;
        saveJSON('rt:fb:profile', state.profile);
        reflectProfile();
        syncPrefs();
        // Re-renderiza tudo: cards/badges/detalhe IA mudam conforme perfil
        for (const id of state.matches.keys()) patchSignalBadge(id);
        render();
        if (state.activeMatchId) renderDetail();
      });
    });

    // SLIDER de confiança
    const slider = $('#conf-slider');
    const lbl = $('#conf-val');
    if (slider) {
      slider.value = String(state.minConfidence);
      if (lbl) lbl.textContent = String(state.minConfidence);
      slider.addEventListener('input', (e) => {
        state.minConfidence = Number(e.target.value);
        if (lbl) lbl.textContent = String(state.minConfidence);
        saveJSON('rt:fb:minConf', state.minConfidence);
        for (const id of state.matches.keys()) patchSignalBadge(id);
        syncPrefs();
        renderMatches();
        updateRadarStatus();
        if (state.activeMatchId) renderDetail();
      });
    }

    // SHOW-ALL toggle ("Apenas operáveis" ↔ "Mostrar tudo")
    const showAllBtn = $('#btn-show-all');
    if (showAllBtn) {
      showAllBtn.addEventListener('click', () => {
        if (isMasterRoleFb(state.role) || isDemoActive()) return; // travado
        setShowAll(!state.showAll);
      });
    }
    updateShowAllButton();

    updateRadarStatus();
  }

  // ============================================================
  //  BOOT
  // ============================================================
  async function boot() {
    // Resolve role do usuário cedo — master = sempre showAll, demo idem.
    state.role = resolveCurrentRole();
    // Atualiza role quando o user-ready event chegar (cache miss inicial).
    try {
      window.RobotrendBus?.on?.('robotrend:user-ready', () => {
        const r = resolveCurrentRole();
        if (r !== state.role) {
          state.role = r;
          updateShowAllButton();
          render();
        }
      });
    } catch (_) {}

    bindToolbar();
    bindRadarBar();
    bindDebugPanel();
    updateConn('connecting', 'inicializando…');

    try {
      const r = await api('/api/football/live/panel');
      state.poller = r.poller;
      if (r.meta) state.runtime.feedMeta = {
        ...r.meta,
        provider: r.meta.provider?.active || '—',
        safeMode: !!r.meta.provider?.safeMode,
        bySource: r.meta.bySource || {},
        topLeagues: r.meta.topLeagues || [],
      };
      if (r.matches) {
        replaceMatches(r.matches, r.generatedAt);
        bumpRuntime({ poll: true });
      }
      // REST vazio → tenta resync para pegar motivo técnico
      if (!r.matches || !r.matches.length) {
        try {
          const rr = await api('/api/football/poller/resync', { method: 'POST' });
          state.runtime.reason = rr.reason || null;
          if (Array.isArray(rr.matches) && rr.matches.length) {
            replaceMatches(rr.matches, rr.generatedAt);
            bumpRuntime({ poll: true });
          }
        } catch (_) {}
      }
      logEvent('bootstrap', { matches: r.matches?.length || 0, signals: r.matches?.reduce((n, m) => n + (m.signals?.length || 0), 0) || 0 });
      bumpRuntime({ poll: true, enriched: true });
      render();
    } catch (e) {
      console.warn('bootstrap REST falhou', e);
      state.runtime.reason = 'bootstrap-failed';
      logEvent('bootstrap-fail', { err: e.message });
    }

    initSocket();
    loadInitialSignals();
    setTimeout(() => { if (state.mode === 'signals') autoEnrichTop(); }, 1500);
    // Se o usuário voltou no modo Scanner, recarrega o feed cru do /scanner
    // (e mantém um auto-refresh a cada 20s — socket cobre updates incrementais,
    // mas /scanner é a única fonte que traz o bloco meta completo: provider,
    // bySource, topLeagues, etc.)
    if (state.mode === 'scanner') {
      refreshScannerFeed();
      setInterval(() => {
        if (state.mode === 'scanner') refreshScannerFeed();
      }, 20_000);
    }

    // Pipeline health check periódico (a cada 5s)
    setInterval(() => { bumpRuntime({}); }, 5000);

    // TEMP DEBUG: liga logs SCANNER/FEED META automaticamente até validarmos
    // que o fluxo de scanner está estável. Pode desligar via:
    //   localStorage.removeItem('fbDebug'); location.reload()
    if (!window.__ROBOTREND_DEBUG && state.mode === 'scanner') {
      window.__ROBOTREND_DEBUG = true;
      console.log('🔍 SCANNER DEBUG ATIVO — verá logs SCANNER RESPONSE / FEED META / MODE.');
      console.log('💡 Para forçar reset/refresh manual: window.__forceScanner()');
    }

    // Fallback cliente: 5s sem enriched (servidor já envia minimal no panel/tick)
    setTimeout(() => {
      if (state.runtime.rawMatchesCount > 0 && state.runtime.enrichedMatchesCount === 0) {
        activateFallbackMode();
      }
    }, 5_000);

    bumpRuntime({});
  }

  // API pública mínima — usada pelos botões inline e por debug no console.
  //   window.RobotrendFB.setShowAll(true)  → libera análises IA completas
  //   window.RobotrendFB.state             → ponteiro para o estado runtime
  window.RobotrendFB = Object.freeze({
    setShowAll,
    isShowAllActive,
    isMaster: () => isMasterRoleFb(state.role),
    state,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
