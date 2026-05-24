/**
 * Robotrend IA — Admin Football Ops (painel)
 *
 * Pollar /diagnostics + /metrics a cada 3s, mostra:
 *   - estado poller, breaker, quota, sockets
 *   - cache hit ratio + latência
 *   - latência por endpoint (avg, p95)
 *   - erros, retries, stale-cache
 *   - throughput (eventos/seg, emits/seg, calls/seg)
 *   - rooms ativas
 *   - test hooks (force-fail)
 *   - process stats (mem, uptime)
 *
 * Também conecta no /football realtime e popula um stream live de eventos.
 */
(() => {
  'use strict';

  // Auto-refresh de 10s: equilibra observabilidade com carga no backend.
  // Os endpoints /diagnostics e /metrics são internos (sem custo de API-Football),
  // mas serializam JSON pesado — 3s tornava o painel ofensivo em mobile/dev.
  const REFRESH_MS = 10000;
  let paused = false;
  let timer = null;

  function $(s) { return document.querySelector(s); }
  function fmt(n, dig = 0) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: dig, maximumFractionDigits: dig }); }
  function fmtMs(n) { return n == null ? '—' : `${fmt(n, 1)} ms`; }
  function fmtMB(b) { return b == null ? '—' : `${(b / 1024 / 1024).toFixed(1)} MB`; }
  function fmtUptime(sec) {
    if (sec == null) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  async function api(path, opts) {
    if (window.RobotrendAuth?.api) return window.RobotrendAuth.api(path, opts);
    const headers = { ...(opts?.headers || {}) };
    const token = localStorage.getItem('rt_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function sumCounter(arr) {
    if (!Array.isArray(arr)) return 0;
    return arr.reduce((s, x) => s + (Number(x.value) || 0), 0);
  }

  function flattenHistogram(h) {
    // h = [{ labels, count, avg, p95, ... }]
    if (!Array.isArray(h)) return [];
    return h.map((s) => ({ ...s.labels, count: s.count, avg: s.avg, p95: s.p95, p99: s.p99, max: s.max }));
  }

  function refreshUI(diag, met) {
    const api_ = diag.api || {};
    const poller = diag.poller || {};
    const breaker = api_.breaker || {};
    const quota = api_.quota || {};
    const sockets = diag.sockets || {};

    // ---- KPIs ----
    $('#kpi-poller-state').textContent = poller.running ? 'RUNNING' : 'STOPPED';
    $('#kpi-poller-state').className = `big ${poller.running ? 'pos' : 'neg'}`;
    $('#kpi-poller-sub').textContent = `interval ${poller.intervalMs || '—'}ms · tracked ${poller.tracked || 0}`;

    $('#kpi-cb').textContent = breaker.state || '—';
    $('#kpi-cb').className = `big ${breaker.state === 'CLOSED' ? 'pos' : breaker.state === 'HALF_OPEN' ? 'warn' : 'neg'}`;
    $('#kpi-cb-sub').textContent = `${breaker.totals?.fail || 0} falhas · ${breaker.totals?.trips || 0} trips · cooldown ${breaker.cooldownMs}ms`;

    if (quota.dailyLimit) {
      const pct = (quota.dailyRemaining / quota.dailyLimit) * 100;
      $('#kpi-quota').textContent = `${quota.dailyRemaining}/${quota.dailyLimit}`;
      $('#kpi-quota').className = `big ${pct < 10 ? 'neg' : pct < 25 ? 'warn' : 'pos'}`;
      $('#kpi-quota-sub').textContent = `min: ${quota.minuteRemaining ?? '—'}/${quota.minuteLimit ?? '—'} · ${pct.toFixed(1)}%`;
    } else {
      $('#kpi-quota').textContent = '—';
      $('#kpi-quota-sub').textContent = 'aguardando primeira resposta da API…';
    }

    if (sockets.available) {
      $('#kpi-sockets').textContent = sockets.sockets || 0;
      $('#kpi-sockets-sub').textContent = `${Object.keys(sockets.rooms || {}).length} rooms`;
    } else {
      $('#kpi-sockets').textContent = '—';
      $('#kpi-sockets-sub').textContent = 'realtime indisponível';
    }

    // ---- Cache ----
    const counters = met.metrics?.counters || {};
    const gauges = met.metrics?.gauges || {};
    const hits = sumCounter(counters['cachestore_hit_total']);
    const misses = sumCounter(counters['cachestore_miss_total']);
    const totalLookups = hits + misses;
    const ratio = totalLookups ? Math.round((hits / totalLookups) * 100) : 0;
    $('#cache-backend').textContent = api_.cacheStore?.backend || '—';
    $('#cache-ratio').textContent = totalLookups ? `${ratio}%` : '—';
    $('#cache-bar').style.width = `${ratio}%`;
    $('#cache-hits').textContent = fmt(hits);
    $('#cache-misses').textContent = fmt(misses);
    const sizeArr = gauges['cachestore_size'] || [];
    $('#cache-size').textContent = sizeArr.length ? sizeArr[0].value : '—';
    const cacheLat = (met.metrics?.histograms?.['cachestore_op_latency_ms'] || [])[0];
    $('#cache-lat').textContent = cacheLat ? fmtMs(cacheLat.avg) : '—';

    // ---- Latência por endpoint ----
    const lat = flattenHistogram(met.metrics?.histograms?.['apifootball_latency_ms']);
    const latRows = lat
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 10)
      .map((r) => `<tr><td>${escapeHtml(r.endpoint || '—')}</td><td>${fmt(r.count)}</td><td>${fmtMs(r.avg)}</td><td>${fmtMs(r.p95)}</td></tr>`)
      .join('');
    $('#lat-rows').innerHTML = latRows || '<tr><td colspan="4" style="color:var(--muted)">sem chamadas ainda</td></tr>';

    // ---- Erros ----
    $('#err-calls').textContent   = fmt(sumCounter(counters['apifootball_calls_total']));
    $('#err-4xx').textContent     = fmt(sumCounter(counters['apifootball_4xx_total']));
    $('#err-5xx').textContent     = fmt(sumCounter(counters['apifootball_5xx_total']));
    $('#err-429').textContent     = fmt(sumCounter(counters['apifootball_429_total']));
    $('#err-timeout').textContent = fmt(sumCounter(counters['apifootball_timeout_total']));
    $('#err-retries').textContent = fmt(sumCounter(counters['apifootball_retries_total']));
    $('#err-stale').textContent   = fmt(sumCounter(counters['apifootball_stale_served_total']));
    $('#err-dedup').textContent   = fmt(sumCounter(counters['apifootball_inflight_dedup_total']));

    // ---- Throughput ----
    const windows = met.metrics?.windows || {};
    $('#thr-events').textContent = `${windows.poller_events_window?.perSecond ?? 0}/s`;
    $('#thr-emits').textContent  = `${windows.socket_emit_window?.perSecond ?? 0}/s`;
    $('#thr-api').textContent    = `${windows.apifootball_calls_window?.perSecond ?? 0}/s`;
    const tick = (met.metrics?.histograms?.['poller_tick_duration_ms'] || [])[0];
    $('#thr-tick').textContent = tick ? fmtMs(tick.avg) : '—';

    // ---- Enricher (opcional, só renderiza se existir o elemento) ----
    const enricher = diag.enricher;
    const enrEl = $('#enricher-state');
    if (enrEl && enricher) {
      const subFix = (gauges['enricher_subscribed_fixtures'] || [])[0]?.value || 0;
      const queue = (gauges['enricher_queue_size'] || [])[0]?.value || 0;
      const emitted = sumCounter(counters['enricher_emitted_total']);
      const skipped = sumCounter(counters['enricher_skipped_total']);
      const failed = sumCounter(counters['enricher_failed_total']);
      const lat = (met.metrics?.histograms?.['enricher_latency_ms'] || [])[0];
      enrEl.innerHTML = `
        <div>state: <strong>${enricher.running ? 'ON' : 'OFF'}</strong> · refresh ${enricher.refreshMs}ms · ${enricher.tracked} tracked · ${enricher.inflight} inflight</div>
        <div>subscribed fixtures: <strong>${subFix}</strong> · queue: <strong>${queue}</strong></div>
        <div>emitted: <strong>${fmt(emitted)}</strong> · skipped: ${fmt(skipped)} · failed: ${fmt(failed)} · avg ${lat ? fmtMs(lat.avg) : '—'}</div>
      `;
    }

    // ---- Sockets ----
    $('#sock-now').textContent   = sockets.sockets || 0;
    $('#sock-open').textContent  = fmt(sumCounter(counters['socket_open_total']));
    $('#sock-close').textContent = fmt(sumCounter(counters['socket_close_total']));
    $('#sock-sub').textContent   = fmt(sumCounter(counters['socket_subscribe_total']));
    $('#sock-drop').textContent  = fmt(sumCounter(counters['socket_emit_dropped_total']));
    const roomsEntries = Object.entries(sockets.rooms || {}).sort((a, b) => b[1] - a[1]).slice(0, 30);
    $('#rooms-list').innerHTML = roomsEntries.length
      ? roomsEntries.map(([r, n]) => `<span class="pill info">${escapeHtml(r)} <strong>${n}</strong></span>`).join(' ')
      : '<span style="color:var(--muted)">sem rooms ativas além de lobby</span>';

    // ---- Process ----
    const proc = diag.process || met.metrics?.process || {};
    $('#proc-uptime').textContent     = fmtUptime(met.metrics?.uptimeSec);
    $('#proc-rss').textContent        = fmtMB(proc.rss);
    $('#proc-heap').textContent       = fmtMB(proc.heapUsed);
    $('#proc-heap-total').textContent = fmtMB(proc.heapTotal);
    $('#proc-external').textContent   = fmtMB(proc.external);
    $('#proc-node').textContent       = diag.versions?.node || '—';
    $('#proc-plat').textContent       = `${diag.versions?.platform || ''} ${diag.versions?.arch || ''}`;

    $('#last-update').textContent = `atualizado ${new Date().toLocaleTimeString('pt-BR')}`;
  }

  async function tick() {
    if (paused) return;
    try {
      const [diag, met] = await Promise.all([
        api('/api/football/diagnostics'),
        api('/api/football/metrics'),
      ]);
      refreshUI(diag, met);
    } catch (e) {
      console.warn('admin diag falhou', e.message);
      $('#last-update').innerHTML = `<span class="pill err"><span class="dot"></span>${escapeHtml(e.message)}</span>`;
    }
  }

  // ============================================================
  // Test hooks
  // ============================================================
  function bindTestHooks() {
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.addEventListener('click', async () => {
        const mode = b.dataset.mode || null;
        try {
          const r = await api('/api/football/test/force-fail', {
            method: 'POST',
            body: JSON.stringify({ mode: mode || null }),
          });
          $('#force-state').textContent = `mode atual: ${r.mode || 'NORMAL'} · breaker: ${r.breaker?.state}`;
          appendStream('test:force-fail', { mode: r.mode || 'NORMAL' });
        } catch (e) {
          $('#force-state').innerHTML = `<span class="pill err"><span class="dot"></span>${escapeHtml(e.message)}</span>`;
        }
      });
    });

    // Estado inicial
    api('/api/football/test/force-fail').then((r) => {
      $('#force-state').textContent = `mode atual: ${r.mode || 'NORMAL'} · breaker: ${r.breaker?.state}`;
    }).catch(() => {});
  }

  // ============================================================
  // Live stream de eventos (socket)
  // ============================================================
  function appendStream(name, payload) {
    const wrap = $('#event-stream');
    if (!wrap) return;
    const row = document.createElement('div');
    row.className = 'row';
    const t = new Date().toLocaleTimeString('pt-BR');
    const short = JSON.stringify(payload || {}).slice(0, 120);
    row.innerHTML = `<span class="ts">${t}</span><span class="ev">${escapeHtml(name)}</span><span>${escapeHtml(short)}</span>`;
    wrap.prepend(row);
    while (wrap.childNodes.length > 80) wrap.removeChild(wrap.lastChild);
  }

  function initSocket() {
    if (!window.io) return;
    const sock = io('/football', { transports: ['websocket', 'polling'] });
    sock.on('hello',           (p) => appendStream('hello', p));
    sock.on('tick',            (p) => appendStream('tick', { matches: p.matches?.length, src: p.source }));
    sock.on('match:upsert',    (p) => appendStream('match:upsert', { id: p.match?.id, home: p.match?.home }));
    sock.on('match:update',    (p) => appendStream('match:update', { id: p.match?.id, deltas: p.deltas }));
    sock.on('match:remove',    (p) => appendStream('match:remove', p));
    sock.on('fixture:goal',    (p) => appendStream('fixture:goal', { id: p.match?.id, side: p.side }));
    sock.on('fixture:corner',  (p) => appendStream('fixture:corner', { id: p.match?.id, side: p.side }));
    sock.on('fixture:card',    (p) => appendStream('fixture:card', { id: p.match?.id, color: p.color }));
    sock.on('fixture:pressure',(p) => appendStream('fixture:pressure', { id: p.match?.id, pressure: p.pressure }));
    sock.on('fixture:btts-near',(p) => appendStream('fixture:btts-near', { id: p.match?.id, reason: p.reason }));
    sock.on('quota:low',       (p) => appendStream('quota:low', p));
    sock.on('circuit:open',    (p) => appendStream('circuit:open', p));
    sock.on('circuit:close',   (p) => appendStream('circuit:close', p));
    sock.on('poller:error',    (p) => appendStream('poller:error', p));
    sock.on('signal:fire',     (p) => appendStream('signal:fire', { type: p.type, conf: p.confidence, match: p.matchId, sug: p.suggestion }));
    sock.on('match:enriched',  (p) => appendStream('match:enriched', {
      id: p.match?.id,
      teams: `${p.match?.home || ''} vs ${p.match?.away || ''}`,
      corners: p.match?.stats?.corners?.total,
      sot: p.match?.stats?.shotsOnTarget?.total,
      pressure: p.match?.perMinute?.pressureIndex,
      btts: p.match?.bttsLikelihood,
    }));
    sock.on('match:enrich-fail', (p) => appendStream('match:enrich-fail', p));
  }

  // ============================================================
  // Boot
  // ============================================================
  function bindControls() {
    $('#btn-pause').addEventListener('click', () => {
      paused = !paused;
      $('#btn-pause').textContent = paused ? '▶ Continuar' : '⏸ Pausar';
      $('#auto-pill').innerHTML = paused
        ? '<span class="dot"></span>pausado'
        : '<span class="dot"></span>auto-refresh 10s';
      $('#auto-pill').className = paused ? 'pill warn' : 'pill';
    });
    $('#btn-refresh').addEventListener('click', tick);
  }

  function boot() {
    bindControls();
    bindTestHooks();
    initSocket();
    tick();
    timer = setInterval(tick, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
