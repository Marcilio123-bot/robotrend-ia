/* ============================================================
   ROBOTREND IA — DASHBOARD CLIENT
   Versão limpa SaaS: KPIs essenciais + jogos ao vivo + sinais
   ============================================================ */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  /* ---------- state ---------- */
  let lastMatches  = [];
  let lastAnalyses = [];
  let lastSignals  = [];
  let lastBetSignals = []; // bet:opportunity (corners/btts/win)

  /* ============================================================
     MATCH GUARD — filtro defensivo client-side
     ============================================================ */
  const LIVE_STATUSES_CLIENT = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
  const FINISHED_STATUSES_CLIENT = new Set(['FT', 'AET', 'PEN', 'CANC', 'PST', 'ABD', 'AWD', 'WO', 'SUSP']);

  // Defesa client-side adicional: providers reais nunca devolvem IDs com
  // prefixos sintéticos. Se algum cache antigo ou falha de pipeline injetar,
  // descartamos aqui também.
  const SYNTHETIC_ID_PREFIXES = ['demo-', 'pre-', 'test-', 'mock-', 'fake-', 'sample-'];
  function isSyntheticId(id) {
    if (id == null) return false;
    const s = String(id).toLowerCase();
    return SYNTHETIC_ID_PREFIXES.some((p) => s.startsWith(p));
  }

  function isValidMatch(m) {
    if (!m || m.id == null) return false;
    if (isSyntheticId(m.id)) return false;
    const st = String(m.status || '').toUpperCase();
    if (FINISHED_STATUSES_CLIENT.has(st)) return false;
    if (st && !LIVE_STATUSES_CLIENT.has(st)) return false;
    const t = m.kickoffAt || m.date || m.startsAt;
    if (t) {
      const ts = new Date(t).getTime();
      if (Number.isFinite(ts)) {
        const hoursAgo = (Date.now() - ts) / 3_600_000;
        if (hoursAgo > 3 || hoursAgo < -24) return false;
      }
    }
    return true;
  }
  function filterValidMatches(arr) {
    return Array.isArray(arr) ? arr.filter(isValidMatch) : [];
  }

  function matchStatsRichness(m) {
    if (!m) return 0;
    const n = (v) => Number(v) || 0;
    return (
      n(m.corners ?? m.stats?.corners?.total) +
      n(m.shots ?? m.stats?.shots?.total) +
      n(m.shotsOnTarget ?? m.stats?.shotsOnTarget?.total) +
      n(m.dangerousAttacks ?? m.stats?.dangerousAttacks?.total) +
      n(m.yellowCards ?? m.stats?.cards?.yellow?.total) +
      n(m.redCards ?? m.stats?.cards?.red?.total)
    );
  }

  function matchFreshnessTs(m) {
    return Number(m?.lastApiUpdate || m?.updatedAt || m?.lastTickAt || 0);
  }

  const STAT_MERGE_FIELDS = [
    'corners', 'dangerousAttacks', 'shots', 'shotsOnTarget', 'yellowCards', 'redCards',
  ];

  /** Placar/minuto do mais recente; stats = máximo entre as duas versões. */
  function mergeMatchRecords(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const fresher = matchFreshnessTs(incoming) >= matchFreshnessTs(existing) ? incoming : existing;
    const older = fresher === incoming ? existing : incoming;
    const out = { ...older, ...fresher };
    for (const f of STAT_MERGE_FIELDS) {
      out[f] = Math.max(Number(fresher[f] || 0), Number(older[f] || 0));
    }
    out.enriched = !!(fresher.enriched || older.enriched);
    out.enrichedPartial = matchStatsRichness(out) === 0 && !!(fresher.enrichedPartial || older.enrichedPartial);
    out.lastApiUpdate = matchFreshnessTs(fresher) >= matchFreshnessTs(older)
      ? (fresher.lastApiUpdate || fresher.updatedAt || fresher.lastTickAt)
      : (older.lastApiUpdate || older.updatedAt || older.lastTickAt);
    return out;
  }

  function mergeMatchesById(currentList, incomingList) {
    const map = new Map();
    const addAll = (arr) => {
      for (const m of arr || []) {
        if (!m || m.id == null) continue;
        const id = String(m.id);
        const existing = map.get(id);
        map.set(id, existing ? mergeMatchRecords(existing, m) : m);
      }
    };
    addAll(currentList);
    addAll(incomingList);
    return Array.from(map.values());
  }

  function mapApiMatchToDashboard(m) {
    if (!m) return null;
    const sc = m.score || { home: 0, away: 0 };
    const mapped = {
      id: String(m.fixtureId || m.id),
      home: m.home || m.teams?.home?.name || '—',
      away: m.away || m.teams?.away?.name || '—',
      league: m.league?.fullName || m.league?.name || m.league || 'Live',
      minute: Number(m.minute || m.fixture?.status?.elapsed || 0),
      status: m.status || m.fixture?.status?.short || 'LIVE',
      kickoffAt: m.kickoffAt || m.date || m.fixture?.date,
      date: m.kickoffAt || m.date,
      score: { home: Number(sc.home ?? 0), away: Number(sc.away ?? 0) },
      corners: Number(m.stats?.corners?.total ?? m.corners ?? 0),
      dangerousAttacks: Number(m.stats?.dangerousAttacks?.total ?? m.dangerousAttacks ?? 0),
      shots: Number(m.stats?.shots?.total ?? m.shots ?? 0),
      shotsOnTarget: Number(m.stats?.shotsOnTarget?.total ?? m.shotsOnTarget ?? 0),
      yellowCards: Number(m.stats?.cards?.yellow?.total ?? m.yellowCards ?? 0),
      redCards: Number(m.stats?.cards?.red?.total ?? m.redCards ?? 0),
      lastApiUpdate: m.lastApiUpdate || m.updatedAt || m.lastTickAt || null,
      enriched: !!m.enriched,
      enrichedPartial: !!m.enrichedPartial,
      provider: m.provider,
    };

    /* ============================================================
       [FRONTEND MATCH] — debug temporário. Imprime no máximo 3 matches
       a cada 30s para evitar floodar o console. Mostra o que o
       BACKEND mandou (m.stats raw) vs o que o frontend MAPEOU
       (mapped.corners, mapped.shots…). Se backend tem números mas
       mapped tem 0, o bug está nesse mapper.
       Desligue com window.__ROBOT_DEBUG_FRONTEND_MATCH = false.
       ============================================================ */
    try {
      const dbg = window.__ROBOT_DEBUG_FRONTEND_MATCH !== false;
      if (dbg) {
        window.__ROBOT_FRONT_MATCH_LOG = window.__ROBOT_FRONT_MATCH_LOG || { count: 0, ts: 0 };
        const log = window.__ROBOT_FRONT_MATCH_LOG;
        const now = Date.now();
        if (now - log.ts > 30_000) { log.ts = now; log.count = 0; }
        if (log.count < 3) {
          log.count++;
          console.log('[FRONTEND MATCH] fixtureId=' + mapped.id, {
            home: mapped.home,
            away: mapped.away,
            minute: mapped.minute,
            backendStats: m.stats || null,
            backendShortcuts: { corners: m.corners, shots: m.shots, sot: m.shotsOnTarget, dang: m.dangerousAttacks },
            frontendMapped: {
              corners: mapped.corners,
              shots: mapped.shots,
              shotsOnTarget: mapped.shotsOnTarget,
              dangerousAttacks: mapped.dangerousAttacks,
            },
            enriched: m.enriched,
            enrichedPartial: m.enrichedPartial,
          });
        }
      }
    } catch (_) { /* nunca quebrar render */ }

    return mapped;
  }

  /**
   * Mensagens técnicas (API, provider, debug) — só admin_master.
   */
  function canViewSystemMessages() {
    return window.RobotrendSystemAccess?.canViewSystemMessages?.() ?? false;
  }

  /**
   * Mostra/esconde o banner "Dados indisponíveis no momento.".
   * Clientes Free/Premium não veem avisos de API — apenas estado vazio amigável.
   */
  let dataUnavailable = false;
  function setDataUnavailableBanner(visible) {
    const banner = document.getElementById('data-unavailable-banner');
    if (!banner) return;
    if (!canViewSystemMessages()) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = visible ? '' : 'none';
  }
  async function detectFootballAvailability() {
    try {
      const r = await fetch('/api/health', { credentials: 'include' });
      if (!r.ok) return;
      const h = await r.json();
      const configured = !!h.football?.configured;
      const provider = String(h.football?.activeProvider || '').toLowerCase();
      const noRealProvider = !configured || !provider;
      dataUnavailable = noRealProvider && lastMatches.length === 0;
      setDataUnavailableBanner(dataUnavailable);
    } catch (_) { /* offline */ }
  }

  /**
   * Lê /api/football/live (cache do poller — custo zero) como fallback
   * quando o socket vem vazio. NUNCA limpa lastMatches; só substitui
   * quando o REST traz algo útil, evitando piscadas no painel.
   */
  // Motivos técnicos que representam ERRO/indisponibilidade REAL da API.
  // "no-live-matches" e "poller-warming-up" NÃO entram aqui — não são erro.
  const REAL_API_ERROR_REASONS = new Set([
    'data-unavailable', 'safe-mode', 'circuit-open', 'quota-exhausted',
  ]);

  async function loadLiveFromApi() {
    try {
      const headers = {};
      const tok = window.RobotrendAuth?.getToken?.();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      const r = await fetch('/api/football/live', { headers, credentials: 'include' });
      window.RobotrendHeartbeat?.markRestActivity('/api/football/live', r.status);

      // 1) ERRO REAL DA API — falha de transporte/HTTP (401/403/timeout/5xx).
      if (!r.ok) {
        if (!lastMatches.length) { setDataUnavailableBanner(true); renderEmptyState(); }
        return;
      }
      const data = await r.json();
      // Backend sinalizou explicitamente falha (ok:false) → erro real.
      if (data && data.ok === false) {
        if (!lastMatches.length) { setDataUnavailableBanner(true); renderEmptyState(); }
        return;
      }

      const mapped = (data.matches || []).map(mapApiMatchToDashboard).filter(Boolean);
      const safe = filterValidMatches(mapped);

      // 2) CASO NORMAL SEM JOGOS — response.ok=true e matches=[] NÃO é erro.
      //    O backend só marca REAL_API_ERROR_REASONS quando há indisponibilidade
      //    de verdade (sem chave, breaker aberto, quota zerada, safe-mode).
      if (!safe.length) {
        const isRealError = REAL_API_ERROR_REASONS.has(data?.reason);
        if (isRealError) {
          if (!lastMatches.length) { setDataUnavailableBanner(true); renderEmptyState(); }
        } else {
          // Resposta vazia legítima: API funcionando, apenas sem jogos ao vivo.
          setDataUnavailableBanner(false);
          if (!lastMatches.length) renderNoLiveGames();
        }
        return;
      }

      // 3) CASO NORMAL COM JOGOS — merge e renderiza.
      // Merge com lastMatches (socket pode ter trazido matches que o REST
      // ainda não devolveu, e vice-versa). Dedup por ID, versão mais nova vence.
      lastMatches = mergeMatchesById(lastMatches, safe);
      setText('#kpi-live', String(lastMatches.length));
      setDataUnavailableBanner(false);
      scheduleRender();
    } catch (_) { /* offline */ }
  }

  /**
   * Estado de ERRO REAL: pinta a área de matches com a mensagem de
   * indisponibilidade. Usado SOMENTE quando a API está realmente indisponível
   * (sem chave, breaker aberto, quota zerada) — NUNCA para resposta vazia.
   */
  function renderEmptyState() {
    const root = document.querySelector('#matches') || document.querySelector('[data-matches-mount]');
    if (!root) return;
    if (lastMatches.length > 0) return;
    if (!canViewSystemMessages()) {
      renderNoLiveGames();
      return;
    }
    root.innerHTML =
      '<div class="saas-card" style="text-align:center; padding:32px; opacity:.85;">' +
      '<div style="font-size:15px; font-weight:600; margin-bottom:6px;">Dados indisponíveis no momento.</div>' +
      '<div class="text-sm" style="opacity:.7;">' +
      'Aguardando resposta da API-Football. O painel atualiza automaticamente quando houver dados reais.' +
      '</div></div>';
  }

  /**
   * Estado NORMAL sem jogos: a API respondeu OK, apenas não há partidas ao
   * vivo agora. NÃO é erro — não mostra banner de indisponibilidade.
   */
  function renderNoLiveGames() {
    const root = document.querySelector('#matches') || document.querySelector('[data-matches-mount]');
    if (!root) return;
    if (lastMatches.length > 0) return;
    root.innerHTML =
      '<div class="saas-card" style="text-align:center; padding:32px; opacity:.85;">' +
      '<div style="font-size:15px; font-weight:600; margin-bottom:6px;">Nenhum jogo ao vivo no momento.</div>' +
      '<div class="text-sm" style="opacity:.7;">' +
      'Assim que uma partida ao vivo começar, ela aparece aqui automaticamente.' +
      '</div></div>';
  }

  /* ============================================================
     THEME (mantido localmente — sem botão visível no client SaaS)
     ============================================================ */
  const THEME_KEY = 'robotrend.theme';
  const html = document.documentElement;
  function initTheme() {
    html.setAttribute('data-theme', localStorage.getItem(THEME_KEY) || 'dark');
  }

  /* ============================================================
     SOUND CHIME
     ============================================================ */
  const SOUND_KEY = 'robotrend.sound';
  let audioCtx = null;
  let soundOn = localStorage.getItem(SOUND_KEY) !== '0';
  function playChime() {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [880, 1175, 1568];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain).connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = audioCtx.currentTime + i * 0.08;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        osc.start(t0);
        osc.stop(t0 + 0.35);
      });
    } catch (_) { /* silent */ }
  }

  /* ============================================================
     DESKTOP NOTIFICATIONS
     ============================================================ */
  function notify(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      try { new Notification(title, { body, silent: true }); } catch (_) {}
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  }

  /* ============================================================
     AUTH GUARD
     ============================================================ */
  if (window.RobotrendAuth) {
    const isDevHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (!RobotrendAuth.getToken() && !isDevHost) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
      return;
    }
  }

  /* ============================================================
     KPIS
     ============================================================ */
  function renderStats(stats) {
    if (!stats) return;
    setText('#kpi-live',    stats.monitored ?? '—');
    setText('#kpi-signals', stats.sent ?? '—');
    setText('#kpi-winrate', stats.winrate != null ? `${stats.winrate}%` : '—');
    setText('#kpi-winloss', `${stats.wins ?? 0}W / ${stats.losses ?? 0}L`);
    setText('#kpi-roi',     stats.roi != null ? `${stats.roi}%` : '—');
  }
  function setText(sel, v) {
    const el = $(sel); if (el) el.textContent = v;
  }

  /* ============================================================
     MATCH CARD (simplificado para cliente)
     ============================================================ */
  function levelClass(level) {
    return ({ HOT: 'hot', WARM: 'warm', COLD: 'cold', DANGER: 'danger' }[level || 'WARM']) || 'warm';
  }
  function verdictClass(v) {
    if (!v) return 'cold';
    const up = v.toUpperCase();
    if (up.includes('PRESSÃO') || up.includes('OVER') || up.includes('FORTE')) return 'hot';
    if (up.includes('FRIO') || up.includes('UNDER') || up.includes('BAIXA')) return 'warm';
    return 'cold';
  }
  function riskBadge(risk) {
    if (!risk) return '';
    const cls = `risk-${(risk.level || '').toLowerCase()}`;
    return `<span class="badge ${cls}">${risk.emoji || ''} ${risk.label || ''}</span>`;
  }
  function classBadge(c) {
    if (!c) return '';
    return `<span class="badge ${levelClass(c.level)}">${c.emoji || ''} ${c.label || ''}</span>`;
  }

  const esc = (s) => window.RobotrendSanitize?.escapeHtml(s) ?? String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  function matchCardHTML(match, a) {
    const sc = match.score || { home: 0, away: 0 };
    const locked = a?.premiumLocked || match.premiumLocked;
    const cls = a?.classification ? levelClass(a.classification.level) : 'warm';
    const sug = (!locked && a?.suggestion) ? `<div class="suggestion-pill">${esc(a.suggestion)}</div>` : '';
    const oddRisk = (a && !locked)
      ? `<div class="flex items-center gap-1.5 mt-2 flex-wrap">
           ${classBadge(a.classification)}
           ${riskBadge(a.risk)}
           ${a.odd ? `<span class="badge">~${esc(a.odd)}</span>` : ''}
         </div>`
      : '';
    // Análise ao vivo (pressão/IA/odds/sugestão) é Premium. FREE vê só o básico.
    const analysisSection = locked
      ? `<div class="verdict mt-3" style="background:var(--surface);border:1px dashed var(--border);text-align:center">
           <span>🔒 Análise IA disponível no Premium</span>
           <a href="/account.html" class="meter" style="text-decoration:none;color:var(--accent,#22c55e);font-weight:700">Upgrade</a>
         </div>`
      : `<div class="mt-3">
          <div class="flex items-center justify-between text-[11px]" style="color: var(--muted);">
            <span>Pressão</span><span style="color: var(--text)">${esc(a?.pressure ?? 0)}/100</span>
          </div>
          <div class="progress mt-1"><span style="width:${Number(a?.pressure ?? 0)}%"></span></div>
        </div>
        <div class="verdict ${verdictClass(a?.verdict)} mt-3">
          <span>${esc(a?.verdict || 'Analisando…')}</span>
          <span class="meter">IA ${esc(a?.confidence ?? 0)}%</span>
        </div>
        ${oddRisk}
        ${sug}`;
    return `
      <article class="match-card ${cls}" data-id="${esc(match.id)}" data-sig="${cardSignature(match, a)}">
        <div class="flex items-center justify-between">
          <div class="league">${esc(match.league || 'Live')}</div>
          <span class="minute">${esc(match.minute || 0)}'</span>
        </div>
        <div class="teams mt-2">
          <div class="team flex-1">${esc(match.home)}</div>
          <div class="score">${esc(sc.home)} : ${esc(sc.away)}</div>
          <div class="team text-right flex-1">${esc(match.away)}</div>
        </div>
        <div class="stats">
          <div class="stat"><div class="k">Esc</div><div class="v brand">${esc(match.corners ?? 0)}</div></div>
          <div class="stat"><div class="k">Atq+</div><div class="v">${esc(match.dangerousAttacks ?? 0)}</div></div>
          <div class="stat"><div class="k">Fin</div><div class="v">${esc(match.shots ?? 0)}</div></div>
          <div class="stat"><div class="k">Alvo</div><div class="v">${esc(match.shotsOnTarget ?? 0)}</div></div>
          <div class="stat"><div class="k">🟨</div><div class="v">${esc(match.yellowCards ?? 0)}</div></div>
          <div class="stat"><div class="k">🟥</div><div class="v">${esc(match.redCards ?? 0)}</div></div>
        </div>
        ${analysisSection}
      </article>
    `;
  }

  /**
   * Hash curto que captura todos os campos visíveis do card. Se a "signature"
   * não mudou, não re-renderizamos o card (zero DOM thrash). Isso evita
   * piscar quando o socket reemite o mesmo match sem mudanças.
   */
  function cardSignature(m, a) {
    const sc = m.score || {};
    return [
      m.minute, m.status, sc.home, sc.away,
      m.corners, m.dangerousAttacks, m.shots, m.shotsOnTarget, m.yellowCards, m.redCards,
      a?.pressure, a?.confidence, a?.verdict, a?.classification?.level,
      a?.risk?.level, a?.suggestion, a?.odd,
    ].join('|');
  }

  function renderMatches() {
    const grid = $('#matches-grid');
    if (!grid) return;

    /* ============================================================
       [STAT TRACE 6/6] front-render — invocado uma única vez por
       fixture-alvo a cada tick de render. Reporta o valor EXATO que
       será injetado no DOM (após esc() / fallbacks).
       O alvo é definido por window.__ROBOT_STAT_TRACE_ID OU pelo
       primeiro match com fixtureId (auto). Sincronize com o backend
       via /api/football/bet-signals/diag/trace/:id.
       ============================================================ */
    try {
      if (!window.__ROBOT_STAT_TRACE_RENDERED_AT) window.__ROBOT_STAT_TRACE_RENDERED_AT = 0;
      const now = Date.now();
      if (now - window.__ROBOT_STAT_TRACE_RENDERED_AT > 5000) {
        const targetId = window.__ROBOT_STAT_TRACE_ID
          || (lastMatches[0] && String(lastMatches[0].id));
        if (targetId) {
          const m = lastMatches.find((x) => String(x.id) === String(targetId));
          if (m) {
            window.__ROBOT_STAT_TRACE_RENDERED_AT = now;
            window.__ROBOT_STAT_TRACE_LAST = {
              ts: new Date().toISOString(),
              fixtureId: targetId,
              flat: {
                corners: Number(m.corners ?? 0),
                shots: Number(m.shots ?? 0),
                shotsOnTarget: Number(m.shotsOnTarget ?? 0),
                dangerousAttacks: Number(m.dangerousAttacks ?? 0),
                attacks: Number(m.attacks ?? 0),
              },
            };
            console.log(
              '[STAT TRACE 6/6] fixtureId=' + targetId + ' stage=front-render',
              window.__ROBOT_STAT_TRACE_LAST.flat
            );
            // Envia trace ao backend (best-effort) para o /diag/trace/:id consolidar
            try {
              fetch('/api/football/bet-signals/diag/trace-front', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fixtureId: targetId, flat: window.__ROBOT_STAT_TRACE_LAST.flat }),
              }).catch(() => {});
            } catch (_) { /* best-effort */ }
          }
        }
      }
    } catch (_) { /* nunca quebrar render */ }
    const safe = filterValidMatches(lastMatches);
    if (safe.length !== lastMatches.length) lastMatches = safe;
    if (!safe.length) {
      grid.innerHTML = `<div class="col-span-full saas-card saas-empty">Aguardando partidas ao vivo…</div>`;
      return;
    }
    const byId = new Map(lastAnalyses.map((a) => [a.matchId, a]));
    const incoming = new Map(safe.map((m) => [String(m.id), m]));

    // 1) remove cards de matches que sumiram
    grid.querySelectorAll('.match-card[data-id]').forEach((el) => {
      if (!incoming.has(el.dataset.id)) el.remove();
    });

    // 2) fragment para batch insert + signature check para skip de re-render
    const frag = document.createDocumentFragment();
    const tmp = document.createElement('div');
    let inserts = 0, updates = 0, skips = 0;

    for (const m of safe) {
      const analysis = byId.get(m.id);
      const sig = cardSignature(m, analysis);
      const existing = grid.querySelector(`.match-card[data-id="${CSS.escape(String(m.id))}"]`);
      if (existing && existing.dataset.sig === sig) { skips++; continue; }
      tmp.innerHTML = matchCardHTML(m, analysis);
      const fresh = tmp.firstElementChild;
      if (existing) {
        existing.className = fresh.className;
        existing.dataset.sig = sig;
        existing.innerHTML = fresh.innerHTML;
        updates++;
      } else {
        frag.appendChild(fresh);
        inserts++;
      }
    }
    if (inserts) grid.appendChild(frag);

    window.__RT_DEBUG__?.tickRender?.('match-grid');
    // Observability: emite resumo da render
    try { window.RobotrendBus?.emit('robotrend:matches-render', { inserts, updates, skips, total: safe.length }); } catch (_) {}

    // Quando há matches mas o feed de sinais ainda está vazio, repintamos
    // o painel de sinais para que ele caia no preview de análises IA
    // (anti-empty UX). Idempotente: se já há sinais, renderBetSignals
    // mantém o conteúdo atual.
    if (safe.length && !lastBetSignals.length) {
      try { renderBetSignals(); } catch (_) {}
    }
  }

  /* ============================================================
     FREE DAILY SIGNAL COUNTER — "Sinais utilizados hoje: X/limite"
     ------------------------------------------------------------
     Mostrado apenas para usuários FREE. Atualizado por:
       - evento socket 'signal:quota'
       - campo `quota` da resposta REST /api/football/bet-signals
       - /api/me/subscription (via user-state)
     ============================================================ */
  let freeQuota = { used: 0, limit: 4, remaining: 4 };
  function renderFreeCounter() {
    const el = $('#free-signal-counter');
    if (!el) return;
    // Premium/admin → ilimitado, contador oculto.
    if (isPremiumUser()) { el.style.display = 'none'; return; }
    const used = Math.min(Number(freeQuota.used || 0), Number(freeQuota.limit || 4));
    const limit = Number(freeQuota.limit || 4);
    el.textContent = `Sinais utilizados hoje: ${used}/${limit}`;
    el.style.display = '';
    // Realça quando o limite foi atingido.
    const reached = used >= limit;
    el.style.background = reached ? 'rgba(239,68,68,.14)' : 'rgba(255,181,71,.12)';
    el.style.color = reached ? '#f87171' : '#ffb547';
    el.style.borderColor = reached ? 'rgba(239,68,68,.32)' : 'rgba(255,181,71,.30)';
  }
  function updateFreeQuota(q) {
    if (!q || typeof q !== 'object') return;
    freeQuota = {
      used: Number(q.used ?? freeQuota.used ?? 0),
      limit: Number(q.limit ?? freeQuota.limit ?? 4),
      remaining: Number(q.remaining ?? freeQuota.remaining ?? 0),
    };
    renderFreeCounter();
  }

  /* ============================================================
     BET SIGNALS (corners / btts / win) — cards compactos
     ============================================================ */
  // Mercados ativos exibidos no painel (WIN/1X2 removido)
  const ALLOWED_BET_MARKETS = new Set(['btts', 'over25', 'under25', 'corners', 'cards', 'cardsUnder']);
  function marketLabel(m) {
    return ({
      corners: 'Over escanteios',
      btts: 'Ambas marcam',
      goals: 'Gols',
      over25: 'Over 2.5 gols',
      under25: 'Under 2.5 gols',
      cards: 'Over cartões',
      cardsUnder: 'Under cartões',
    }[m] || m || 'Sinal');
  }
  function marketAccent(m) {
    return ({
      corners: '#facc15',
      btts: '#06b6d4',
      goals: '#a855f7',
      over25: '#a855f7',
      under25: '#7c3aed',
      cards: '#f59e0b',
      cardsUnder: '#f97316',
    }[m] || '#14b85e');
  }

  function betSignalCardHTML(s) {
    const prob = s.probability ?? s.confidence ?? 0;
    const conf = s.confidence ?? 0;
    const odd = s.oddEstimated ?? s.odd ?? null;
    const time = s.createdAt ? new Date(s.createdAt).toLocaleTimeString('pt-BR') : '';
    const accent = marketAccent(s.market);
    const matchTxt = s.match
      ? `${s.match.home} × ${s.match.away}`
      : `${s.home || ''} × ${s.away || ''}`;
    const minute = s.match?.minute ?? s.minute ?? 0;
    const league = s.match?.leagueFull || s.leagueFull || s.match?.league || s.league || '';
    const score = s.betScore ?? s.extras?.analysisScore ?? s.analysisScore ?? null;
    const isCards = s.market === 'cards' || s.market === 'cardsUnder';
    const lines = isCards ? (s.extras?.lines || null) : null;
    const isLocked = s.locked === true;
    const cardsLinesHtml = (lines && !isLocked)
      ? `<div class="mt-3" style="background:rgba(245,158,11,.06);border-radius:6px;padding:6px 8px;">
           <div class="text-[10px] uppercase tracking-wider mb-1" style="color:var(--muted);">Probabilidades por linha</div>
           <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;text-align:center;">
             ${[2.5, 3.5, 4.5, 5.5].map((L) => {
               const ln = lines[L] || lines[String(L)] || {};
               const over = ln.over ?? 0; const under = ln.under ?? 0;
               return `<div>
                 <div class="text-[10px]" style="color:var(--muted);">${L}</div>
                 <div class="font-mono text-[10px]" style="color:#22c55e;">O ${over}%</div>
                 <div class="font-mono text-[10px]" style="color:#ef4444;">U ${under}%</div>
               </div>`;
             }).join('')}
           </div>
         </div>`
      : '';
    const isPremium = s.tier === 'premium' && !isLocked;
    const tierBadge = isPremium
      ? `<span class="badge" style="background:linear-gradient(135deg,#ffd166,#ffb547);color:#2a1a05;font-weight:900;letter-spacing:1px;">💎 PREMIUM</span>`
      : isLocked
        ? `<span class="badge" style="background:#6b728022;color:#9ca3af;border:1px solid #6b728044;">🔒 PREVIEW</span>`
        : '';
    const insightHtml = isLocked
      ? `<div class="mt-3 text-[11px]" style="color: #ffb547; line-height:1.5;background:rgba(255,181,71,.08);padding:8px 10px;border-radius:6px;border-left:2px solid #ffb547;">
           🔒 ${s.justification || 'Análise completa disponível no Premium.'}
           <a href="#" onclick="window.virarPremium();event.preventDefault();" style="color:#ffb547;font-weight:700;text-decoration:underline;">Escolher plano Premium →</a>
         </div>`
      : (s.premiumInsight || s.justification)
        ? `<div class="mt-3 text-[11px]" style="color: var(--muted); line-height:1.5;">${escapeHtml(s.premiumInsight || s.justification)}</div>`
        : '';
    return `
      <article class="saas-card" style="border-left:3px solid ${accent};${isLocked ? 'opacity:.85;' : ''}">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="badge live" style="background:${accent}22; color:${accent}; border:1px solid ${accent}44;">
              ${marketLabel(s.market)}
            </span>
            ${tierBadge}
          </div>
          <span class="text-[11px]" style="color: var(--muted); font-family: 'JetBrains Mono', monospace;">${time}</span>
        </div>
        ${isLocked ? '' : `<div class="text-sm font-bold mb-1">${escapeHtml(matchTxt)}</div>
        <div class="text-[11px] mb-3" style="color: var(--muted);">${escapeHtml(league)} · ${minute}'</div>
        <div class="text-lg font-extrabold mb-2" style="color: ${accent};">${escapeHtml(s.prediction || s.suggestion || '—')}</div>
        <div class="grid ${score != null ? 'grid-cols-4' : 'grid-cols-3'} gap-2 text-center mt-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">Prob</div>
            <div class="font-mono font-bold">${prob}%</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">IA</div>
            <div class="font-mono font-bold">${conf}%</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">Odd justa</div>
            <div class="font-mono font-bold">${odd ? '~' + odd : '—'}</div>
          </div>
          ${score != null ? `<div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">Score</div>
            <div class="font-mono font-bold">${score}</div>
          </div>` : ''}
        </div>
        ${cardsLinesHtml}`}
        ${insightHtml}
      </article>
    `;
  }

  /**
   * Renderiza o feed de sinais ao vivo. Política do painel:
   *   - Há sinais válidos → exibe top 6.
   *   - Sem sinais MAS há matches ao vivo → exibe um preview compacto
   *     com pressão/momentum/BTTS/IA% para nunca aparecer vazio.
   *   - Sem nada → ainda assim mostra "Aguardando…" (último recurso).
   */
  function renderBetSignals() {
    const host = $('#live-signals');
    if (!host) return;
    // Exibe apenas os 5 mercados ativos (filtra WIN/1X2 legado).
    const top = lastBetSignals.filter((s) => ALLOWED_BET_MARKETS.has(s?.market)).slice(0, 6);
    if (top.length) {
      host.innerHTML = top.map(betSignalCardHTML).join('');
      return;
    }
    // Sem sinais — desce para preview de análises IA inline (anti-empty UX).
    const previewMatches = filterValidMatches(lastMatches).slice(0, 6);
    if (!previewMatches.length) {
      host.innerHTML = `<div class="col-span-full saas-card saas-empty">Aguardando o próximo sinal…</div>`;
      return;
    }
    const byId = new Map(lastAnalyses.map((a) => [a.matchId, a]));
    const intro = `
      <div class="col-span-full" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:4px;">
        <span class="badge live" style="background:rgba(34,197,94,.16);color:#22c55e;border:1px solid rgba(34,197,94,.30);">
          📊 Análises IA em andamento
        </span>
        <span class="text-[11px]" style="color:var(--muted);">
          ${previewMatches.length} partida${previewMatches.length === 1 ? '' : 's'} sob monitoramento — sinais operáveis aparecerão aqui em tempo real.
        </span>
        ${isMasterUser()
          ? `<a href="/football.html" class="badge" style="margin-left:auto;background:linear-gradient(135deg,#ffd166,#ffb547);color:#2a1a05;font-weight:900;letter-spacing:1px;">
              MASTER • abrir scanner completo →
            </a>`
          : ''}
      </div>`;
    host.innerHTML = intro + previewMatches.map((m) => analysisPreviewCardHTML(m, byId.get(m.id))).join('');
  }

  /**
   * Card compacto que substitui "Aguardando sinal" quando há matches ao vivo
   * mas nenhum sinal acima do threshold. Mostra mini stats + IA% sem prometer
   * uma aposta — apenas dá a sensação de painel vivo.
   */
  function analysisPreviewCardHTML(match, a) {
    const sc = match.score || { home: 0, away: 0 };
    const locked = a?.premiumLocked || match.premiumLocked;
    if (locked) {
      return `
      <article class="saas-card" style="border-left:3px solid #06b6d4;opacity:.92;">
        <div class="flex items-center justify-between mb-2">
          <span class="badge live" style="background:rgba(6,182,212,.18); color:#06b6d4; border:1px solid rgba(6,182,212,.30);">Análise IA</span>
          <span class="text-[11px]" style="color: var(--muted); font-family:'JetBrains Mono', monospace;">${esc(match.minute || 0)}'</span>
        </div>
        <div class="text-sm font-bold mb-1">${esc(match.home)} <span style="color:var(--muted);">×</span> ${esc(match.away)}</div>
        <div class="text-[11px] mb-3" style="color: var(--muted);">${esc(match.league || 'Live')} · ${esc(sc.home)}–${esc(sc.away)}</div>
        <div class="mt-2 text-[12px]" style="color: var(--text-2); line-height:1.5; text-align:center;">
          🔒 Análise completa da IA (pressão, confiança, odds e recomendações) é <strong>Premium</strong>.
          <div style="margin-top:8px"><a href="/account.html" class="badge" style="background:var(--accent,#22c55e);color:#06210f;font-weight:800;text-decoration:none">Fazer upgrade</a></div>
        </div>
      </article>
    `;
    }
    const conf = a?.confidence ?? 0;
    const press = a?.pressure ?? 0;
    const verdict = a?.verdict || 'IA em análise…';
    return `
      <article class="saas-card" style="border-left:3px solid #06b6d4;opacity:.92;">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="badge live" style="background:rgba(6,182,212,.18); color:#06b6d4; border:1px solid rgba(6,182,212,.30);">Análise IA</span>
            <span class="badge" style="background:var(--surface-2);color:var(--muted);">monitorando</span>
          </div>
          <span class="text-[11px]" style="color: var(--muted); font-family:'JetBrains Mono', monospace;">${esc(match.minute || 0)}'</span>
        </div>
        <div class="text-sm font-bold mb-1">${esc(match.home)} <span style="color:var(--muted);">×</span> ${esc(match.away)}</div>
        <div class="text-[11px] mb-3" style="color: var(--muted);">${esc(match.league || 'Live')} · ${esc(sc.home)}–${esc(sc.away)}</div>
        <div class="grid grid-cols-4 gap-2 text-center mt-2">
          <div><div class="text-[10px]" style="color:var(--muted);">Pressão</div><div class="font-mono font-bold">${press}</div></div>
          <div><div class="text-[10px]" style="color:var(--muted);">IA</div><div class="font-mono font-bold">${conf}%</div></div>
          <div><div class="text-[10px]" style="color:var(--muted);">Esc</div><div class="font-mono font-bold">${esc(match.corners ?? 0)}</div></div>
          <div><div class="text-[10px]" style="color:var(--muted);">Fin</div><div class="font-mono font-bold">${esc(match.shots ?? 0)}</div></div>
        </div>
        <div class="mt-3 text-[11px]" style="color: var(--text-2); line-height:1.5;">
          🧠 ${esc(verdict)}
        </div>
      </article>
    `;
  }

  /* ============================================================
     ROLE GUARDS — separa MASTER (admin/owner/super_admin) de CLIENTE
     ============================================================ */
  const MASTER_ROLES_DASH = new Set(['master', 'admin', 'owner', 'super_admin']);

  function getCurrentRole() {
    try {
      const us = window.RobotrendUser?.get?.();
      if (us) return String(us.role || us.user?.role || '').toLowerCase();
      const u = window.RobotrendAuth?.getUser?.();
      return String(u?.role || '').toLowerCase();
    } catch { return ''; }
  }
  function isMasterUser() {
    return MASTER_ROLES_DASH.has(getCurrentRole());
  }

  /* ============================================================
     BEST BET — "Melhor Aposta do Momento" (PREMIUM)
     ============================================================ */
  function isPremiumUser() {
    // Master também passa neste check para que features premium funcionem
    // tecnicamente — porém o card best-bet é OCULTADO inteiro para master
    // pelo bloco master-snapshot do index.html. Mantemos true por compat.
    if (isMasterUser()) return true;
    if (window.RobotrendUser?.get?.()) return window.RobotrendUser.isPremium();
    const u = (window.RobotrendAuth?.getUser?.() || null);
    if (!u) return false;
    const role = String(u.role || '').toLowerCase();
    const plan = String(u.plan || '').toUpperCase();
    return role === 'premium'
        || plan === 'PREMIUM' || plan === 'VIP' || plan === 'PRO' || plan === 'TRIAL';
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderBestBet(signal) {
    // MASTER não vê card "Melhor Aposta" — toda a section está com display:none
    // (controlado por index.html via #master-snapshot). Saímos silenciosamente.
    if (isMasterUser()) return;

    const loading = $('#best-bet-loading');
    const card    = $('#best-bet-card');
    const locked  = $('#best-bet-locked');
    const tag     = $('#best-bet-tag');
    if (!card || !loading || !locked) return;

    if (!isPremiumUser()) {
      loading.style.display = 'none';
      card.style.display    = 'none';
      locked.style.display  = 'block';
      if (tag) { tag.textContent = '🔒 PREMIUM'; tag.style.background = 'linear-gradient(135deg,#9ca3af,#6b7280)'; tag.style.color = '#f9fafb'; }
      return;
    }

    if (!signal) {
      loading.style.display = 'block';
      card.style.display    = 'none';
      locked.style.display  = 'none';
      if (tag) tag.textContent = 'PREMIUM';
      return;
    }

    loading.style.display = 'none';
    locked.style.display  = 'none';
    card.style.display    = 'block';

    const home   = escapeHtml(signal.match?.home || signal.home);
    const away   = escapeHtml(signal.match?.away || signal.away);
    const league = escapeHtml(signal.match?.leagueFull || signal.leagueFull || signal.match?.league || signal.league || '');
    const minute = signal.match?.minute ?? signal.minute ?? '—';
    const scoreH = signal.match?.score?.home ?? '—';
    const scoreA = signal.match?.score?.away ?? '—';
    const prediction = escapeHtml(signal.prediction || signal.suggestion || '—');
    const insight    = escapeHtml(signal.premiumInsight || signal.justification || '');
    const betScore   = signal.betScore ?? signal.confidence ?? 0;
    const odd        = signal.oddEstimated ?? signal.odd ?? '—';
    const conf       = signal.confidence ?? 0;
    const prob       = signal.probability ?? 0;
    const riskLabel  = signal.risk?.label || signal.risk?.level || '—';
    const market     = signal.market ? marketLabel(signal.market) : '—';

    card.innerHTML = `
      <div class="best-bet-glow"></div>
      <div class="best-bet-active-grid">
        <div>
          <div class="best-bet-match">${market} · ${escapeHtml(league)} · ${minute}′ · ${scoreH}–${scoreA}</div>
          <div class="best-bet-teams">${home} <span style="color:var(--muted);font-weight:600;">×</span> ${away}</div>
          <div class="best-bet-prediction">🎯 ${prediction}</div>
          ${insight ? `<div class="best-bet-insight">🧠 ${insight}</div>` : ''}
        </div>
        <div class="best-bet-stats">
          <div class="best-bet-score-ring" style="--score:${betScore}">
            <span>${betScore}</span>
            <small>SCORE IA</small>
          </div>
          <div class="best-bet-meta-row">
            <div class="best-bet-meta">
              <div class="best-bet-meta-label">Confiança</div>
              <div class="best-bet-meta-value good">${conf}%</div>
            </div>
            <div class="best-bet-meta">
              <div class="best-bet-meta-label">Odd</div>
              <div class="best-bet-meta-value">${odd}</div>
            </div>
            <div class="best-bet-meta">
              <div class="best-bet-meta-label">Prob.</div>
              <div class="best-bet-meta-value">${prob}%</div>
            </div>
            <div class="best-bet-meta">
              <div class="best-bet-meta-label">Risco</div>
              <div class="best-bet-meta-value">${escapeHtml(riskLabel)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  let lastBestSignal = null;
  async function loadBestSignal() {
    if (!isPremiumUser()) {
      renderBestBet(null); // ativa o card locked
      return;
    }
    try {
      const r = await fetch('/api/football/best-signal', {
        headers: window.RobotrendAuth?.getToken()
          ? { Authorization: 'Bearer ' + window.RobotrendAuth.getToken() }
          : {},
      });
      if (r.status === 402) {
        // Token expirou ou user perdeu premium → mostra locked
        renderBestBet(null);
        return;
      }
      if (!r.ok) return;
      const data = await r.json();
      if (data.available && data.signal) {
        lastBestSignal = data.signal;
        renderBestBet(data.signal);
      } else {
        renderBestBet(null); // loading state
      }
    } catch (_) { /* offline */ }
  }

  /* ============================================================
     SIGNALS HISTORY (tabela compacta)
     ============================================================ */
  function renderSignals() {
    const body = $('#signals-body');
    if (!body) return;
    if (!lastSignals.length) {
      body.innerHTML = `<tr><td colspan="7" class="py-6 text-center" style="color:var(--muted);">Sem sinais ainda.</td></tr>`;
      return;
    }
    body.innerHTML = lastSignals.slice(0, 12).map((s) => {
      const t = s.created_at || s.createdAt;
      const time = t ? new Date(t).toLocaleTimeString('pt-BR') : '';
      const result = s.result || 'pending';
      const badge = result === 'win'
        ? `<span class="badge win">WIN</span>`
        : result === 'loss'
        ? `<span class="badge loss">LOSS</span>`
        : `<span class="badge">aguard.</span>`;
      const odd = s.payload?.odd || s.odd || s.oddEstimated;
      const home = s.match?.home || s.home || '';
      const away = s.match?.away || s.away || '';
      return `
        <tr>
          <td class="py-3 px-4 font-mono text-xs">${time}</td>
          <td class="py-3 px-4">${home} <span style="color: var(--muted);">×</span> ${away}</td>
          <td class="py-3 px-4"><span class="badge live">${s.market || '—'}</span></td>
          <td class="py-3 px-4 font-semibold">${s.suggestion || s.prediction || '—'}</td>
          <td class="py-3 px-4 font-mono">${odd ? '~' + odd : '—'}</td>
          <td class="py-3 px-4 font-mono">${s.confidence ?? 0}%</td>
          <td class="py-3 px-4">${badge}</td>
        </tr>`;
    }).join('');
  }

  /* ============================================================
     LOAD HISTORIES (REST)
     ============================================================ */
  async function loadSignals() {
    try {
      const r = await fetch('/api/signals?limit=20');
      if (!r.ok) return;
      const data = await r.json();
      lastSignals = data.signals || data || [];
      renderSignals();
    } catch (_) {}
  }
  async function loadBetSignals() {
    try {
      // Master vê o pipeline inteiro (threshold baixo) — frontend rotula
      // sinais abaixo do limite com badge. Cliente comum vê apenas
      // sinais operáveis (>=70%) como antes.
      const isMaster = isMasterUser();
      const min = isMaster ? 0 : 70;
      const limit = isMaster ? 12 : 6;
      const r = await fetch(`/api/football/bet-signals?limit=${limit}&minConfidence=${min}`);
      if (!r.ok) {
        console.warn('[LIVE SIGNAL REST] HTTP', r.status);
        return;
      }
      const data = await r.json();
      console.log('[LIVE SIGNAL REST]', { count: data?.signals?.length ?? 0, tier: data?.tier });
      if (data && data.quota) updateFreeQuota(data.quota);
      const incoming = data.signals || [];
      if (incoming.length) {
        lastBetSignals = incoming;
        renderBetSignals();
      } else if (!lastBetSignals.length) {
        renderBetSignals();
      }
    } catch (err) {
      console.error('[LIVE SIGNAL REST ERROR]', err);
    }
  }

  /* ============================================================
     TOASTS — delega para RobotrendToast (global). Mantemos pushToast
     local apenas como wrapper para não quebrar callsites antigos.
     ============================================================ */
  function pushToast({ title, body, accent, ttl }) {
    const kind = accent === 'warn'  ? 'warning'
              : accent === 'error'  ? 'error'
              : accent === 'success'? 'success'
              : 'info';
    if (window.RobotrendToast?.show) {
      // RobotrendToast escapa HTML — mas o código antigo passa <br/> em body.
      // Removemos tags e usamos texto plano. Se precisar de HTML, use opts.html
      // (não implementado por segurança).
      const plainBody = String(body || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
      return window.RobotrendToast.show({ kind, title, body: plainBody, ttl });
    }
    // Fallback (RobotrendToast não carregado): stack antigo
    const stack = $('#toast-stack'); if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'warning' ? ' warn' : kind === 'error' ? ' error' : kind === 'success' ? ' success' : '');
    el.innerHTML = `<div class="toast-title">${esc(title)}</div><div class="toast-body">${esc(String(body || '').replace(/<[^>]+>/g, ''))}</div>`;
    stack.appendChild(el);
    setTimeout(() => el.remove(), ttl || 6500);
  }

  /* ============================================================
     WS PILL
     ============================================================ */
  function setWS(state) {
    const pill = $('#ws-status');
    if (!pill) return;
    pill.classList.remove('ok', 'warn', 'err');
    if (state === 'online')      { pill.classList.add('ok');  pill.textContent = 'ao vivo'; }
    else if (state === 'pending'){ pill.classList.add('warn'); pill.textContent = 'reconectando'; }
    else                          { pill.classList.add('err'); pill.textContent = 'offline'; }
  }
  setWS('pending');

  /* ============================================================
     SOCKET.IO
     ============================================================ */
  const socket = io(window.location.origin, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity,
    timeout: 10000,
    withCredentials: true,
    auth: { token: window.RobotrendAuth?.getToken() || '' },
  });

  // Anexa wrapper resiliente: ramp-up de REST polling quando socket cai,
  // toast informativo, contador de reconnects, bridge para RobotrendBus.
  try {
    window.RobotrendConnection?.attach?.(socket, {
      offlineToastAfterMs: 8000,
      pollFallback: {
        interval: 8000,
        maxInterval: 30000,
        callback: () => { try { loadLiveFromApi(); loadBetSignals(); } catch (_) {} },
      },
    });
  } catch (_) {}

  socket.on('connect', () => {
    setWS('online');
    window.RobotrendHeartbeat?.markSocketState('online');
  });
  socket.io.on('reconnect_attempt', () => {
    setWS('pending');
    window.RobotrendHeartbeat?.markSocketState('pending');
  });
  socket.on('disconnect', () => {
    setWS('err');
    window.RobotrendHeartbeat?.markSocketState('offline');
  });

  // ====== USER UPGRADED — pagamento aprovado via webhook ======
  // Backend (payments.js webhook MP) emite isso pro userId específico
  // assim que o pagamento é confirmado APPROVED no Mercado Pago.
  //
  // Fluxo:
  //   1. Socket recebe 'user:upgraded' (instantâneo)
  //      OU
  //   2. user-state.js polling detecta isPremium=true (fallback ~10s)
  //
  // Em qualquer caso, o evento global 'robotrend:upgrade-detected'
  // garante uma única reação à mudança de plano.
  socket.on('user:upgraded', async (payload) => {
    console.info('[dashboard] socket user:upgraded', payload);
    try {
      // dispara polling imediato no user-state
      if (window.RobotrendUser?.refresh) await window.RobotrendUser.refresh({ force: true });
      // sincroniza auth-guard cache também
      if (window.RobotrendGuard?.refreshUser) await window.RobotrendGuard.refreshUser();
      // notifica outras abas
      window.RobotrendUser?.broadcastRefresh?.();
    } catch (err) {
      console.warn('[dashboard] refresh pós-upgrade falhou', err);
    }
  });

  // Resposta do suporte (admin) → encaminha para o widget de chat (support-chat.js).
  socket.on('support:reply', (payload) => {
    try {
      window.dispatchEvent(new CustomEvent('robotrend:support-reply', { detail: payload }));
    } catch (_) {}
  });

  // Reage à mudança real de plano para LIBERAR a UI (best-bet, signals).
  // O toast/modal celebratório é responsabilidade do upgrade-celebration.js
  // (que funciona em qualquer página, não só dashboard).
  window.addEventListener('robotrend:upgrade-detected', (ev) => {
    const plan = ev.detail?.plan || 'PREMIUM';
    console.info('[dashboard] upgrade detectado — destravando UI premium', plan);
    try { if (typeof loadBestSignal === 'function') loadBestSignal(); } catch (_) {}
    renderBetSignals();
    renderSignals();
  });

  let _renderQueued = false;
  function scheduleRender() {
    if (_renderQueued) return;
    _renderQueued = true;
    requestAnimationFrame(() => { _renderQueued = false; renderMatches(); });
  }

  // matches:update — socket é a fonte primária do scanner real.
  // Quando o scanner inerte emite [] (sem provider configurado), NÃO
  // limpamos o feed: deixamos o fallback REST e o banner de indisponibilidade
  // tomarem conta da UX.
  socket.on('matches:update', (m) => {
    window.RobotrendHeartbeat?.markSocketActivity('matches:update');
    const incoming = filterValidMatches(
      (m || []).map(mapApiMatchToDashboard).filter(Boolean)
    );
    if (incoming.length) {
      // Merge incremental: socket pode chegar atrasado depois de um REST e
      // não queremos sobrescrever versões mais novas do mesmo match.
      lastMatches = mergeMatchesById(lastMatches, incoming);
      setText('#kpi-live', String(lastMatches.length));
      setDataUnavailableBanner(false);
      scheduleRender();
    }
  });
  socket.on('analyses:update', (a) => {
    window.RobotrendHeartbeat?.markSocketActivity('analyses:update');
    lastAnalyses = a || [];
    scheduleRender();
  });
  socket.on('stats:update', (s) => {
    window.RobotrendHeartbeat?.markSocketActivity('stats:update');
    renderStats(s);
  });
  socket.on('signals:list', (l) => {
    window.RobotrendHeartbeat?.markSocketActivity('signals:list');
    console.log('[LIVE SIGNAL SOCKET] signals:list (histórico DB)', Array.isArray(l) ? l.length : 0);
    lastSignals = l || [];
    renderSignals();
  });

  // Contador diário do FREE ("X/limite") — emitido no connect e a cada sinal.
  socket.on('signal:quota', (q) => {
    window.RobotrendHeartbeat?.markSocketActivity('signal:quota');
    updateFreeQuota(q);
  });

  // Snapshot inicial do betSignalEngine ao conectar (painel #live-signals).
  socket.on('bet-signals:list', (signals) => {
    window.RobotrendHeartbeat?.markSocketActivity('bet-signals:list');
    console.log('[LIVE SIGNAL SOCKET] bet-signals:list', Array.isArray(signals) ? signals.length : signals);
    if (!Array.isArray(signals) || !signals.length) return;
    lastBetSignals = signals;
    renderBetSignals();
  });

  // signal:new = bet:opportunity vindo do betSignalEngine (corners/btts/win)
  // Backend já filtra/atrasa por tier — aqui só ajustamos a UX:
  //   - FREE recebe payload sem premiumInsight (locked=true)
  //   - PREMIUM recebe payload completo + sound + notification
  socket.on('signal:new', (signal) => {
    console.log('[LIVE SIGNAL SOCKET]', signal);
    console.log('[LIVE SIGNAL SOCKET] signal:new', {
      type: signal?.type,
      market: signal?.market,
      confidence: signal?.confidence,
      home: signal?.match?.home || signal?.home,
      away: signal?.match?.away || signal?.away,
    });
    window.RobotrendHeartbeat?.markSocketActivity('signal:new');
    const isPrem = isPremiumUser();
    // Ignora mercados fora dos 5 ativos (ex.: WIN/1X2 legado).
    if (signal?.type === 'bet:opportunity' && !ALLOWED_BET_MARKETS.has(signal?.market)) return;
    if (signal?.type === 'bet:opportunity') {
      lastBetSignals.unshift(signal);
      if (lastBetSignals.length > 20) lastBetSignals.length = 20;
      renderBetSignals();

      // Sinal premium bloqueado para FREE: o backend já removeu todo o conteúdo
      // preditivo (palpite, odd, confiança, times). Mostramos só o upgrade.
      const isLocked = signal.locked === true;
      if (isLocked) {
        if (signal.limitReached) {
          // Limite diário do FREE atingido — mensagem de upgrade específica.
          if (freeQuota) { freeQuota.used = freeQuota.limit; freeQuota.remaining = 0; renderFreeCounter(); }
          pushToast({
            title: '🔒 Limite diário atingido',
            body: signal.message || 'Você atingiu o limite diário de sinais da versão gratuita. Assine o Premium para acesso completo.',
            accent: 'warn',
          });
        } else {
          pushToast({
            title: '💎 Sinal Premium disponível',
            body: '🔒 Faça upgrade para desbloquear a análise completa da IA.',
            accent: 'warn',
          });
        }
      } else {
        const teamsTxt = `${signal.match?.home || signal.home} × ${signal.match?.away || signal.away}`;
        if (isPrem) {
          pushToast({
            title: `💎 ${marketLabel(signal.market)} · ${signal.confidence}%`,
            body: `${teamsTxt}<br/><b>${signal.prediction}</b> · odd ~${signal.oddEstimated}<br/><small style="opacity:.7">${signal.premiumInsight || ''}</small>`,
          });
          notify(teamsTxt, `${signal.prediction} · IA ${signal.confidence}%`);
        } else {
          pushToast({
            title: `${marketLabel(signal.market)} · sinal disponível`,
            body: `${teamsTxt}<br/><b>${signal.prediction}</b><br/><small style="opacity:.7">🔒 Análise IA completa no Premium.</small>`,
            accent: 'warn',
          });
        }
      }
    } else {
      // legacy signal payload
      lastSignals.unshift(signal);
      renderSignals();
      pushToast({
        title: `Sinal Live · ${signal.confidence ?? 0}%`,
        body: `${signal.home} × ${signal.away}<br/><b>${signal.suggestion}</b>`,
      });
    }
    if (isPrem) playChime();
  });

  // signal:best = "Melhor Aposta do Momento" (premium-only no server)
  socket.on('signal:best', (signal) => {
    if (!signal || !isPremiumUser()) return;
    lastBestSignal = signal;
    renderBestBet(signal);
    pushToast({
      title: '💎 Nova Melhor Aposta do Momento',
      body: `${signal.match?.home || signal.home} × ${signal.match?.away || signal.away}<br/><b>${signal.prediction}</b> · Score IA ${signal.betScore || signal.confidence}/100`,
      accent: 'ok',
    });
  });

  /* ============================================================
     ACCESS-DENIED TOAST (vindo do auth-guard via ?denied=)
     ============================================================ */
  (function showDeniedNoticeIfAny() {
    const params = new URLSearchParams(location.search);
    const denied = params.get('denied');
    if (!denied) return;
    setTimeout(() => {
      pushToast({
        title: 'Acesso restrito',
        body: `A página ${denied} é exclusiva para administradores.`,
        accent: 'warn',
      });
    }, 600);
    // Limpa o query string para não repetir no F5
    history.replaceState(null, '', location.pathname);
  })();

  /* ============================================================
     BOOT
     ============================================================ */
  initTheme();
  // Detecta disponibilidade de dados reais ANTES de chamar o REST.
  // Quando nenhum provider real está configurado, o painel exibe
  // "Dados indisponíveis no momento." em vez de ficar piscando vazio.
  detectFootballAvailability().then(() => loadLiveFromApi());
  loadSignals();
  loadBetSignals();                                  // boot: REST fallback do painel #live-signals
  loadBestSignal();
  // Garantia extra: se o script carregar antes do DOM estar pronto,
  // dispara um segundo loadBetSignals() no `load`. Idempotente.
  window.addEventListener('load', () => {
    try { loadBetSignals(); } catch (e) { console.error('[LIVE SIGNAL FRONT] load handler error:', e); }
  });
  setInterval(loadLiveFromApi, 15_000);              // backup REST do poller (stats enriquecidas)
  setInterval(loadBetSignals,  60_000);              // backup polling caso socket caia
  setInterval(loadBestSignal,  90_000);              // refresh do best-bet a cada 90s
  setInterval(detectFootballAvailability, 120_000);  // reavalia disponibilidade periodicamente

  // Reage a mudanças do user-state (plano, role) — re-renderiza cards
  // que dependem do tier (best-bet, signal cards locked/unlocked).
  if (window.RobotrendUser?.onChange) {
    window.RobotrendUser.onChange((u, prev) => {
      // Sincroniza o contador diário do FREE com o estado do servidor.
      if (u && !u.isPremium && !u.isAdmin && u.dailySignalsLimit) {
        updateFreeQuota({
          used: u.dailySignalsUsed ?? freeQuota.used,
          limit: u.dailySignalsLimit ?? freeQuota.limit,
          remaining: u.dailySignalsRemaining ?? freeQuota.remaining,
        });
      } else {
        renderFreeCounter();
      }
      const tierChanged = !!u?.isPremium !== !!prev?.isPremium;
      if (tierChanged) {
        try { loadBestSignal(); } catch (_) {}
        renderBetSignals();
        renderSignals();
      }
    });
  }

  // Render inicial do contador (mostra/oculta conforme o tier já em cache).
  try { renderFreeCounter(); } catch (_) {}
})();
