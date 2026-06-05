/**
 * Robotrend IA — Goal Clock
 *
 * Rastreia o timestamp do ÚLTIMO gol de cada fixture, alimentado pelo evento
 * `fixture:goal` emitido pelo liveFootballPoller.
 *
 * MOTIVAÇÃO (Problema 1 — sinais atrasados / "após o gol"):
 *   Sinais de mercado dependente de gol (BTTS / Over 2.5 / Under 2.5) só fazem
 *   sentido se enviados ANTES do evento. Logo após um gol, qualquer sinal de
 *   "Ambas Marcam" ou "Over 2.5" tende a ser REATIVO (chega depois do fato) —
 *   o usuário recebe o aviso quando o gol já saiu. Para evitar isso, os motores
 *   consultam este relógio e suprimem sinais de gol por uma janela curta após
 *   cada gol (POST_GOAL_SUPPRESS_MS), garantindo que o que sobra seja
 *   PREDITIVO (antes do próximo gol).
 *
 * Uso:
 *   const goalClock = require('./goalClock');
 *   goalClock.start();                              // 1x no boot (server/worker)
 *   goalClock.msSinceLastGoal(fixtureId);           // Infinity se nunca houve gol
 *   goalClock.hadRecentGoal(fixtureId, windowMs);   // boolean
 *
 * É um singleton in-process, sem custo de API e sem dependências circulares.
 */

'use strict';

const events = require('./footballEvents');
const { logger } = require('../logger');

const log = logger.child({ module: 'goalClock' });

/** fixtureId(string) -> timestamp(ms) do último gol observado. */
const lastGoalAt = new Map();

// Limites de memória — partidas antigas são podadas (3h sem gol = descartável).
const MAX_ENTRIES = Number(process.env.GOAL_CLOCK_MAX_ENTRIES || 800);
const PRUNE_AGE_MS = Number(process.env.GOAL_CLOCK_PRUNE_AGE_MS || 3 * 60 * 60 * 1000);

function record(fixtureId, ts = Date.now()) {
  if (fixtureId == null) return;
  const id = String(fixtureId);
  lastGoalAt.set(id, ts);
  if (lastGoalAt.size > MAX_ENTRIES) prune();
}

function prune() {
  const cutoff = Date.now() - PRUNE_AGE_MS;
  for (const [id, ts] of lastGoalAt) {
    if (ts < cutoff) lastGoalAt.delete(id);
  }
}

/** ms desde o último gol; Infinity se nenhum gol foi registrado para a fixture. */
function msSinceLastGoal(fixtureId) {
  if (fixtureId == null) return Infinity;
  const ts = lastGoalAt.get(String(fixtureId));
  return ts ? Date.now() - ts : Infinity;
}

/** true se houve gol nos últimos `windowMs` ms para a fixture. */
function hadRecentGoal(fixtureId, windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return false;
  return msSinceLastGoal(fixtureId) < windowMs;
}

let started = false;
let onGoal = null;

function start() {
  if (started) return;
  started = true;
  onGoal = (payload) => {
    const m = payload?.match;
    const id = m?.fixtureId ?? m?.id ?? payload?.matchId;
    if (id == null) return;
    record(id);
    if (String(process.env.GOAL_CLOCK_DEBUG || 'false').toLowerCase() === 'true') {
      log.info('goal recorded', { fixtureId: String(id), side: payload?.side, minute: m?.minute });
    }
  };
  events.on('fixture:goal', onGoal);
  log.info('goalClock ativo (rastreando fixture:goal para supressão pós-gol)');
}

function stop() {
  if (onGoal) events.off('fixture:goal', onGoal);
  onGoal = null;
  started = false;
}

function snapshot() {
  return { started, tracked: lastGoalAt.size, maxEntries: MAX_ENTRIES };
}

module.exports = {
  start,
  stop,
  record,
  msSinceLastGoal,
  hadRecentGoal,
  snapshot,
};
