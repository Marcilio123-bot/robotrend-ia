/**
 * Robotrend IA — Camada de Persistência v3
 *
 *   - Modo PostgreSQL ou In-Memory
 *   - Tabelas: users, subscriptions, signals (com user_id), payments,
 *     signal_results (winrate por usuário)
 *   - API idêntica nos 2 modos.
 */

'use strict';

const crypto = require('crypto');

let Pool;
try { ({ Pool } = require('pg')); } catch (e) { Pool = null; }

/** Trim seguro — evita falso "vazio" e connection strings com newline do painel. */
function envDb(key) {
  const v = process.env[key];
  if (v == null) return '';
  return String(v).trim();
}

const databaseUrl = envDb('DATABASE_URL');
const pgHost = envDb('PGHOST');
const useDatabase = Boolean(
  (databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl)) || pgHost
) && Pool !== null;

function parseDbConfig() {
  if (databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl)) {
    try {
      const u = new URL(databaseUrl.replace(/^postgresql:/i, 'postgres:'));
      return {
        mode: 'DATABASE_URL',
        host: u.hostname || '',
        port: Number(u.port || 5432),
        database: (u.pathname || '').replace(/^\//, '') || 'robotrend',
        user: u.username || '',
        connectionString: databaseUrl,
      };
    } catch (e) {
      return { mode: 'DATABASE_URL', error: `DATABASE_URL inválida: ${e.message}` };
    }
  }
  if (pgHost) {
    return {
      mode: 'PGHOST',
      host: pgHost,
      port: Number(envDb('PGPORT') || 5432),
      database: envDb('PGDATABASE') || 'robotrend',
      user: envDb('PGUSER') || '',
      password: envDb('PGPASSWORD') ? '(set)' : '(missing)',
    };
  }
  return { mode: 'none' };
}

function formatDbConnectError(err, cfg) {
  const code = err?.code || '';
  const host = cfg?.host || '?';
  const lines = [
    `Falha ao conectar PostgreSQL (${code || 'erro'}).`,
    `  Alvo: modo=${cfg?.mode || '?'} host=${host} port=${cfg?.port || '?'}`,
  ];
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(String(err?.message || ''))) {
    lines.push(
      '  → getaddrinfo ENOTFOUND: o hostname do banco NÃO existe no DNS.',
      '  → Render: Environment → remova PGHOST=postgres (Docker) se existir.',
      '  → Render: Web Service → Add Environment Variable → From Database → robotrend-pg → DATABASE_URL.',
    );
  }
  if (cfg?.error) lines.push(`  → ${cfg.error}`);
  lines.push(`  Mensagem: ${err?.message || err}`);
  return lines.join('\n');
}

/**
 * Render Managed Postgres exige SSL. Bancos locais geralmente não.
 * Estratégia:
 *   - PGSSL=true|false   → respeita explicitamente
 *   - DATABASE_URL inclui ?sslmode=require → liga
 *   - DATABASE_URL aponta para host *.render.com / *.aws / *.fly.dev → liga
 *   - NODE_ENV=production e PGHOST não localhost → liga (default seguro)
 *   - caso contrário → desliga (dev local)
 */
function shouldUseSsl() {
  const flag = String(process.env.PGSSL || '').toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'require')  return true;
  if (flag === 'false' || flag === '0' || flag === 'disable') return false;

  const url = databaseUrl || '';
  if (/sslmode=require|sslmode=verify/i.test(url)) return true;
  if (/\.render\.com|\.aws|\.fly\.dev|\.supabase\.|\.neon\.tech|\.cloud\.timescale|\.heroku/i.test(url)) return true;

  const host = pgHost.toLowerCase();
  if (host && host !== 'localhost' && !host.startsWith('127.')) {
    if ((process.env.NODE_ENV || '') === 'production' || (process.env.NODE_ENV || '') === 'staging') {
      return true;
    }
  }
  return false;
}

