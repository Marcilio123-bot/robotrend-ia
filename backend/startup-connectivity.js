/**
 * Robotrend IA — Diagnóstico de conectividade no boot
 *
 * Loga (sem expor secrets) quais serviços externos serão usados e
 * detecta configs típicas que causam getaddrinfo ENOTFOUND no Render.
 */
'use strict';

const dns = require('dns').promises;
const { envString, isOnRender, isProductionLike } = require('./startup-check');

const BAD_PGHOST_RENDER = new Set([
  'postgres', 'postgresql', 'db', 'database', 'localhost', '127.0.0.1',
  'host.docker.internal', 'mysql', 'redis',
]);

function maskHost(host) {
  if (!host) return '(vazio)';
  if (host.length <= 4) return '***';
  return `${host.slice(0, 8)}…${host.slice(-6)}`;
}

function parsePostgresUrl(url) {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url.replace(/^postgresql:/i, 'postgres:'));
    return {
      host: u.hostname || '',
      port: u.port || '5432',
      database: (u.pathname || '').replace(/^\//, '') || '',
      user: u.username || '',
    };
  } catch (e) {
    return { error: e.message };
  }
}

function resolveDbTarget() {
  const databaseUrl = envString('DATABASE_URL');
  const pgHost = envString('PGHOST');

  if (databaseUrl) {
    const parsed = parsePostgresUrl(databaseUrl);
    if (parsed?.error) {
      return { mode: 'DATABASE_URL', valid: false, error: parsed.error, rawLen: databaseUrl.length };
    }
    return {
      mode: 'DATABASE_URL',
      valid: true,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      ssl: envString('PGSSL') || '(auto)',
    };
  }

  if (pgHost) {
    return {
      mode: 'PGHOST',
      valid: true,
      host: pgHost,
      port: envString('PGPORT') || '5432',
      database: envString('PGDATABASE') || 'robotrend',
      user: envString('PGUSER') || '(set)',
      ssl: envString('PGSSL') || '(auto)',
    };
  }

  return { mode: 'none', valid: false };
}

function resolveHttpService(name, hostEnv, keyEnv) {
  const host = envString(hostEnv);
  const key = envString(keyEnv);
  return {
    name,
    host: host || '(default)',
    key: key ? `set(${key.length})` : 'MISSING',
    configured: !!(key && host),
  };
}

function checkRenderPgPitfalls(db) {
  const issues = [];
  if (!isOnRender()) return issues;

  if (envString('PGHOST') && envString('DATABASE_URL')) {
    issues.push('PGHOST está definido junto com DATABASE_URL — o pool usa só DATABASE_URL (PGHOST ignorado).');
  }

  if (db.mode === 'PGHOST' && BAD_PGHOST_RENDER.has((db.host || '').toLowerCase())) {
    issues.push(
      `PGHOST="${db.host}" não resolve no Render (placeholder Docker). ` +
      'Remova PGHOST e use DATABASE_URL via "Add from Database" → robotrend-pg → connectionString.'
    );
  }

  if (db.mode === 'DATABASE_URL' && db.valid && !db.host) {
    issues.push('DATABASE_URL sem hostname — connection string malformada.');
  }

  if (db.mode === 'none' && isProductionLike()) {
    issues.push('DATABASE_URL ausente — vincule o banco robotrend-pg no Web Service.');
  }

  return issues;
}

async function dnsProbe(host, label) {
  if (!host || host === '(vazio)' || host.includes('…')) return { label, host, ok: false, skip: true };
  try {
    await dns.lookup(host, { timeout: 4000 });
    return { label, host: maskHost(host), ok: true };
  } catch (e) {
    return { label, host: maskHost(host), ok: false, code: e.code || '', message: e.message };
  }
}

/**
 * Imprime relatório síncrono no boot (antes de db.init).
 */
