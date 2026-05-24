/**
 * Robotrend IA — Football History
 *
 * Persiste:
 *   - fixtures (upsert: id, liga, times, kickoff, last_seen)
 *   - snapshots minuto-a-minuto (placar + stats agregados)
 *   - events log (gols, escanteios, cartões)
 *
 * Modo:
 *   - PostgreSQL quando disponível (db.isPostgres()), com migração on-init
 *   - Em desenvolvimento sem PG, mantém um ring buffer em memória por fixture
 *
 * Throttling: snapshot só é gravado se passou >= MIN_INTERVAL_MS desde o
 * último OU se houve mudança relevante (placar, escanteios, cartões).
 *
 * API:
 *   await history.init()
 *   await history.recordSnapshot(match)
 *   await history.recordEvent({ matchId, kind, payload })
 *   await history.listSnapshots(matchId, { limit })
 *   await history.listEvents(matchId, { limit })
 *   await history.listRecentFixtures({ limit })
 */

'use strict';

const db = require('../database');
const { logger } = require('../logger');
const log = logger.child({ module: 'footballHistory' });

const MIN_INTERVAL_MS = Number(process.env.FOOTBALL_SNAPSHOT_MIN_INTERVAL_MS || 25_000);
const RING_PER_MATCH  = Number(process.env.FOOTBALL_HISTORY_RING_MAX || 240); // ~ 1 por minuto x 4h
const EVENT_RING_MAX  = Number(process.env.FOOTBALL_EVENT_RING_MAX || 500);

/* ============================================================
   IN-MEMORY FALLBACK
   ============================================================ */
const mem = {
  fixtures: new Map(),  // fixtureId -> meta
  snapshots: new Map(), // fixtureId -> [snapshot...]
  events: [],           // [{ matchId, kind, payload, createdAt }]
  lastSnapAt: new Map(),
};