let pool = null;
if (useDatabase) {
  const cfg = parseDbConfig();
  if (cfg.error) {
    throw new Error(`[db] ${cfg.error}`);
  }
  const ssl = shouldUseSsl() ? { rejectUnauthorized: false } : false;
  const poolOpts = cfg.mode === 'DATABASE_URL'
    ? { connectionString: cfg.connectionString, ssl }
    : {
        host: cfg.host,
        port: cfg.port,
        user: envDb('PGUSER'),
        password: envDb('PGPASSWORD'),
        database: cfg.database,
        ssl,
      };
  pool = new Pool({
    ...poolOpts,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10_000),
    idleTimeoutMillis: 30_000,
  });
  console.log(
    `[db] Pool configurado · modo=${cfg.mode} host=${cfg.host || '?'} ssl=${ssl ? 'on' : 'off'}`
  );
}

/* ============================================================
   IN-MEMORY STORE
   ============================================================ */
const mem = {
  users: new Map(),         // id -> user
  usersByEmail: new Map(),  // email -> id
  signals: [],
  subscriptions: new Map(), // userId -> sub
  payments: [],
  stats: { monitored: 0 },
};

function uuid() { return crypto.randomBytes(8).toString('hex'); }
function todayKey(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }

/* ============================================================
   INIT
   ============================================================ */
const MIGRATIONS = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        name          TEXT,
        password_hash TEXT NOT NULL,
        plan          TEXT DEFAULT 'FREE',
        role          TEXT DEFAULT 'user',
        reset_token   TEXT,
        reset_expires BIGINT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        plan        TEXT NOT NULL,
        provider    TEXT,
        external_id TEXT,
        status      TEXT,
        started_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS payments (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
        provider    TEXT,
        amount_brl  NUMERIC(10,2),
        plan        TEXT,
        external_id TEXT,
        status      TEXT,
        raw         JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS signals (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
        match_id    TEXT,
        home        TEXT NOT NULL,
        away        TEXT NOT NULL,
        league      TEXT,
        market      TEXT NOT NULL,
        suggestion  TEXT,
        confidence  INTEGER,
        odd         NUMERIC(6,2),
        risk        TEXT,
        verdict     TEXT,
        payload     JSONB,
        result      TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  },
  {
    name: '002_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_signals_created   ON signals(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_user      ON signals(user_id);
      CREATE INDEX IF NOT EXISTS idx_signals_market    ON signals(market);
      CREATE INDEX IF NOT EXISTS idx_signals_league    ON signals(league);
      CREATE INDEX IF NOT EXISTS idx_signals_result    ON signals(result);
      CREATE INDEX IF NOT EXISTS idx_payments_user     ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_subs_expires      ON subscriptions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_users_plan        ON users(plan);
    `,
  },
  {
    // Coluna usada pelo admin pra bloquear/desbloquear usuários sem deletar.
    // auth.js rejeita login com active=false. updateUser aceita patch.active.
    name: '003_users_active',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
      CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
    `,
  },
  {
    name: '004_subscription_fields',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'active';
      CREATE INDEX IF NOT EXISTS idx_users_subscription_status ON users(subscription_status);
      CREATE INDEX IF NOT EXISTS idx_users_expires_at ON users(expires_at);
      CREATE INDEX IF NOT EXISTS idx_users_blocked ON users(blocked);

      CREATE TABLE IF NOT EXISTS admin_logs (
        id            SERIAL PRIMARY KEY,
        admin_id      TEXT,
        admin_email   TEXT,
        action        TEXT NOT NULL,
        target_user_id TEXT,
        target_email  TEXT,
        details       JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_logs_target ON admin_logs(target_user_id);
    `,
  },
  {
    // Analytics por usuário — contadores agregados + carimbos de atividade.
    //   last_login_at         → último login bem-sucedido
    //   last_seen_at          → última atividade autenticada (qualquer request)
    //   login_count           → total de logins
    //   games_analyzed_count  → quantos jogos o usuário abriu para analisar
    //   signals_viewed_count  → quantos sinais o usuário visualizou
    name: '005_user_analytics',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS games_analyzed_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS signals_viewed_count INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);
    `,
  },
];

async function init() {
  const env = process.env.NODE_ENV || 'development';
  if (!useDatabase) {
    if (env === 'production' || env === 'staging') {
      throw new Error(
        '[db] PostgreSQL obrigatório em produção/staging. Defina DATABASE_URL (Render: Add from Database → robotrend-pg).'
      );
    }
    console.log('[db] Modo in-memory ativo (apenas desenvolvimento).');
    try {
      const sub = require('./subscription');
      await sub.migrateExistingUsers(module.exports);
      await sub.repairDegradedPrivilegedUsers(module.exports);
    } catch (migrateErr) {
      console.warn('[db] migração assinaturas (mem):', migrateErr.message);
    }
    return;
  }

  const cfg = parseDbConfig();
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    const msg = formatDbConnectError(e, cfg);
    console.error('[db] ENOTFOUND / conexão falhou:\n' + msg);
    const wrapped = new Error(msg);
    wrapped.code = e.code;
    wrapped.cause = e;
    throw wrapped;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    for (const m of MIGRATIONS) {
      const { rows } = await pool.query(`SELECT 1 FROM migrations WHERE name=$1`, [m.name]);
      if (rows.length) continue;
      await pool.query(m.sql);
      await pool.query(`INSERT INTO migrations(name) VALUES($1)`, [m.name]);
      console.log(`[db] migration aplicada: ${m.name}`);
    }
    console.log(`[db] PostgreSQL conectado (${cfg.mode} → ${cfg.host})`);
    try {
      const sub = require('./subscription');
      await sub.migrateExistingUsers(module.exports);
      await sub.repairDegradedPrivilegedUsers(module.exports);
    } catch (migrateErr) {
      console.warn('[db] migração assinaturas:', migrateErr.message);
    }
  } catch (e) {
    if (e.code === 'ENOTFOUND' || /getaddrinfo/i.test(e.message || '')) {
      throw new Error(formatDbConnectError(e, cfg));
    }
    throw e;
  }
}

