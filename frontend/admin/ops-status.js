/* ============================================================
   ROBOTREND IA — Ops Status Widget (Operacional IA)
   ------------------------------------------------------------
   Painel admin de monitoramento em tempo real. Consome:
     - GET /api/admin/ops               (5s polling)
     - GET /api/signals?limit=10        (10s polling, para "decisões IA")

   Renderiza cards + sparklines com buffers rolling client-side:
     - latência poller (últimas 30 amostras)
     - ticks success por minuto
     - uptime / memória / providers / scanner / erros recentes
     - tabela "últimas decisões IA"
     - score médio das análises

   Auto-mount em qualquer [data-ops-status]. Idempotente (window
   guard previne dupla execução).
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendOpsStatus) return;

  const REFRESH_OPS_MS     = 5000;
  const REFRESH_SIGNALS_MS = 10000;
  const HISTORY_MAX        = 30;

  const hosts = new Set();
  const history = {
    pollerLat:  [],
    tracked:    [],
    monitored:  [],
    ticksOk:    [],  // delta de ticksSuccess
    memRss:     [],
    lastTicksSuccess: null,
  };
  let lastDecisions = [];
  let lastScoreAvg = null;

  function esc(s) {
    return window.RobotrendSanitize?.escapeHtml(s) ?? String(s ?? '');
  }

  function pushHistory(arr, value) {
    if (!Number.isFinite(value)) return;
    arr.push(value);
    if (arr.length > HISTORY_MAX) arr.shift();
  }

  function fmtUptime(sec) {
    if (!Number.isFinite(sec)) return '—';
    const s = Math.floor(sec);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}min`;
    if (h > 0) return `${h}h ${m}min`;
    if (m > 0) return `${m}min`;
    return `${s}s`;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const mb = n / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  function fmtMs(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1000) return `${Math.round(n)} ms`;
    return `${(n / 1000).toFixed(2)} s`;
  }

  function health(item) {
    return item === 'healthy' ? 'ok'
         : item === 'degraded' ? 'warn'
         : item === 'starting' ? 'warn'
         : item === 'stopped' ? 'err' : '';
  }

  function template() {
    return `
      <div class="ops-grid">
        <div class="ops-card">
          <div class="ops-card-title">⚡ Provider</div>
          <div class="ops-card-value" data-k="provider.active">—</div>
          <div class="ops-card-sub" data-k="provider.priority">—</div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">📡 Scanner</div>
          <div class="ops-card-value" data-k="scanner.label">—</div>
          <div class="ops-card-sub" data-k="scanner.sub">—</div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">🎯 Partidas monitoradas</div>
          <div class="ops-card-value" data-k="bot.monitored">—</div>
          <div class="ops-card-sub" data-k="bot.minscore">—</div>
          <div class="ops-spark" data-spark="monitored"></div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">📨 Sinais (24h)</div>
          <div class="ops-card-value" data-k="signals.sent">—</div>
          <div class="ops-card-sub" data-k="signals.winrate">—</div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">⏱ Latência poller</div>
          <div class="ops-card-value" data-k="poller.latency">—</div>
          <div class="ops-card-sub" data-k="poller.lastTick">—</div>
          <div class="ops-spark" data-spark="pollerLat"></div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">🧮 Ticks/min</div>
          <div class="ops-card-value" data-k="poller.tpm">—</div>
          <div class="ops-card-sub" data-k="poller.cumulative">—</div>
          <div class="ops-spark" data-spark="ticksOk"></div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">⏳ Uptime</div>
          <div class="ops-card-value" data-k="proc.uptime">—</div>
          <div class="ops-card-sub" data-k="proc.pid">—</div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">🧠 Memória</div>
          <div class="ops-card-value" data-k="proc.rss">—</div>
          <div class="ops-card-sub" data-k="proc.heap">—</div>
          <div class="ops-spark" data-spark="memRss"></div>
        </div>
        <div class="ops-card">
          <div class="ops-card-title">🧠 Score médio IA</div>
          <div class="ops-card-value" data-k="ia.score">—</div>
          <div class="ops-card-sub" data-k="ia.scoreSub">amostra últimas decisões</div>
        </div>
        <div class="ops-card ops-card-tall">
          <div class="ops-card-title">⚠ Últimos erros</div>
          <div class="ops-errors" data-k="errors.list">—</div>
        </div>
        <div class="ops-card ops-card-wide">
          <div class="ops-card-title">🧾 Últimas decisões IA</div>
          <div class="ops-decisions" data-k="decisions.list">—</div>
        </div>
      </div>
      <div class="ops-footer">
        <span class="ops-footer-status" data-k="footer.status">aguardando…</span>
        <span class="ops-footer-time"   data-k="footer.time">—</span>
      </div>
    `;
  }

  function set(host, key, value, klass) {
    const el = host.querySelector(`[data-k="${key}"]`);
    if (!el) return;
    if (klass !== undefined) {
      el.className = el.className.replace(/\bops-(ok|warn|err)\b/g, '').trim();
      if (klass) el.classList.add(`ops-${klass}`);
    }
    if (value && value.__html) el.innerHTML = value.__html;
    else el.textContent = value ?? '—';
  }

  function spark(host, key, points, opts) {
    if (!window.RobotrendSparkline?.render) return;
    const el = host.querySelector(`[data-spark="${key}"]`);
    if (!el) return;
    window.RobotrendSparkline.render(el, points, opts);
  }

  /* ============================================================
     PAINT — ops payload
     ============================================================ */
  function paint(host, data) {
    const af  = data?.football || {};
    const pol = data?.poller   || {};
    const bot = data?.bot      || {};
    const sig = data?.signals  || {};
    const proc = data?.process || {};
    const errs = data?.errors  || [];

    // Histories
    pushHistory(history.pollerLat, pol.lastTickMs);
    pushHistory(history.tracked,   Number(pol.tracked || 0));
    pushHistory(history.monitored, Number(bot.monitored || 0));
    pushHistory(history.memRss,    Number(proc.memory?.rss || 0));

    // ticksSuccess delta
    if (Number.isFinite(pol.ticksSuccess)) {
      if (history.lastTicksSuccess != null) {
        const delta = Math.max(0, pol.ticksSuccess - history.lastTicksSuccess);
        // amostragem a cada REFRESH_OPS_MS → escala para por minuto
        const perMinute = delta * (60_000 / REFRESH_OPS_MS);
        pushHistory(history.ticksOk, perMinute);
      }
      history.lastTicksSuccess = pol.ticksSuccess;
    }

    // Provider / scanner
    set(host, 'provider.active',
      `${af.activeProvider || '—'}${af.safeMode ? ' · safe' : ''}`,
      af.configured ? 'ok' : 'warn');
    set(host, 'provider.priority',
      af.priority?.length ? af.priority.join(' → ') : 'sem chain');

    const scanH = pol.health || (bot.liveEnabled ? 'starting' : 'stopped');
    set(host, 'scanner.label',
      bot.liveEnabled ? `LIVE · ${scanH}` : 'PAUSADO',
      bot.liveEnabled ? health(scanH) : 'warn');
    set(host, 'scanner.sub',
      `tracked ${pol.tracked ?? 0} · falhas seguidas ${pol.consecutiveFailures ?? 0}`);

    // Bot
    set(host, 'bot.monitored', String(bot.monitored ?? 0),
      Number(bot.monitored) > 0 ? 'ok' : 'warn');
    set(host, 'bot.minscore',  `minScore ${bot.minScore ?? '—'}`);

    // Sinais
    set(host, 'signals.sent', String(sig.sent ?? 0));
    set(host, 'signals.winrate', `winrate ${sig.winrate ?? 0}% · ROI ${sig.roi ?? 0}%`);

    // Poller
    set(host, 'poller.latency',
      pol.lastTickMs != null ? fmtMs(pol.lastTickMs) : '—');
    set(host, 'poller.lastTick',
      pol.lastTickAt ? new Date(pol.lastTickAt).toLocaleTimeString('pt-BR') : 'sem tick');

    const tpm = history.ticksOk.length
      ? Math.round(history.ticksOk[history.ticksOk.length - 1])
      : null;
    set(host, 'poller.tpm', tpm != null ? String(tpm) : '—',
      tpm != null && tpm > 0 ? 'ok' : 'warn');
    set(host, 'poller.cumulative',
      `ok ${pol.ticksSuccess ?? 0} · fail ${pol.ticksFailed ?? 0}`);

    // Processo
    set(host, 'proc.uptime', fmtUptime(proc.uptime), 'ok');
    set(host, 'proc.pid', `pid ${proc.pid ?? '—'}`);
    set(host, 'proc.rss',  fmtBytes(proc.memory?.rss));
    set(host, 'proc.heap', `heap ${fmtBytes(proc.memory?.heapUsed)} / ${fmtBytes(proc.memory?.heapTotal)}`);

    // Score médio IA — vem de lastDecisions
    if (lastScoreAvg != null) {
      set(host, 'ia.score', `${lastScoreAvg}%`,
        lastScoreAvg >= 70 ? 'ok' : lastScoreAvg >= 50 ? 'warn' : 'err');
    } else {
      set(host, 'ia.score', '—');
    }

    // Erros
    if (!errs.length) {
      set(host, 'errors.list', { __html: '<span class="ops-empty">Nenhum erro recente — sistema estável.</span>' });
    } else {
      const items = errs.slice(0, 6).map((e) => `
        <div class="ops-error">
          <span class="ops-error-source">${esc(e.source || 'unknown')}</span>
          <span class="ops-error-msg">${esc(e.message || '—')}</span>
          <span class="ops-error-time">${e.at ? new Date(e.at).toLocaleTimeString('pt-BR') : ''}</span>
        </div>`).join('');
      set(host, 'errors.list', { __html: items });
    }

    // Decisões
    renderDecisions(host);

    // Sparklines
    spark(host, 'pollerLat', history.pollerLat, { fill: 'rgba(20,184,94,.12)' });
    spark(host, 'monitored', history.monitored);
    spark(host, 'ticksOk',   history.ticksOk);
    spark(host, 'memRss',    history.memRss, { color: '#fbbf24', fill: 'rgba(251,191,36,.14)' });

    set(host, 'footer.status', 'online');
    set(host, 'footer.time', `atualizado ${new Date().toLocaleTimeString('pt-BR')}`);

    // Observability hook
    if (Number.isFinite(pol.lastTickMs)) {
      window.__RT_DEBUG__?.pushPollerSample?.(pol.lastTickMs);
    }
    window.__RT_DEBUG_provider = af.activeProvider;
    window.__RT_DEBUG__?.tickRender?.('ops-status');
  }

  function paintError(host, msg) {
    set(host, 'footer.status', `erro — ${msg || 'desconhecido'}`);
    set(host, 'footer.time', new Date().toLocaleTimeString('pt-BR'));
  }

  function renderDecisions(host) {
    if (!lastDecisions.length) {
      set(host, 'decisions.list', { __html: '<span class="ops-empty">Sem decisões registradas ainda.</span>' });
      return;
    }
    const rows = lastDecisions.slice(0, 8).map((s) => {
      const t = s.created_at || s.createdAt || s.at;
      const time = t ? new Date(t).toLocaleTimeString('pt-BR') : '—';
      const home = s.match?.home || s.home || '—';
      const away = s.match?.away || s.away || '—';
      const market = s.market || s.payload?.market || '—';
      const conf = s.confidence ?? s.payload?.confidence ?? 0;
      const result = s.result || 'pending';
      const resClass = result === 'win' ? 'ops-ok'
                     : result === 'loss' ? 'ops-err' : 'ops-warn';
      return `
        <div class="ops-decision">
          <span class="ops-decision-time">${esc(time)}</span>
          <span class="ops-decision-match">${esc(home)} × ${esc(away)}</span>
          <span class="ops-decision-market">${esc(market)}</span>
          <span class="ops-decision-conf">${esc(conf)}%</span>
          <span class="ops-decision-result ${resClass}">${esc(result)}</span>
        </div>`;
    }).join('');
    set(host, 'decisions.list', { __html: rows });
  }

  /* ============================================================
     FETCH
     ============================================================ */
  async function fetchOps() {
    const headers = {};
    const tok = window.RobotrendAuth?.getToken?.();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const r = await fetch('/api/admin/ops', { headers, credentials: 'include' });
    window.RobotrendHeartbeat?.markRestActivity('/api/admin/ops', r.status);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function fetchDecisions() {
    try {
      const headers = {};
      const tok = window.RobotrendAuth?.getToken?.();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      const r = await fetch('/api/signals?limit=10', { headers, credentials: 'include' });
      window.RobotrendHeartbeat?.markRestActivity('/api/signals', r.status);
      if (!r.ok) return;
      const data = await r.json();
      lastDecisions = Array.isArray(data) ? data : (data.signals || []);
      // score médio
      const confs = lastDecisions
        .map((s) => Number(s.confidence ?? s.payload?.confidence))
        .filter(Number.isFinite);
      lastScoreAvg = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;
    } catch (_) {}
  }

  async function refreshAll() {
    if (!hosts.size) return;
    try {
      const data = await fetchOps();
      for (const host of hosts) paint(host, data);
    } catch (err) {
      for (const host of hosts) paintError(host, err.message);
    }
  }

  function mount(host) {
    if (!host || hosts.has(host)) return;
    host.classList.add('ops-status');
    host.innerHTML = template();
    hosts.add(host);
    refreshAll();
    fetchDecisions();
  }

  function autoMount() {
    document.querySelectorAll('[data-ops-status]').forEach(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  setInterval(refreshAll,     REFRESH_OPS_MS);
  setInterval(fetchDecisions, REFRESH_SIGNALS_MS);

  window.RobotrendOpsStatus = { mount, refresh: refreshAll };
})();
