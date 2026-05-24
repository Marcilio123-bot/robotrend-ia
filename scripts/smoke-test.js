'use strict';
/**
 * Smoke test — valida endpoints críticos.
 * Uso: node scripts/smoke-test.js [baseUrl]
 *   default: http://localhost:3010
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = process.argv[2] || 'http://localhost:3010';

function request(pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, BASE);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

const tests = [
  { name: 'GET /healthz', path: '/healthz', expect: 200 },
  { name: 'GET /readyz', path: '/readyz', expect: [200, 503] },
  { name: 'GET /api/health', path: '/api/health', expect: 200 },
  { name: 'GET / (frontend)', path: '/', expect: 200 },
  { name: 'GET /login.html', path: '/login.html', expect: 200 },
  { name: 'GET /manifest.json', path: '/manifest.json', expect: 200 },
  { name: 'POST /api/auth/login (sem body)', path: '/api/auth/login', method: 'POST', body: {}, expect: 400 },
  { name: 'GET /api/metrics (sem auth)', path: '/api/metrics', expect: 401 },
  { name: 'GET /api/signals (sem auth)', path: '/api/signals', expect: 401 },
  { name: 'GET /api/admin/overview (sem auth)', path: '/api/admin/overview', expect: 401 },
];

(async () => {
  console.log(`Smoke test → ${BASE}\n`);
  let fail = 0;
  for (const t of tests) {
    try {
      const r = await request(t.path, { method: t.method, body: t.body });
      const ok = Array.isArray(t.expect) ? t.expect.includes(r.status) : r.status === t.expect;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name}  →  ${r.status}`);
      if (!ok) fail++;
    } catch (e) {
      console.log(`FAIL  ${t.name}  →  ${e.message}`);
      fail++;
    }
  }
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} — ${tests.length - fail}/${tests.length}`);
  process.exit(fail === 0 ? 0 : 1);
})();