function getPool() {
  return pool;
}

/**
 * Cleanup job — remove sinais antigos com resultado definitivo.
 * @param {number} days  - sinais com result definido mais antigos que N dias
 */
async function cleanupOldSignals(days = 90) {
  if (!useDatabase) {
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const before = mem.signals.length;
    mem.signals = mem.signals.filter(
      (s) => !(s.result && s.result !== 'pending' && new Date(s.created_at).getTime() < cutoff)
    );
    return before - mem.signals.length;
  }
  const { rowCount } = await pool.query(
    `DELETE FROM signals WHERE result IS NOT NULL AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [String(days)]
  );
  return rowCount;
}

/* ============================================================
   USERS
   ============================================================ */
async function createUser({ email, name, passwordHash, plan = 'FREE', role = 'user' }) {
  if (!useDatabase) {
    const id = uuid();
    const user = {
      id, email, name, passwordHash, plan, role,
      active: true,
      blocked: false,
      blockedReason: null,
      subscriptionStatus: 'active',
      expiresAt: null,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      lastSeenAt: null,
      loginCount: 0,
      gamesAnalyzedCount: 0,
      signalsViewedCount: 0,
    };
    mem.users.set(id, user);
    mem.usersByEmail.set(email, id);
    return user;
  }
  const id = uuid();
  await pool.query(
    `INSERT INTO users (id,email,name,password_hash,plan,role,active) VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
    [id, email, name, passwordHash, plan, role]
  );
  return findUserById(id);
}

async function findUserById(id) {
  if (!useDatabase) return mem.users.get(id) || null;
  const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
  return rows[0] ? mapUserRow(rows[0]) : null;
}

async function findUserByEmail(email) {
  if (!useDatabase) {
    const id = mem.usersByEmail.get(email);
    return id ? mem.users.get(id) : null;
  }
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  return rows[0] ? mapUserRow(rows[0]) : null;
}

