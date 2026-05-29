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
      createdAt: new Date().toISOString(),
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
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (map[k]) { sets.push(`${map[k]}=$${i++}`); vals.push(v); }
  }
  if (!sets.length) return findUserById(userId);
  vals.push(userId);
  await pool.query(`UPDATE users SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${i}`, vals);
  return findUserById(userId);
}

async function listUsers(limit = 100) {
  if (!useDatabase) {
    return Array.from(mem.users.values()).slice(0, limit);
  }
  const { rows } = await pool.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT $1`, [limit]);
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
  return {
    id: r.id, email: r.email, name: r.name,
    passwordHash: r.password_hash,
    plan: r.plan, role: r.role,
    // active default true para users criados antes da migration 003.
    active: r.active == null ? true : !!r.active,
    resetToken: r.reset_token, resetTokenExpires: Number(r.reset_expires),
    createdAt: r.created_at,
  };
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
  // signals
  saveSignal, listSignals, countTodaySignalsForUser, recordResult,
  // stats / admin
  getStats, bumpMonitored, adminOverview,
  // subs / payments
  upsertSubscription, savePayment, listPayments, findPaymentByExternalId,
  isPostgres: () => useDatabase,
};
