/* ============================================================
   ROBOTREND IA — Sparkline (SVG, zero deps)
   ------------------------------------------------------------
   API:
     RobotrendSparkline.render(host, points, opts?)
       points: number[]
       opts: {
         width        — default 220
         height       — default 48
         color        — default 'var(--brand)'
         fill         — default 'rgba(20,184,94,.16)'
         showDots     — default false
         showArea     — default true
         min/max      — força range; senão usa min/max dos dados
       }

   Renderiza um <svg> dentro de `host`. Idempotente — substitui o
   conteúdo anterior. Útil para mostrar tendências curtas (ex.:
   ticks por minuto, latência, etc.) sem dependências de chart.js.
   ============================================================ */
(function () {
  'use strict';

  if (window.RobotrendSparkline) return;

  function render(host, points, opts = {}) {
    if (!host) return;
    const data = Array.isArray(points) ? points.filter(Number.isFinite) : [];
    if (data.length < 2) {
      host.innerHTML = `<div class="sparkline-empty">aguardando histórico…</div>`;
      return;
    }

    const w = opts.width  ?? 220;
    const h = opts.height ?? 48;
    const color = opts.color ?? 'var(--brand)';
    const fill  = opts.fill  ?? 'rgba(20,184,94,.16)';

    const min = Number.isFinite(opts.min) ? opts.min : Math.min(...data);
    const max = Number.isFinite(opts.max) ? opts.max : Math.max(...data);
    const range = (max - min) || 1;

    const pad = 2;
    const step = (w - pad * 2) / (data.length - 1);
    const yOf = (v) => h - pad - ((v - min) / range) * (h - pad * 2);

    let path = `M ${pad} ${yOf(data[0]).toFixed(2)}`;
    for (let i = 1; i < data.length; i++) {
      path += ` L ${(pad + i * step).toFixed(2)} ${yOf(data[i]).toFixed(2)}`;
    }
    const areaPath = `${path} L ${(pad + (data.length - 1) * step).toFixed(2)} ${h - pad} L ${pad} ${h - pad} Z`;

    const last = data[data.length - 1];

    const dots = opts.showDots
      ? data.map((v, i) => `<circle cx="${(pad + i * step).toFixed(2)}" cy="${yOf(v).toFixed(2)}" r="1.6" fill="${color}" />`).join('')
      : '';

    host.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="sparkline" role="img" aria-label="tendência">
        ${opts.showArea !== false ? `<path d="${areaPath}" fill="${fill}" stroke="none" />` : ''}
        <path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
        <circle cx="${(pad + (data.length - 1) * step).toFixed(2)}" cy="${yOf(last).toFixed(2)}" r="2.6" fill="${color}" />
      </svg>
    `;
  }

  window.RobotrendSparkline = { render };
})();