function printConnectivityReport() {
  const db = resolveDbTarget();
  const redisUrl = envString('REDIS_URL');
  let redisHost = '';
  if (redisUrl) {
    try { redisHost = new URL(redisUrl).hostname; } catch { redisHost = '(URL inválida)'; }
  }

  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════════╗',
    '║  [STARTUP CONNECTIVITY] Relatório de serviços externos           ║',
    '╚══════════════════════════════════════════════════════════════════╝',
    `  NODE_ENV=${envString('NODE_ENV') || 'development'}  RENDER=${isOnRender() ? 'yes' : 'no'}`,
    `  PORT=${envString('PORT') || '3010'}`,
    '',
    '  ── PostgreSQL (OBRIGATÓRIO em produção) ──',
    `    modo=${db.mode}  host=${maskHost(db.host)}  port=${db.port || '—'}  db=${db.database || '—'}`,
    `    user=${db.user ? 'set' : 'MISSING'}  ssl=${db.ssl || '—'}  DATABASE_URL=${envString('DATABASE_URL') ? `set(${envString('DATABASE_URL').length})` : 'MISSING'}`,
    `    PGHOST=${envString('PGHOST') ? envString('PGHOST') : '(não setado)'}`,
    '',
    '  ── HTTP público / CORS / WSS ──',
    `    RENDER_EXTERNAL_URL=${envString('RENDER_EXTERNAL_URL') || 'MISSING'}`,
    `    ALLOWED_ORIGINS=${envString('ALLOWED_ORIGINS') || '(auto via Render)'}`,
    `    APP_URL=${envString('APP_URL') || '(auto)'}`,
    '',
    '  ── Providers live (failover hibrido) ──',
    `    FOOTBALL_PROVIDER_PRIORITY=${envString('FOOTBALL_PROVIDER_PRIORITY') || '(default: bet365data,thesportsdb,football-data,apisports,demo)'}`,
    `    RAPIDAPI_KEY=${envString('RAPIDAPI_KEY') ? `set(${envString('RAPIDAPI_KEY').length})` : 'MISSING (bet365data desligado)'}`,
    `    RAPIDAPI_HOST=${envString('RAPIDAPI_HOST') || 'bet365data.p.rapidapi.com'}`,
    `    FOOTBALL_DATA_KEY=${envString('FOOTBALL_DATA_KEY') ? 'set' : 'MISSING'}`,
    `    API_FOOTBALL_KEY=${envString('API_FOOTBALL_KEY') ? 'set' : 'MISSING'}`,
    `    API_FOOTBALL_HOST=${envString('API_FOOTBALL_HOST') || 'v3.football.api-sports.io'}`,
    `    DEMO_MODE=${envString('DEMO_MODE') || 'false'}`,
    `    STRICT_REAL_ONLY=${envString('STRICT_REAL_ONLY') || '(auto prod=true)'}`,
    `    MATCH_CONSENSUS_MODE=${envString('MATCH_CONSENSUS_MODE') || '(auto)'}`,
    '',
    '  ── Cache / fila (opcional) ──',
    `    REDIS_URL=${redisUrl ? `set host=${maskHost(redisHost)}` : 'MISSING (memória)'}`,
    `    TELEGRAM_ENABLED=${envString('TELEGRAM_ENABLED') || 'false'}`,
    '',
  ];

  const pitfalls = checkRenderPgPitfalls(db);
  if (pitfalls.length) {
    lines.push('  ⚠️  Problemas detectados (corrija no Render → Environment):');
    pitfalls.forEach((p, i) => lines.push(`    ${i + 1}. ${p}`));
    lines.push('');
  }

  console.log(lines.join('\n'));
  return { db, pitfalls, redisHost };
}

/**
 * Probe DNS assíncrono (não bloqueia listen — roda logo após boot).
 */
async function probeOptionalDns(report) {
  const hosts = [];
  if (report.db?.host) hosts.push({ label: 'PostgreSQL', host: report.db.host });
  if (report.redisHost) hosts.push({ label: 'Redis', host: report.redisHost });

  const apiHost = envString('API_FOOTBALL_HOST') || 'v3.football.api-sports.io';
  hosts.push({ label: 'API-Football', host: apiHost.replace(/^https?:\/\//, '').split('/')[0] });

  const rapidHost = envString('RAPIDAPI_HOST') || 'bet365data.p.rapidapi.com';
  hosts.push({ label: 'Bet365Data', host: rapidHost.replace(/^https?:\/\//, '').split('/')[0] });

  const results = [];
  for (const h of hosts) {
    results.push(await dnsProbe(h.host, h.label));
  }

  const failed = results.filter((r) => r.ok === false && !r.skip);
  if (failed.length) {
    console.warn('[STARTUP CONNECTIVITY] DNS probe falhou:', failed);
  } else {
    console.log('[STARTUP CONNECTIVITY] DNS probe OK:', results.map((r) => r.label).join(', '));
  }
  return results;
}

module.exports = {
  resolveDbTarget,
  parsePostgresUrl,
  checkRenderPgPitfalls,
  printConnectivityReport,
  probeOptionalDns,
  maskHost,
};