async function findUserByResetToken(token) {
  if (!useDatabase) {
    for (const u of mem.users.values()) {
      if (u.resetToken === token && u.resetTokenExpires > Date.now()) return u;
    }
    return null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE reset_token=$1 AND reset_expires > $2`,
    [token, Date.now()]
  );
  return rows[0] ? mapUserRow(rows[0]) : null;
}

async function setResetToken(userId, token, expires) {
  if (!useDatabase) {
    const u = mem.users.get(userId);
    if (u) { u.resetToken = token; u.resetTokenExpires = expires; }
    return;
  }
  await pool.query(
    `UPDATE users SET reset_token=$1, reset_expires=$2, updated_at=NOW() WHERE id=$3`,
    [token, expires, userId]
  );
}

async function updateUser(userId, patch) {
  if (!useDatabase) {
    const u = mem.users.get(userId);
    if (!u) return null;
    if (typeof patch.active === 'boolean') {
      patch.blocked = !patch.active;
      if (!patch.active) patch.subscriptionStatus = 'blocked';
      else if (!patch.subscriptionStatus) patch.subscriptionStatus = 'active';
    }
    if (typeof patch.blocked === 'boolean' && patch.active === undefined) {
      patch.active = !patch.blocked;
      if (patch.blocked) patch.subscriptionStatus = 'blocked';
    }
    Object.assign(u, patch);
    return u;
  }
  const map = {
    passwordHash: 'password_hash',
    resetToken: 'reset_token',
    resetTokenExpires: 'reset_expires',
    plan: 'plan',
    role: 'role',
    name: 'name',
    active: 'active',
    email: 'email',
    expiresAt: 'expires_at',
    blocked: 'blocked',
    blockedReason: 'blocked_reason',
    subscriptionStatus: 'subscription_status',
  };
  const sets = [];
  const vals = [];
  let i = 1;
  if (typeof patch.active === 'boolean') {
    patch.blocked = !patch.active;
    if (!patch.active) patch.subscriptionStatus = 'blocked';
    else if (!patch.subscriptionStatus) patch.subscriptionStatus = 'active';
  }
  if (typeof patch.blocked === 'boolean' && patch.active === undefined) {
    patch.active = !patch.blocked;
    if (patch.blocked) patch.subscriptionStatus = 'blocked';
  }
  for (const [k, v] of Object.entries(patch)) {
    if (map[k]) { sets.push(`${map[k]}=$${i++}`); vals.push(v); }
  }
  if (!sets.length) return findUserById(userId);
  vals.push(userId);
  await pool.query(`UPDATE users SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${i}`, vals);
  return findUserById(userId);
}

async function listUsers(limit = 100, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  const planF = filters.plan ? String(filters.plan).toUpperCase() : '';
  const statusF = filters.status ? String(filters.status).toLowerCase() : '';

  if (!useDatabase) {
    let list = Array.from(mem.users.values());
    if (q) {
      list = list.filter((u) =>
        String(u.email || '').toLowerCase().includes(q) ||
        String(u.name || '').toLowerCase().includes(q)
      );
    }
    if (planF) list = list.filter((u) => String(u.plan || '').toUpperCase() === planF);
    if (statusF) list = list.filter((u) => String(u.subscriptionStatus || 'active').toLowerCase() === statusF);
    return list.slice(0, limit);
  }

  const clauses = [];
  const vals = [];
  let i = 1;
  if (q) {
    clauses.push(`(LOWER(email) LIKE $${i} OR LOWER(COALESCE(name,'')) LIKE $${i})`);
    vals.push(`%${q}%`);
    i++;
  }
  if (planF) {
    clauses.push(`UPPER(plan) = $${i}`);
    vals.push(planF);
    i++;
  }
  if (statusF) {
    clauses.push(`LOWER(subscription_status) = $${i}`);
    vals.push(statusF);
    i++;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  vals.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT $${i}`,
    vals
  );
  return rows.map(mapUserRow);
}

/**
 * Remove um usuário. Mantém os sinais (user_id vira NULL via FK ON DELETE SET NULL)
 * e pagamentos (idem), preservando histórico/auditoria.
 */
async function deleteUser(userId) {
  if (!useDatabase) {
    const u = mem.users.get(userId);
    if (!u) return false;
    mem.users.delete(userId);
    mem.usersByEmail.delete(u.email);
    mem.subscriptions.delete(userId);
    for (const s of mem.signals) if (s.userId === userId) s.userId = null;
    return true;
  }
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
  return rowCount > 0;
}

function mapUserRow(r) {
  const blocked = r.blocked != null ? !!r.blocked : r.active === false;
  return {
    id: r.id, email: r.email, name: r.name,
    passwordHash: r.password_hash,
    plan: r.plan, role: r.role,
    active: r.active == null ? !blocked : !!r.active,
    blocked,
    blockedReason: r.blocked_reason || null,
    subscriptionStatus: r.subscription_status || 'active',
    expiresAt: r.expires_at || null,
    resetToken: r.reset_token, resetTokenExpires: Number(r.reset_expires),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastLoginAt: r.last_login_at || null,
    lastSeenAt: r.last_seen_at || null,
    loginCount: Number(r.login_count || 0),
    gamesAnalyzedCount: Number(r.games_analyzed_count || 0),
    signalsViewedCount: Number(r.signals_viewed_count || 0),
  };
}

