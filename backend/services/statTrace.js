/**
 * Robotrend IA — Stat Tracing
 * ============================
 * Rastreio de UMA fixture através das 6 etapas do pipeline de stats:
 *
 *   1) api-raw       (apiFootball.getFixtureStatistics — antes do normalizer)
 *   2) enricher      (fixtureEnricher._enrichOne — após mesclar no match)
 *   3) normalizer    (fixtureNormalizer.applyEnrichment — após cálculos)
 *   4) rest-live     (GET /api/football/live — payload entregue ao cliente REST)
 *   5) socket-emit   (footballRealtime — payload do socket match:upsert/update)
 *   6) front-render  (dashboard.js — antes do render no DOM)
 *
 * Para ativar, exporte a env STAT_TRACE_FIXTURE_ID com o id desejado, OU
 * deixe vazio: o primeiro fixture que passar pelo poller vira o alvo
 * automaticamente (snapshot dura 5 minutos).
 *
 * Cada chamada produz UMA linha [STAT TRACE] no console:
 *   [STAT TRACE 1/6] fixtureId=… stage=api-raw     corners=… shots=… …
 *
 * Os snapshots tambm são guardados em memória e expostos em
 * /api/football/bet-signals/diag/trace/:id como um único JSON consolidado.
 */
'use strict';

const TARGET_ENV = String(process.env.STAT_TRACE_FIXTURE_ID || '').trim();
const AUTO_TTL_MS = Number(process.env.STAT_TRACE_AUTO_TTL_MS || 5 * 60_000);

// Alvo: explícito por env ou auto (primeira fixture que aparecer no poller).
let autoTarget = null;
let autoTargetSetAt = 0;

const buffers = new Map(); // fixtureId(string) -> { stage1, stage2, stage3, stage4, stage5 }

function isTarget(fixtureId) {
  const id = String(fixtureId || '');
  if (!id) return false;
  if (TARGET_ENV) return id === TARGET_ENV;
  if (autoTarget && Date.now() - autoTargetSetAt < AUTO_TTL_MS) return id === autoTarget;
  return false;
}

function setAutoTarget(fixtureId) {
  const id = String(fixtureId || '');
  if (!id || TARGET_ENV) return;
  if (autoTarget && Date.now() - autoTargetSetAt < AUTO_TTL_MS) return;
  autoTarget = id;
  autoTargetSetAt = Date.now();
  console.log(`[STAT TRACE] auto-target set fixtureId=${autoTarget} (válido por ${AUTO_TTL_MS / 1000}s)`);
}

function getTarget() {
  if (TARGET_ENV) return { id: TARGET_ENV, source: 'env' };
  if (autoTarget && Date.now() - autoTargetSetAt < AUTO_TTL_MS) {
    return { id: autoTarget, source: 'auto', expiresAt: autoTargetSetAt + AUTO_TTL_MS };
  }
  return { id: null, source: 'none' };
}

const STAGES = ['api-raw', 'enricher', 'normalizer', 'rest-live', 'socket-emit', 'front-render'];

/**
 * Helper para extrair os 5 campos de stats numa string compacta.
 * Aceita tanto o objeto m.stats nested quanto valores flatten { corners, shots... }.
 */
function fmt(stats, flat = null) {
  const c = flat?.corners ?? stats?.corners?.total;
  const s = flat?.shots ?? stats?.shots?.total;
  const sot = flat?.shotsOnTarget ?? stats?.shotsOnTarget?.total;
  const dang = flat?.dangerousAttacks ?? stats?.dangerousAttacks?.total;
  const att = flat?.attacks ?? stats?.attacks?.total;
  return `corners=${c ?? 'undef'} shots=${s ?? 'undef'} shotsOnTarget=${sot ?? 'undef'} dangerousAttacks=${dang ?? 'undef'} attacks=${att ?? 'undef'}`;
}

/**
 * Registra um snapshot de stats no estágio dado.
 *
 * @param {string} stage      — uma das 6 chaves de STAGES
 * @param {string|number} fixtureId
 * @param {object} payload    — { stats?, flat?, raw?, extra? }
 *                              stats: m.stats nested
 *                              flat:  campos flatten (corners,shots,sot,dang,att)
 *                              raw:   resposta crua (api-raw)
 *                              extra: qualquer info adicional
 */
function trace(stage, fixtureId, payload = {}) {
  if (!STAGES.includes(stage)) return;
  const id = String(fixtureId || '');
  if (!id) return;

  // Auto-target: primeiro fixture a passar por api-raw OU enricher fixa o alvo.
  if (!TARGET_ENV && !autoTarget && (stage === 'api-raw' || stage === 'enricher')) {
    setAutoTarget(id);
  }
  if (!isTarget(id)) return;

  const idx = STAGES.indexOf(stage) + 1;
  const total = STAGES.length;
  const stats = payload.stats || null;
  const flat = payload.flat || null;
  console.log(
    `[STAT TRACE ${idx}/${total}] fixtureId=${id} stage=${stage} ${fmt(stats, flat)}` +
    (payload.extra ? ` | ${JSON.stringify(payload.extra).slice(0, 250)}` : '')
  );

  // Persiste em buffer por fixture para o endpoint consolidado.
  if (!buffers.has(id)) buffers.set(id, {});
  const buf = buffers.get(id);
  buf[stage] = {
    ts: Date.now(),
    stats,
    flat,
    raw: payload.raw || null,
    extra: payload.extra || null,
  };
}

function snapshot(fixtureId) {
  const id = String(fixtureId || '');
  return buffers.get(id) || null;
}

function clear(fixtureId) {
  if (fixtureId) buffers.delete(String(fixtureId));
  else buffers.clear();
}

module.exports = { trace, snapshot, clear, getTarget, setAutoTarget, STAGES };
