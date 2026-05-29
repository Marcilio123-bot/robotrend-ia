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
  /** Banner amarelo "modo demo" — gerenciado por detectFootballMode(). */
  let demoModeActive = false;

  // Em DEMO o backend já bloqueia signals fake (FAKE-MATCH GUARD) — então
  // exibir as partidas demo-* no painel é seguro e melhora a UX. O filtro
  // segue rejeitando apenas matches OBVIAMENTE inválidos (FT/timestamp ruim).
  function isValidMatch(m) {
    if (!m || m.id == null) return false;
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

  /**
   * Faz merge de matches por ID, mantendo a versão MAIS NOVA quando há
   * conflito entre socket e REST. Critério "mais novo":
   *   1) maior `lastApiUpdate` ou `updatedAt` ou `lastTickAt`
   *   2) na ausência desses campos, sempre prefere o incoming.
   * Devolve o array deduplicado preservando a ordem de chegada.
   */
  function mergeMatchesById(currentList, incomingList) {
    const map = new Map();
    const addAll = (arr) => {
      for (const m of arr || []) {
        if (!m || m.id == null) continue;
        const id = String(m.id);
        const existing = map.get(id);
        if (!existing) { map.set(id, m); continue; }
        const a = Number(existing.lastApiUpdate || existing.updatedAt || existing.lastTickAt || 0);
        const b = Number(m.lastApiUpdate || m.updatedAt || m.lastTickAt || 0);
        map.set(id, b >= a ? m : existing);
      }
    };
    addAll(currentList);
    addAll(incomingList);
    return Array.from(map.values());
  }

  function mapApiMatchToDashboard(m) {
    if (!m) return null;
    const sc = m.score || { home: 0, away: 0 };
    return {
      id: String(m.fixtureId || m.id),
      home: m.home || m.teams?.home?.name || '—',
      away: m.away || m.teams?.away?.name || '—',
      league: m.league?.name || m.league || 'Live',
      minute: Number(m.minute || m.fixture?.status?.elapsed || 0),
      status: m.status || m.fixture?.status?.short || 'LIVE',
      kickoffAt: m.kickoffAt || m.date || m.fixture?.date,
      date: m.kickoffAt || m.date,
      score: { home: Number(sc.home ?? 0), away: Number(sc.away ?? 0) },
      corners: Number(m.stats?.corners?.total ?? m.corners ?? 0),
      dangerousAttacks: Number(m.stats?.dangerousAttacks?.total ?? m.dangerousAttacks ?? 0),
      shots: Number(m.stats?.shots?.total ?? m.shots ?? 0),
      shotsOnTarget: Number(m.stats?.shotsOnTarget?.total ?? m.shotsOnTarget ?? 0),
      provider: m.provider,
    };
  }

  async function detectFootballMode() {
    try {
      const r = await fetch('/api/health', { credentials: 'include' });
      if (!r.ok) return;
      const h = await r.json();
      const prov = String(h.football?.activeProvider || '').toLowerCase();
      demoModeActive = prov === 'demo';
      const banner = document.getElementById('demo-provider-banner');
      if (banner) banner.style.display = demoModeActive ? '' : 'none';
    } catch (_) { /* offline */ }
  }

  /**
   * Lê /api/football/live (cache do poller — custo zero) como fallback
   * quando o socket vem vazio. NUNCA limpa lastMatches; só substitui
   * quando o REST traz algo útil, evitando piscadas no painel.
   */
  async function loadLiveFromApi() {
    try {
      const headers = {};
      const tok = window.RobotrendAuth?.getToken?.();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      const r = await fetch('/api/football/live', { headers, credentials: 'include' });
      window.RobotrendHeartbeat?.markRestActivity('/api/football/live', r.status);
      if (!r.ok) return;
      const data = await r.json();
      const mapped = (data.matches || []).map(mapApiMatchToDashboard).filter(Boolean);
      const safe = filterValidMatches(mapped);
      if (!safe.length) return;
      // Merge com lastMatches (socket pode ter trazido matches que o REST
      // ainda não devolveu, e vice-versa). Dedup por ID, versão mais nova vence.
      lastMatches = mergeMatchesById(lastMatches, safe);
      setText('#kpi-live', String(lastMatches.length));
      scheduleRender();
    } catch (_) { /* offline */ }
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
    const cls = a?.classification ? levelClass(a.classification.level) : 'warm';
    const sug = a?.suggestion ? `<div class="suggestion-pill">${esc(a.suggestion)}</div>` : '';
    const oddRisk = a
      ? `<div class="flex items-center gap-1.5 mt-2 flex-wrap">
           ${classBadge(a.classification)}
           ${riskBadge(a.risk)}
           ${a.odd ? `<span class="badge">~${esc(a.odd)}</span>` : ''}
         </div>`
      : '';
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
        </div>
        <div class="mt-3">
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
        ${sug}
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
      m.corners, m.dangerousAttacks, m.shots, m.shotsOnTarget,
      a?.pressure, a?.confidence, a?.verdict, a?.classification?.level,
      a?.risk?.level, a?.suggestion, a?.odd,
    ].join('|');
  }

  function renderMatches() {
    const grid = $('#matches-grid');
    if (!grid) return;
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
  }

  /* ============================================================
     BET SIGNALS (corners / btts / win) — cards compactos
     ============================================================ */
  function marketLabel(m) {
    return ({ corners: 'Escanteios', btts: 'Ambas marcam', win: 'Vitória', goals: 'Gols' }[m] || m || 'Sinal');
  }
  function marketAccent(m) {
    return ({ corners: '#facc15', btts: '#06b6d4', win: '#14b85e', goals: '#a855f7' }[m] || '#14b85e');
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
    const league = s.match?.league || s.league || '';
    const isLocked = s.locked === true;
    const isPremium = s.tier === 'premium' && !isLocked;
    const tierBadge = isPremium
      ? `<span class="badge" style="background:linear-gradient(135deg,#ffd166,#ffb547);color:#2a1a05;font-weight:900;letter-spacing:1px;">💎 PREMIUM</span>`
      : isLocked
        ? `<span class="badge" style="background:#6b728022;color:#9ca3af;border:1px solid #6b728044;">🔒 PREVIEW</span>`
        : '';
    const insightHtml = isLocked
      ? `<div class="mt-3 text-[11px]" style="color: #ffb547; line-height:1.5;background:rgba(255,181,71,.08);padding:8px 10px;border-radius:6px;border-left:2px solid #ffb547;">
           🔒 ${s.justification || 'Análise completa disponível no Premium.'}
           <a href="#" onclick="window.virarPremium();event.preventDefault();" style="color:#ffb547;font-weight:700;text-decoration:underline;">Upgrade →</a>
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
        <div class="text-sm font-bold mb-1">${escapeHtml(matchTxt)}</div>
        <div class="text-[11px] mb-3" style="color: var(--muted);">${escapeHtml(league)} · ${minute}'</div>
        <div class="text-lg font-extrabold mb-2" style="color: ${accent};">${escapeHtml(s.prediction || s.suggestion || '—')}</div>
        <div class="grid grid-cols-3 gap-2 text-center mt-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">Prob</div>
            <div class="font-mono font-bold">${prob}%</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">IA</div>
            <div class="font-mono font-bold">${conf}%</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">Odd</div>
            <div class="font-mono font-bold">${odd ? '~' + odd : '—'}</div>
          </div>
        </div>
        ${insightHtml}
      </article>
    `;
  }

  function renderBetSignals() {
    const host = $('#live-signals');
    if (!host) return;
    const top = lastBetSignals.slice(0, 6);
    if (!top.length) {
      host.innerHTML = `<div class="col-span-full saas-card saas-empty">Aguardando o próximo sinal…</div>`;
      return;
    }
    host.innerHTML = top.map(betSignalCardHTML).join('');
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
    const league = escapeHtml(signal.match?.league || signal.league || '');
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
      const r = await fetch('/api/football/bet-signals?limit=6&minConfidence=70');
      if (!r.ok) return;
      const data = await r.json();
      lastBetSignals = data.signals || [];
      renderBetSignals();
    } catch (_) {}
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

  // matches:update — socket é a fonte primária quando há scanner real ativo.
  // Quando o backend está em modo demo (scanner inerte → bot emite []), NÃO
  // limpamos o feed: deixamos o fallback REST popular o painel.
  socket.on('matches:update', (m) => {
    window.RobotrendHeartbeat?.markSocketActivity('matches:update');
    const incoming = filterValidMatches(m || []);
    if (incoming.length) {
      // Merge incremental: socket pode chegar atrasado depois de um REST e
      // não queremos sobrescrever versões mais novas do mesmo match.
      lastMatches = mergeMatchesById(lastMatches, incoming);
      setText('#kpi-live', String(lastMatches.length));
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
    lastSignals = l || [];
    renderSignals();
  });

  // signal:new = bet:opportunity vindo do betSignalEngine (corners/btts/win)
  // Backend já filtra/atrasa por tier — aqui só ajustamos a UX:
  //   - FREE recebe payload sem premiumInsight (locked=true)
  //   - PREMIUM recebe payload completo + sound + notification
  socket.on('signal:new', (signal) => {
    const isPrem = isPremiumUser();
    if (signal?.type === 'bet:opportunity') {
      lastBetSignals.unshift(signal);
      if (lastBetSignals.length > 20) lastBetSignals.length = 20;
      renderBetSignals();

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
  // Detecta o provider ativo (real vs demo) ANTES de aplicar os filtros do feed REST.
  // Sem isso, o filtro client-side derruba 100% dos matches sintéticos do demoProvider
  // e o painel fica vazio mesmo com o poller cheio de partidas.
  detectFootballMode().then(() => loadLiveFromApi());
  loadSignals();
  loadBetSignals();
  loadBestSignal();
  setInterval(loadLiveFromApi, 30_000);   // backup REST do poller football
  setInterval(loadBetSignals,  60_000);   // backup polling caso socket caia
  setInterval(loadBestSignal,  90_000);   // refresh do best-bet a cada 90s
  setInterval(detectFootballMode, 120_000); // reavalia provider periodicamente

  // Reage a mudanças do user-state (plano, role) — re-renderiza cards
  // que dependem do tier (best-bet, signal cards locked/unlocked).
  if (window.RobotrendUser?.onChange) {
    window.RobotrendUser.onChange((u, prev) => {
      const tierChanged = !!u?.isPremium !== !!prev?.isPremium;
      if (tierChanged) {
        try { loadBestSignal(); } catch (_) {}
        renderBetSignals();
        renderSignals();
      }
    });
  }
})();