async function getSubscription(userId) {
  if (!useDatabase) return mem.subscriptions.get(userId) || null;
  const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE user_id=$1`, [userId]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    userId: r.user_id,
    plan: r.plan,
    provider: r.provider,
    externalId: r.external_id,
    status: r.status,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
  };
}

async function saveAdminLog(entry) {
  const row = {
    adminId: entry.adminId || null,
    adminEmail: entry.adminEmail || null,
    action: entry.action,
    targetUserId: entry.targetUserId || null,
    targetEmail: entry.targetEmail || null,
    details: entry.details || {},
    createdAt: new Date().toISOString(),
  };
  if (!useDatabase) {
    if (!mem.adminLogs) mem.adminLogs = [];
    mem.adminLogs.unshift({ id: mem.adminLogs.length + 1, ...row });
    if (mem.adminLogs.length > 500) mem.adminLogs.length = 500;
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO admin_logs (admin_id, admin_email, action, target_user_id, target_email, details)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [row.adminId, row.adminEmail, row.action, row.targetUserId, row.targetEmail, row.details]
  );
  return rows[0];
}

async function listAdminLogs(limit = 50) {
  if (!useDatabase) return (mem.adminLogs || []).slice(0, limit);
  const { rows } = await pool.query(
    `SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/* ============================================================
   SIGNALS
   ============================================================ */
async function saveSignal(signal, userId = null) {
  if (!useDatabase) {
    const record = {
      id: mem.signals.length + 1,
      userId,
      ...signal,
      created_at: signal.createdAt || new Date().toISOString(),
    };
    mem.signals.unshift(record);
    if (mem.signals.length > 1000) mem.signals.length = 1000;
    return record;
  }
  const { rows } = await pool.query(
    `INSERT INTO signals (user_id, match_id, home, away, league, market, suggestion, confidence, odd, risk, verdict, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      userId,
      signal.matchId,
      signal.home,
      signal.away,
      signal.league,
      signal.market,
      signal.suggestion,
      signal.confidence,
      signal.odd,
      signal.risk?.level,
      signal.verdict,
      signal,
    ]
  );
  return rows[0];
}

async function listSignals(limit = 50, userId = null) {
  if (!useDatabase) {
    const filtered = userId
      ? mem.signals.filter((s) => s.userId === userId)
      : mem.signals;
    return filtered.slice(0, limit);
  }
  if (userId) {
    const { rows } = await pool.query(
      `SELECT * FROM signals WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }
  const { rows } = await pool.query(`SELECT * FROM signals ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

async function countTodaySignalsForUser(userId) {
  const day = todayKey();
  if (!useDatabase) {
    return mem.signals.filter((s) => s.userId === userId && s.created_at?.slice(0, 10) === day).length;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM signals
     WHERE user_id=$1 AND created_at >= NOW()::date`,
    [userId]
  );
  return rows[0].c;
}

async function recordResult(id, result) {
  if (!useDatabase) {
    const s = mem.signals.find((x) => x.id === Number(id));
    if (s) s.result = result;
    return s;
  }
  await pool.query(`UPDATE signals SET result=$1 WHERE id=$2`, [result, id]);
  return null;
}

/* ============================================================
   STATS (globais e por usuário)
   ============================================================ */
async function getStats(userId = null) {
  if (!useDatabase) {
    const all = userId ? mem.signals.filter((s) => s.userId === userId) : mem.signals;
    const wins = all.filter((s) => s.result === 'win').length;
    const losses = all.filter((s) => s.result === 'loss').length;
    const pending = all.filter((s) => !s.result).length;
    const total = wins + losses;
    const winrate = total ? Math.round((wins / total) * 100) : 0;
    const roi = total ? Math.round(((wins * 0.85 - losses) / total) * 100) : 0;
    return {
      monitored: mem.stats.monitored,
      sent: all.length, wins, losses, pending, winrate, roi,
    };
  }
  const where = userId ? `WHERE user_id=$1` : ``;
  const params = userId ? [userId] : [];
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE result='win')::int AS wins,
       COUNT(*) FILTER (WHERE result='loss')::int AS losses,
       COUNT(*) FILTER (WHERE result IS NULL)::int AS pending,
       COUNT(*)::int AS sent
     FROM signals ${where}`,
    params
  );
  const r = rows[0];
  const total = r.wins + r.losses;
  const winrate = total ? Math.round((r.wins / total) * 100) : 0;
  const roi = total ? Math.round(((r.wins * 0.85 - r.losses) / total) * 100) : 0;
  return { monitored: mem.stats.monitored, ...r, winrate, roi };
}

function bumpMonitored(delta = 1) {
  mem.stats.monitored += delta;
}

/* ============================================================
   ADMIN
   ============================================================ */
async function adminOverview() {
  if (!useDatabase) {
    return {
      users: mem.users.size,
      paidUsers: Array.from(mem.users.values()).filter((u) => u.plan !== 'FREE').length,
      signals: mem.signals.length,
      payments: mem.payments.length,
      revenue: mem.payments.reduce((s, p) => s + Number(p.amount_brl || 0), 0),
    };
  }
  const [u, paid, sig, pay] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int c FROM users`),
    pool.query(`SELECT COUNT(*)::int c FROM users WHERE plan <> 'FREE'`),
    pool.query(`SELECT COUNT(*)::int c FROM signals`),
    pool.query(`SELECT COUNT(*)::int c, COALESCE(SUM(amount_brl),0) AS rev FROM payments WHERE status='paid'`),
  ]);
  return {
    users: u.rows[0].c,
    paidUsers: paid.rows[0].c,
    signals: sig.rows[0].c,
    payments: pay.rows[0].c,
    revenue: Number(pay.rows[0].rev),
  };
}

