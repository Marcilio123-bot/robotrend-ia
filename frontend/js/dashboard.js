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
  let lastPrelive  = []; // payload do socket prelive:update / GET /api/prelive
  let preliveLastUpdateAt = 0;

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

  /**
   * Mostra/esconde o banner "Dados indisponíveis no momento.".
   * Critério: mostra quando NÃO há provider real configurado OU quando o
   * último snapshot do poller veio em fallback E o painel está vazio.
   */
  let dataUnavailable = false;
  function setDataUnavailableBanner(visible) {
    const banner = document.getElementById('data-unavailable-banner');
    if (banner) banner.style.display = visible ? '' : 'none';
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
      if (!safe.length) {
        // REST devolveu 0 jogos válidos. Se o socket também não trouxe nada,
        // o painel está realmente vazio — re-avalia o banner de indisponibilidade.
        if (!lastMatches.length) {
          setDataUnavailableBanner(true);
          renderEmptyState();
        }
        return;
      }
      // Merge com lastMatches (socket pode ter trazido matches que o REST
      // ainda não devolveu, e vice-versa). Dedup por ID, versão mais nova vence.
      lastMatches = mergeMatchesById(lastMatches, safe);
      setText('#kpi-live', String(lastMatches.length));
      // Houve dados reais → esconde banner.
      setDataUnavailableBanner(false);
      scheduleRender();
    } catch (_) { /* offline */ }
  }

  /**
   * Estado vazio: pinta a área de matches com a mensagem oficial.
   * O renderMatches() padrão é resiliente a lastMatches=[] mas precisa de
   * um placeholder explícito para o usuário entender o que aconteceu.
   */
  function renderEmptyState() {
    const root = document.querySelector('#matches') || document.querySelector('[data-matches-mount]');
    if (!root) return;
    if (lastMatches.length > 0) return; // não sobrescreve renders normais
    root.innerHTML =
      '<div class="saas-card" style="text-align:center; padding:32px; opacity:.85;">' +
      '<div style="font-size:15px; font-weight:600; margin-bottom:6px;">Dados indisponíveis no momento.</div>' +
      '<div class="text-sm" style="opacity:.7;">' +
      'Aguardando resposta da API-Football. O painel atualiza automaticamente quando houver dados reais.' +
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

    // Quando há matches mas o feed de sinais ainda está vazio, repintamos
    // o painel de sinais para que ele caia no preview de análises IA
    // (anti-empty UX). Idempotente: se já há sinais, renderBetSignals
    // mantém o conteúdo atual.
    if (safe.length && !lastBetSignals.length) {
      try { renderBetSignals(); } catch (_) {}
    }
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
    const top = lastBetSignals.slice(0, 6);
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
     PRELIVE — tabela de jogos + cards de palpites BTTS
     ------------------------------------------------------------
     Fonte primária: socket `prelive:update` (broadcast pelo bot
     scheduler em backend/bot.js). Fallback: GET /api/prelive
     (apenas para users com feature `prelive` no plano — VIP/PREMIUM).
     ============================================================ */
  function preliveRiskLabel(s) {
    if (s?.risk?.label) return s.risk.label;
    if (s?.risk?.level) return s.risk.level;
    if (s?.confidence == null) return '—';
    if (s.confidence >= 80) return 'Baixo';
    if (s.confidence >= 65) return 'Médio';
    return 'Alto';
  }
  function preliveRiskColor(label) {
    const k = String(label || '').toLowerCase();
    if (k.includes('baix')) return '#22c55e';
    if (k.includes('méd') || k.includes('med')) return '#facc15';
    if (k.includes('alt')) return '#ef4444';
    return '#6b7280';
  }
  function preliveStartLabel(iso) {
    if (!iso) return '—';
    const t = new Date(iso);
    if (!Number.isFinite(t.getTime())) return '—';
    const today = new Date();
    const sameDay = t.toDateString() === today.toDateString();
    if (sameDay) return t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return t.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /* ------------------------------------------------------------
     normalizePreliveItem
     ------------------------------------------------------------
     Garante consistência de tipos no payload do backend (ou de
     caches antigos): odd como Number com ponto decimal, confidence
     numérica, booleans saneados. NUNCA descarta um item por valor
     de shouldSignal/confidence/risk — apenas saneia campos.
     ------------------------------------------------------------ */
  function normalizePreliveItem(fx) {
    if (!fx || typeof fx !== 'object') return null;
    const out = { ...fx };
    // odd: aceita Number ou string ("1,17" PT, "1.17" US) → Number ou null
    if (out.odd != null) {
      const n = Number(String(out.odd).replace(',', '.'));
      out.odd = Number.isFinite(n) ? n : null;
    }
    // confidence: força Number 0–100 (defensivo — analyzePrelive já devolve número)
    const c = Number(out.confidence);
    out.confidence = Number.isFinite(c) ? Math.max(0, Math.min(100, c)) : 0;
    // booleans saneados — qualquer string "true"/"false" vira boolean real
    out.shouldSignal = out.shouldSignal === true || out.shouldSignal === 'true';
    out.stale        = out.stale        === true || out.stale        === 'true';
    return out;
  }

  function renderPreliveFixtures() {
    /* ----------------------------------------------------------
       REGRA DA SEÇÃO "JOGOS PRÉ-LIVE"
       ----------------------------------------------------------
       Esta tabela exibe TODOS os fixtures recebidos do backend,
       independentemente de shouldSignal / confidence / risk.
       Esses campos servem APENAS de informação visual (badges).
       O único filtro defensivo aqui descarta objetos sem nome
       de mandante NEM visitante (lixo de cache antigo). Tudo o
       mais — incluindo confidence=0, risk=ALTO e shouldSignal=
       false — DEVE aparecer.
       ---------------------------------------------------------- */
    const body = $('#prelive-fixtures-body');
    const countEl = $('#prelive-fixtures-count');
    if (!body) return;

    const list = (lastPrelive || []).filter((fx) => fx && (fx.home || fx.away));
    if (countEl) countEl.textContent = list.length ? `${list.length} jogos` : '—';
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="8" class="py-6 text-center" style="color:var(--muted);">Sem jogos pré-live na janela das próximas 24h.</td></tr>`;
      return;
    }

    body.innerHTML = list.map((fx) => {
      const time = preliveStartLabel(fx.startsAt);
      const conf = Number(fx.confidence ?? 0);
      const market = fx.shouldSignal && fx.suggestion
        ? fx.suggestion
        : (fx.over25?.suggestion || fx.market || 'Sem entrada');
      const odd = fx.odd != null ? `~${fx.odd}` : '—';
      const riskLabel = preliveRiskLabel(fx);
      const riskColor = preliveRiskColor(riskLabel);
      const confColor = conf >= 75 ? '#22c55e' : conf >= 60 ? '#facc15' : 'var(--muted)';
      const stale = fx.stale ? ` <span class="badge" style="background:#6b728022;color:#9ca3af;border:1px solid #6b728044;">stale</span>` : '';
      return `
        <tr>
          <td class="py-3 px-4 font-mono text-xs">${escapeHtml(time)}</td>
          <td class="py-3 px-4 text-xs" style="color:var(--text-2);">${escapeHtml(fx.league || '—')}</td>
          <td class="py-3 px-4 font-semibold">${escapeHtml(fx.home || '—')}${stale}</td>
          <td class="py-3 px-4 font-semibold">${escapeHtml(fx.away || '—')}</td>
          <td class="py-3 px-4 font-mono" style="color:${confColor}; font-weight:700;">${conf}%</td>
          <td class="py-3 px-4"><span class="badge live" style="background:rgba(6,182,212,.18); color:#06b6d4; border:1px solid rgba(6,182,212,.30);">${escapeHtml(market || '—')}</span></td>
          <td class="py-3 px-4 font-mono">${escapeHtml(odd)}</td>
          <td class="py-3 px-4">
            <span class="badge" style="background:${riskColor}22;color:${riskColor};border:1px solid ${riskColor}44;">${escapeHtml(riskLabel)}</span>
          </td>
        </tr>`;
    }).join('');
  }

  function preliveSignalCardHTML(s) {
    const time = preliveStartLabel(s.startsAt);
    const conf = Number(s.confidence ?? 0);
    const odd  = s.odd != null ? `~${s.odd}` : '—';
    const riskLabel = preliveRiskLabel(s);
    const riskColor = preliveRiskColor(riskLabel);
    const tags = Array.isArray(s.tags) ? s.tags.slice(0, 3) : [];
    const home6 = (s.homeStats?.history || []).map((h) => h?.btts ? '🟢' : (h?.over25 ? '🟡' : '⚪')).join(' ');
    const away6 = (s.awayStats?.history || []).map((h) => h?.btts ? '🟢' : (h?.over25 ? '🟡' : '⚪')).join(' ');
    const accent = '#06b6d4';
    return `
      <article class="saas-card" style="border-left:3px solid ${accent};">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="badge live" style="background:${accent}22; color:${accent}; border:1px solid ${accent}44;">BTTS Pré-Live</span>
            <span class="badge" style="background:${riskColor}22;color:${riskColor};border:1px solid ${riskColor}44;">${escapeHtml(riskLabel)}</span>
          </div>
          <span class="text-[11px]" style="color: var(--muted); font-family: 'JetBrains Mono', monospace;">${escapeHtml(time)}</span>
        </div>
        <div class="text-sm font-bold mb-1">${escapeHtml(s.home || '—')} <span style="color:var(--muted);">×</span> ${escapeHtml(s.away || '—')}</div>
        <div class="text-[11px] mb-3" style="color: var(--muted);">${escapeHtml(s.league || 'Pré-jogo')}</div>
        <div class="text-lg font-extrabold mb-2" style="color: ${accent};">🎯 ${escapeHtml(s.suggestion || '—')}</div>
        ${(home6 || away6) ? `
          <div class="text-[11px] mb-2" style="color: var(--text-2); font-family: 'JetBrains Mono', monospace;">
            <div>${escapeHtml(s.home || 'Casa')}: ${home6 || '—'}</div>
            <div>${escapeHtml(s.away || 'Fora')}: ${away6 || '—'}</div>
          </div>` : ''}
        <div class="grid grid-cols-3 gap-2 text-center mt-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">IA</div>
            <div class="font-mono font-bold">${conf}%</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">Odd</div>
            <div class="font-mono font-bold">${escapeHtml(odd)}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider" style="color: var(--muted);">Ofensivo</div>
            <div class="font-mono font-bold">${Number(s.offensiveCombined ?? 0)}</div>
          </div>
        </div>
        ${tags.length ? `<div class="mt-3 text-[11px]" style="color: var(--text-2); line-height:1.5;">🧠 ${tags.map(escapeHtml).join(' · ')}</div>` : ''}
      </article>
    `;
  }

  function renderPreliveSignals() {
    /* ----------------------------------------------------------
       REGRA DA SEÇÃO "PALPITES PRÉ-LIVE"
       ----------------------------------------------------------
       SOMENTE aqui filtramos por shouldSignal && !stale. Estes
       cards são opcionais — se nenhum jogo atender ao critério,
       mostramos um fallback informativo, mas a tabela de
       fixtures continua íntegra acima.
       ---------------------------------------------------------- */
    const host = $('#prelive-signals');
    const status = $('#prelive-signals-status');
    if (!host) return;

    const tradable = (lastPrelive || []).filter((s) => s && s.shouldSignal && !s.stale);
    if (status) {
      if (preliveLastUpdateAt) {
        const ageS = Math.max(0, Math.round((Date.now() - preliveLastUpdateAt) / 1000));
        status.textContent = tradable.length
          ? `${tradable.length} palpite${tradable.length === 1 ? '' : 's'} · ${ageS}s`
          : `sem palpite · ${ageS}s`;
        status.classList.remove('err'); status.classList.toggle('ok', tradable.length > 0);
      } else {
        status.textContent = 'aguardando';
      }
    }

    if (!tradable.length) {
      // Conta APENAS fixtures válidos (mesma regra de renderPreliveFixtures)
      const total = (lastPrelive || []).filter((fx) => fx && (fx.home || fx.away)).length;
      host.innerHTML = `<div class="col-span-full saas-card saas-empty">${
        total
          ? `Nenhum sinal no momento — ${total} jogo${total === 1 ? '' : 's'} pré-live disponível${total === 1 ? '' : 'is'} na tabela abaixo.`
          : 'Aguardando análise pré-live…'
      }</div>`;
      return;
    }
    host.innerHTML = tradable.slice(0, 6).map(preliveSignalCardHTML).join('');
  }

  function setPrelive(list, opts = {}) {
    if (!Array.isArray(list)) return;
    // Normalização defensiva: sanitiza odd/confidence/booleans antes de armazenar
    // — NUNCA descarta itens por shouldSignal/confidence/risk (regra do produto:
    // fixtures sempre aparecem; signals são opcionais).
    const normalized = list.map(normalizePreliveItem).filter(Boolean);
    // [PRELIVE FRONT DEBUG] temporário — remover após diagnóstico
    console.log('[PRELIVE FRONT] recebidos:', normalized.length, 'itens — source:', opts.source || '?');
    if (normalized.length) console.log('[PRELIVE FRONT] sample[0]:', normalized[0]);
    console.log('[PRELIVE FRONT] render count:', normalized.length);
    lastPrelive = normalized;
    preliveLastUpdateAt = Date.now();
    try { renderPreliveFixtures(); } catch (e) { console.error('[PRELIVE FRONT] render fixtures error:', e); }
    try { renderPreliveSignals(); }  catch (e) { console.error('[PRELIVE FRONT] render signals error:', e); }
    if (opts.source) {
      try { window.RobotrendBus?.emit('robotrend:prelive-render', { count: normalized.length, source: opts.source }); } catch (_) {}
    }
  }

  async function loadPrelive() {
    try {
      const headers = { Accept: 'application/json' };
      const tok = window.RobotrendAuth?.getToken?.();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      const r = await fetch('/api/prelive', { headers, credentials: 'include' });
      window.RobotrendHeartbeat?.markRestActivity?.('/api/prelive', r.status);
      // 401/402: usuário sem feature ou sem token — silencia (socket cobre quando autorizado).
      if (r.status === 401 || r.status === 402) {
        console.log('[PRELIVE REST] sem permissão (status=' + r.status + ') — aguardando socket.');
        return;
      }
      if (!r.ok) {
        console.warn('[PRELIVE REST] HTTP', r.status);
        return;
      }
      const data = await r.json();
      // [PRELIVE FRONT DEBUG] temporário — remover após diagnóstico
      console.log('[PRELIVE REST]', data);
      setPrelive(Array.isArray(data?.fixtures) ? data.fixtures : [], { source: 'rest' });
    } catch (err) {
      console.error('[PRELIVE REST ERROR]', err);
    }
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

  // matches:update — socket é a fonte primária do scanner real.
  // Quando o scanner inerte emite [] (sem provider configurado), NÃO
  // limpamos o feed: deixamos o fallback REST e o banner de indisponibilidade
  // tomarem conta da UX.
  socket.on('matches:update', (m) => {
    window.RobotrendHeartbeat?.markSocketActivity('matches:update');
    const incoming = filterValidMatches(m || []);
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
    lastSignals = l || [];
    renderSignals();
  });

  // prelive:update — broadcast do bot.runPrelive() (scheduler ou REST).
  // Lista completa da janela 24h, com `shouldSignal` marcando entradas operáveis.
  socket.on('prelive:update', (fixtures) => {
    // [PRELIVE FRONT DEBUG] temporário — remover após diagnóstico
    console.log('[PRELIVE SOCKET]', fixtures);
    window.RobotrendHeartbeat?.markSocketActivity('prelive:update');
    setPrelive(Array.isArray(fixtures) ? fixtures : [], { source: 'socket' });
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
  // Detecta disponibilidade de dados reais ANTES de chamar o REST.
  // Quando nenhum provider real está configurado, o painel exibe
  // "Dados indisponíveis no momento." em vez de ficar piscando vazio.
  detectFootballAvailability().then(() => loadLiveFromApi());
  loadSignals();
  loadBetSignals();
  loadBestSignal();
  loadPrelive();                                     // boot: carrega snapshot inicial via REST (se autorizado)
  // Garantia extra: se o script carregar antes do DOM estar pronto,
  // dispara um segundo loadPrelive() no `load`. Idempotente — apenas
  // refaz a chamada REST, useful em cold-start lento.
  window.addEventListener('load', () => {
    try { loadPrelive(); } catch (e) { console.error('[PRELIVE FRONT] load handler error:', e); }
  });
  setInterval(loadLiveFromApi, 30_000);              // backup REST do poller football
  setInterval(loadBetSignals,  60_000);              // backup polling caso socket caia
  setInterval(loadBestSignal,  90_000);              // refresh do best-bet a cada 90s
  setInterval(loadPrelive,    300_000);              // backup REST do prelive (scheduler emite a cada ~10min)
  setInterval(detectFootballAvailability, 120_000);  // reavalia disponibilidade periodicamente

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