function pushRing(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

/* ============================================================
   MIGRATIONS (executadas em init quando PG ativo)
   ============================================================ */
const MIGRATIONS = [
  {
    name: 'football_001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS football_fixtures (
        fixture_id   BIGINT PRIMARY KEY,
        league_id    INT,
        league_name  TEXT,
        home_id      INT,
        away_id      INT,
        home_name    TEXT,
        away_name    TEXT,
        kickoff_at   TIMESTAMPTZ,
        status       TEXT,
        first_seen   TIMESTAMPTZ DEFAULT NOW(),
        last_seen    TIMESTAMPTZ DEFAULT NOW(),
        raw          JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_football_fixtures_kickoff ON football_fixtures(kickoff_at DESC);
      CREATE INDEX IF NOT EXISTS idx_football_fixtures_league  ON football_fixtures(league_id);
      CREATE INDEX IF NOT EXISTS idx_football_fixtures_status  ON football_fixtures(status);

      CREATE TABLE IF NOT EXISTS football_snapshots (
        id            BIGSERIAL PRIMARY KEY,
        fixture_id    BIGINT NOT NULL,
        minute        INT,
        score_home    INT, score_away INT,
        corners_home  INT, corners_away INT,
        shots_home    INT, shots_away INT,
        sot_home      INT, sot_away INT,
        dang_home     INT, dang_away INT,
        poss_home     INT,
        yellow_home   INT, yellow_away INT,
        red_home      INT, red_away INT,
        pressure_idx  REAL,
        captured_at   TIMESTAMPTZ DEFAULT NOW(),
        raw           JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_football_snap_fixture ON football_snapshots(fixture_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_football_snap_minute  ON football_snapshots(fixture_id, minute);

      CREATE TABLE IF NOT EXISTS football_events (
        id          BIGSERIAL PRIMARY KEY,
        fixture_id  BIGINT NOT NULL,
        kind        TEXT NOT NULL,
        side        TEXT,
        minute      INT,
        payload     JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_football_events_fixture ON football_events(fixture_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_football_events_kind    ON football_events(kind);
    `,
  },
];

let _pool = null;
let _ready = false;

async function init() {
  if (_ready) return;
  // db expõe pool internamente; usamos a mesma instância via require.
  const dbAny = require('../database');
  if (!dbAny.isPostgres()) {
    log.warn('footballHistory: modo memória (PG ausente)');
    _ready = true;
    return;
  }
  // Acessa pool diretamente via require interno do pg
  // (database.js mantém um pool exclusivo; fazemos init paralelo via pg)
  try {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL || '';
    const flag = String(process.env.PGSSL || '').toLowerCase();
    const host = (process.env.PGHOST || '').toLowerCase();
    const envProd = (process.env.NODE_ENV || '') === 'production' || (process.env.NODE_ENV || '') === 'staging';
    let ssl = false;
    if (flag === 'true' || flag === '1' || flag === 'require')        ssl = true;
    else if (flag === 'false' || flag === '0' || flag === 'disable')  ssl = false;
    else if (/sslmode=require|sslmode=verify/i.test(url))             ssl = true;
    else if (/\.render\.com|\.aws|\.fly\.dev|\.supabase\.|\.neon\.tech|\.cloud\.timescale|\.heroku/i.test(url)) ssl = true;
    else if (host && host !== 'localhost' && !host.startsWith('127.') && envProd) ssl = true;
    const sslOpt = ssl ? { rejectUnauthorized: false } : false;
    _pool = new Pool(
      url
        ? { connectionString: url, ssl: sslOpt }
        : {
            host: process.env.PGHOST,
            port: Number(process.env.PGPORT || 5432),
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE || 'robotrend',
            ssl: sslOpt,
          }
    );

    await _pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    for (const m of MIGRATIONS) {
      const { rows } = await _pool.query(`SELECT 1 FROM migrations WHERE name=$1`, [m.name]);
      if (rows.length) continue;
      await _pool.query(m.sql);
      await _pool.query(`INSERT INTO migrations(name) VALUES($1)`, [m.name]);
      log.info(`migration aplicada: ${m.name}`);
    }
    log.info('footballHistory: postgres pronto');
  } catch (e) {
    log.error('footballHistory init falhou — caindo para memória', { err: e.message });
    _pool = null;
  }
  _ready = true;
}

function usePg() { return !!_pool; }

/* ============================================================
   RECORD SNAPSHOT
   ============================================================ */
function shouldRecord(match, prev) {
  const id = String(match?.id || match?.fixtureId);
  const last = mem.lastSnapAt.get(id) || 0;
  const now = Date.now();
  if (now - last >= MIN_INTERVAL_MS) return true;
  if (!prev) return true;
  // Mudou placar, escanteios ou cartões? grava imediato.
  if (match.score?.home !== prev.score?.home) return true;
  if (match.score?.away !== prev.score?.away) return true;
  const cornersNow = (match.stats?.corners?.total) ?? match.corners ?? 0;
  const cornersBef = (prev.stats?.corners?.total) ?? prev.corners ?? 0;
  if (cornersNow !== cornersBef) return true;
  const yelNow = match.stats?.cards?.yellow?.total ?? 0;
  const yelBef = prev.stats?.cards?.yellow?.total ?? 0;
  if (yelNow !== yelBef) return true;
  const redNow = match.stats?.cards?.red?.total ?? 0;
  const redBef = prev.stats?.cards?.red?.total ?? 0;
  if (redNow !== redBef) return true;
  return false;
}

async function upsertFixture(match) {
  const id = Number(match.fixtureId || match.id);
  if (!id) return;
  const meta = {
    fixture_id  : id,
    league_id   : match.league?.id || null,
    league_name : match.league?.name || null,
    home_id     : match.teams?.home?.id || null,
    away_id     : match.teams?.away?.id || null,
    home_name   : match.home || match.teams?.home?.name || null,
    away_name   : match.away || match.teams?.away?.name || null,
    kickoff_at  : match.kickoffAt || match.date || null,
    status      : match.status || null,
  };
  if (!usePg()) {
    mem.fixtures.set(id, { ...meta, lastSeen: Date.now(), raw: match });
    return;
  }
  await _pool.query(
    `INSERT INTO football_fixtures
       (fixture_id, league_id, league_name, home_id, away_id, home_name, away_name, kickoff_at, status, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (fixture_id) DO UPDATE SET
       league_id   = COALESCE(EXCLUDED.league_id,  football_fixtures.league_id),
       league_name = COALESCE(EXCLUDED.league_name, football_fixtures.league_name),
       home_name   = COALESCE(EXCLUDED.home_name,  football_fixtures.home_name),
       away_name   = COALESCE(EXCLUDED.away_name,  football_fixtures.away_name),
       kickoff_at  = COALESCE(EXCLUDED.kickoff_at, football_fixtures.kickoff_at),
       status      = EXCLUDED.status,
       last_seen   = NOW(),
       raw         = EXCLUDED.raw`,
    [
      meta.fixture_id, meta.league_id, meta.league_name,
      meta.home_id, meta.away_id, meta.home_name, meta.away_name,
      meta.kickoff_at, meta.status, match,
    ]
  );
}

async function recordSnapshot(match, { prev } = {}) {
  if (!_ready) await init();
  const id = Number(match.fixtureId || match.id);
  if (!id) return;

  if (!shouldRecord(match, prev)) return;
  mem.lastSnapAt.set(String(id), Date.now());

  await upsertFixture(match);

  const c = match.stats?.corners || {};
  const s = match.stats?.shots   || {};
  const sot = match.stats?.shotsOnTarget || {};
  const d = match.stats?.dangerousAttacks || {};
  const cards = match.stats?.cards || { yellow: {}, red: {} };
  const poss = match.stats?.possession?.home || null;
  const press = match.perMinute?.pressureIndex || null;

  const snap = {
    fixture_id   : id,
    minute       : match.minute || 0,
    score_home   : match.score?.home || 0,
    score_away   : match.score?.away || 0,
    corners_home : c.home ?? null, corners_away: c.away ?? null,
    shots_home   : s.home ?? null, shots_away  : s.away ?? null,
    sot_home     : sot.home ?? null, sot_away  : sot.away ?? null,
    dang_home    : d.home ?? null, dang_away   : d.away ?? null,
    poss_home    : poss,
    yellow_home  : cards.yellow?.home ?? null, yellow_away: cards.yellow?.away ?? null,
    red_home     : cards.red?.home ?? null,    red_away   : cards.red?.away ?? null,
    pressure_idx : press,
    captured_at  : new Date().toISOString(),
  };

  if (!usePg()) {
    const list = mem.snapshots.get(String(id)) || [];
    pushRing(list, snap, RING_PER_MATCH);
    mem.snapshots.set(String(id), list);
    return;
  }
  try {
    await _pool.query(
      `INSERT INTO football_snapshots
         (fixture_id, minute, score_home, score_away, corners_home, corners_away,
          shots_home, shots_away, sot_home, sot_away, dang_home, dang_away,
          poss_home, yellow_home, yellow_away, red_home, red_away, pressure_idx, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        snap.fixture_id, snap.minute, snap.score_home, snap.score_away,
        snap.corners_home, snap.corners_away, snap.shots_home, snap.shots_away,
        snap.sot_home, snap.sot_away, snap.dang_home, snap.dang_away,
        snap.poss_home, snap.yellow_home, snap.yellow_away,
        snap.red_home, snap.red_away, snap.pressure_idx, match,
      ]
    );
  } catch (e) {
    log.warn('recordSnapshot falhou (PG)', { err: e.message, id });
  }
}

/* ============================================================
   RECORD EVENT
   ============================================================ */
async function recordEvent({ matchId, kind, side, minute, payload }) {
  if (!_ready) await init();
  const id = Number(matchId);
  if (!id || !kind) return;
  const ev = {
    fixture_id: id,
    kind, side: side || null, minute: minute ?? null,
    payload: payload || null,
    created_at: new Date().toISOString(),
  };
  if (!usePg()) {
    pushRing(mem.events, ev, EVENT_RING_MAX);
    return;
  }
  try {
    await _pool.query(
      `INSERT INTO football_events (fixture_id, kind, side, minute, payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [ev.fixture_id, ev.kind, ev.side, ev.minute, ev.payload]
    );
  } catch (e) {
    log.warn('recordEvent falhou (PG)', { err: e.message });
  }
}

/* ============================================================
   QUERIES
   ============================================================ */
async function listSnapshots(matchId, { limit = 120 } = {}) {
  const id = Number(matchId);
  if (!id) return [];
  if (!usePg()) {
    const list = mem.snapshots.get(String(id)) || [];
    return list.slice(-limit);
  }
  const { rows } = await _pool.query(
    `SELECT * FROM football_snapshots
      WHERE fixture_id=$1
      ORDER BY captured_at ASC
      LIMIT $2`,
    [id, limit]
  );
  return rows;
}

async function listEvents(matchId, { limit = 100 } = {}) {
  const id = Number(matchId);
  if (!id) return [];
  if (!usePg()) {
    return mem.events.filter((e) => e.fixture_id === id).slice(-limit);
  }
  const { rows } = await _pool.query(
    `SELECT * FROM football_events
      WHERE fixture_id=$1
      ORDER BY created_at DESC
      LIMIT $2`,
    [id, limit]
  );
  return rows;
}

async function listRecentFixtures({ limit = 50 } = {}) {
  if (!usePg()) {
    return Array.from(mem.fixtures.values())
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, limit);
  }
  const { rows } = await _pool.query(
    `SELECT * FROM football_fixtures
      ORDER BY last_seen DESC
      LIMIT $1`, [limit]
  );
  return rows;
}

function stats() {
  return {
    mode: usePg() ? 'postgres' : 'memory',
    fixtures: usePg() ? null : mem.fixtures.size,
    snapshotsTracked: usePg() ? null : mem.snapshots.size,
    eventsBuffered: usePg() ? null : mem.events.length,
  };
}

module.exports = {
  init,
  recordSnapshot,
  recordEvent,
  listSnapshots,
  listEvents,
  listRecentFixtures,
  stats,
};