/* ============================================================
   USER ANALYTICS
   ------------------------------------------------------------
   Contadores agregados por usuário (login, jogos analisados,
   sinais visualizados) + carimbos de atividade. Eventos são
   registrados automaticamente nos hooks de login / view / análise.
   ============================================================ */

/** Colunas de contador permitidas para incremento (anti-SQL-injection). */
const METRIC_COLUMNS = {
  games_analyzed_count: 'gamesAnalyzedCount',
  signals_viewed_count: 'signalsViewedCount',
};

/** Registra um login bem-sucedido: incrementa total e atualiza carimbos. */
async function recordLogin(userId) {
  if (!userId) return;
  const now = new Date().toISOString();
  if (!useDatabase) {
    const u = mem.users.get(userId);
    if (!u) return;
    u.loginCount = (u.loginCount || 0) + 1;
    u.lastLoginAt = now;
    u.lastSeenAt = now;
    return;
  }
  await pool.query(
    `UPDATE users
       SET login_count = login_count + 1,
           last_login_at = NOW(),
           last_seen_at = NOW()
     WHERE id = $1`,
    [userId]
  );
}

/** Atualiza apenas o "último acesso" (chamado de forma throttled no auth). */
async function touchLastSeen(userId) {
  if (!userId) return;
  if (!useDatabase) {
    const u = mem.users.get(userId);
    if (u) u.lastSeenAt = new Date().toISOString();
    return;
  }
  await pool.query(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [userId]);
}

/**
 * Incrementa um contador de uso (games_analyzed_count | signals_viewed_count).
 * Também atualiza last_seen_at, já que um evento de uso é uma forma de acesso.
 */
async function incrementUserMetric(userId, column, delta = 1) {
  if (!userId) return;
  if (!METRIC_COLUMNS[column]) {
    throw new Error(`métrica inválida: ${column}`);
  }
  const step = Math.max(0, Math.min(1000, Number(delta) || 0));
  if (!step) return;
  if (!useDatabase) {
    const u = mem.users.get(userId);
    if (!u) return;
    const camel = METRIC_COLUMNS[column];
    u[camel] = (u[camel] || 0) + step;
    u.lastSeenAt = new Date().toISOString();
    return;
  }
  await pool.query(
    `UPDATE users SET ${column} = ${column} + $2, last_seen_at = NOW() WHERE id = $1`,
    [userId, step]
  );
}

/** Classifica um usuário como premium (qualquer plano pago). */
function isPremiumPlan(plan) {
  return String(plan || 'FREE').toUpperCase() !== 'FREE';
}

/** KPIs do painel de analytics: totais e atividade recente. */
async function analyticsSummary() {
  if (!useDatabase) {
    const all = Array.from(mem.users.values());
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const seen = (u) => (u.lastSeenAt ? new Date(u.lastSeenAt).getTime() : 0);
    return {
      totalUsers: all.length,
      activeToday: all.filter((u) => seen(u) >= startToday.getTime()).length,
      active7d: all.filter((u) => seen(u) >= sevenDaysAgo).length,
      premiumUsers: all.filter((u) => isPremiumPlan(u.plan)).length,
      freeUsers: all.filter((u) => !isPremiumPlan(u.plan)).length,
    };
  }
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE last_seen_at >= date_trunc('day', NOW()))::int AS active_today,
      COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_7d,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(plan,'FREE')) <> 'FREE')::int AS premium_users,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(plan,'FREE')) = 'FREE')::int AS free_users
    FROM users
  `);
  const r = rows[0];
  return {
    totalUsers: r.total_users,
    activeToday: r.active_today,
    active7d: r.active_7d,
    premiumUsers: r.premium_users,
    freeUsers: r.free_users,
  };
}

/** Mapeia um usuário para a linha exibida na tabela de analytics. */
function mapAnalyticsRow(u) {
  return {
    id: u.id,
    name: u.name || (u.email ? String(u.email).split('@')[0] : '—'),
    email: u.email,
    plan: u.plan || 'FREE',
    role: u.role || 'user',
    isPremium: isPremiumPlan(u.plan),
    createdAt: u.createdAt || u.created_at || null,
    lastSeenAt: u.lastSeenAt ?? u.last_seen_at ?? null,
    lastLoginAt: u.lastLoginAt ?? u.last_login_at ?? null,
    loginCount: Number(u.loginCount ?? u.login_count ?? 0),
    gamesAnalyzedCount: Number(u.gamesAnalyzedCount ?? u.games_analyzed_count ?? 0),
    signalsViewedCount: Number(u.signalsViewedCount ?? u.signals_viewed_count ?? 0),
  };
}

/**
 * Lista usuários para a tabela de analytics, com filtros:
 *   filter = 'active'   → mais ativos (ordena por uso total desc)
 *            'inactive' → inativos há mais de 7 dias
 *            'premium'  → apenas planos pagos
 *            'free'     → apenas plano FREE
 *            (vazio)    → todos, mais recentes primeiro
 */
async function analyticsUsers({ filter = '', q = '', limit = 200 } = {}) {
  const f = String(filter || '').toLowerCase();
  const search = String(q || '').trim().toLowerCase();
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));

  if (!useDatabase) {
    let list = Array.from(mem.users.values()).map(mapAnalyticsRow);
    if (search) {
      list = list.filter((u) =>
        String(u.email || '').toLowerCase().includes(search) ||
        String(u.name || '').toLowerCase().includes(search)
      );
    }
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const seen = (u) => (u.lastSeenAt ? new Date(u.lastSeenAt).getTime() : 0);
    const usageScore = (u) => u.loginCount + u.gamesAnalyzedCount + u.signalsViewedCount;
    if (f === 'premium') list = list.filter((u) => u.isPremium);
    else if (f === 'free') list = list.filter((u) => !u.isPremium);
    else if (f === 'inactive') list = list.filter((u) => seen(u) < sevenDaysAgo);

    if (f === 'active') list.sort((a, b) => usageScore(b) - usageScore(a));
    else if (f === 'inactive') list.sort((a, b) => seen(a) - seen(b));
    else list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return list.slice(0, cap);
  }

  const clauses = [];
  const vals = [];
  let i = 1;
  if (search) {
    clauses.push(`(LOWER(email) LIKE $${i} OR LOWER(COALESCE(name,'')) LIKE $${i})`);
    vals.push(`%${search}%`);
    i++;
  }
  if (f === 'premium') clauses.push(`UPPER(COALESCE(plan,'FREE')) <> 'FREE'`);
  else if (f === 'free') clauses.push(`UPPER(COALESCE(plan,'FREE')) = 'FREE'`);
  else if (f === 'inactive') clauses.push(`(last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '7 days')`);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let orderBy;
  if (f === 'active') orderBy = `ORDER BY (login_count + games_analyzed_count + signals_viewed_count) DESC, last_seen_at DESC NULLS LAST`;
  else if (f === 'inactive') orderBy = `ORDER BY last_seen_at ASC NULLS FIRST`;
  else orderBy = `ORDER BY created_at DESC`;

  vals.push(cap);
  const { rows } = await pool.query(
    `SELECT * FROM users ${where} ${orderBy} LIMIT $${i}`,
    vals
  );
  return rows.map(mapUserRow).map(mapAnalyticsRow);
}

/* ============================================================
   SUBSCRIPTIONS / PAYMENTS
   ============================================================ */
async function upsertSubscription(userId, sub) {
  if (!useDatabase) {
    mem.subscriptions.set(userId, { userId, ...sub });
    const u = mem.users.get(userId);
    if (u && sub.plan) u.plan = sub.plan;
    return mem.subscriptions.get(userId);
  }
  await pool.query(
    `INSERT INTO subscriptions(user_id, plan, provider, external_id, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id) DO UPDATE SET
       plan=EXCLUDED.plan, provider=EXCLUDED.provider, external_id=EXCLUDED.external_id,
       status=EXCLUDED.status, expires_at=EXCLUDED.expires_at`,
    [userId, sub.plan, sub.provider, sub.externalId, sub.status, sub.expiresAt]
  );
  if (sub.plan) {
    await pool.query(`UPDATE users SET plan=$1 WHERE id=$2`, [sub.plan, userId]);
  }
  return sub;
}

async function savePayment(p) {
  if (!useDatabase) {
    const record = { id: mem.payments.length + 1, ...p, created_at: new Date().toISOString() };
    mem.payments.push(record);
    return record;
  }
  const { rows } = await pool.query(
    `INSERT INTO payments(user_id, provider, amount_brl, plan, external_id, status, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [p.userId, p.provider, p.amount, p.plan, p.externalId, p.status, p.raw || {}]
  );
  return rows[0];
}

async function listPayments(limit = 100) {
  if (!useDatabase) return mem.payments.slice().reverse().slice(0, limit);
  const { rows } = await pool.query(`SELECT * FROM payments ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

/**
 * Busca um pagamento pelo `external_id` (ID do gateway).
 * Usado para idempotência de webhooks — se um payment.id já foi
 * processado com status 'paid', o webhook ignora reentregas.
 *
 * @param {string} externalId  ID do pagamento no gateway (ex.: MP payment.id)
 * @param {string} [provider]  filtro opcional (ex.: 'mercadopago')
 * @returns {Promise<object|null>}
 */
async function findPaymentByExternalId(externalId, provider) {
  if (!externalId) return null;
  const key = String(externalId);
  if (!useDatabase) {
    return mem.payments.find(p =>
      String(p.externalId) === key &&
      (!provider || p.provider === provider)
    ) || null;
  }
  const args = [key];
  let sql = `SELECT * FROM payments WHERE external_id = $1`;
  if (provider) { sql += ` AND provider = $2`; args.push(provider); }
  sql += ` ORDER BY created_at DESC LIMIT 1`;
  const { rows } = await pool.query(sql, args);
  return rows[0] || null;
}

module.exports = {
  init,
  getPool,
  parseDbConfig,
  cleanupOldSignals,
  // users
  createUser, findUserById, findUserByEmail, findUserByResetToken,
  setResetToken, updateUser, listUsers, deleteUser,
  getSubscription, saveAdminLog, listAdminLogs,
  // signals
  saveSignal, listSignals, countTodaySignalsForUser, recordResult,
  // stats / admin
  getStats, bumpMonitored, adminOverview,
  // user analytics
  recordLogin, touchLastSeen, incrementUserMetric, analyticsSummary, analyticsUsers,
  // subs / payments
  upsertSubscription, savePayment, listPayments, findPaymentByExternalId,
  isPostgres: () => useDatabase,
};
