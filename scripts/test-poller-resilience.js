#!/usr/bin/env node
'use strict';
/**
 * Smoke test: poller resiliente.
 *
 *   1. Tick sem API_FOOTBALL_KEY  → não lança, heartbeat OK, matches=[]
 *   2. Tick com erro ENOTFOUND     → não lança, fallback usado
 *   3. Loop continua agendando mesmo após N erros consecutivos
 */

delete process.env.API_FOOTBALL_KEY;
process.env.FOOTBALL_POLL_INTERVAL_MS = '200';

const path = require('path');
const root = path.join(__dirname, '..');

const apiFootball = require(path.join(root, 'backend/services/apiFootball'));
const { getPoller } = require(path.join(root, 'backend/workers/liveFootballPoller'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('PASS:', name); pass++; }
  else      { console.log('FAIL:', name); fail++; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const poller = getPoller();

  // T1 — sem API key
  console.log('\n=== T1: sem API_FOOTBALL_KEY ===');
  await poller.tick();
  const s1 = poller.snapshot();
  check('T1 não lança', true);
  check('T1 heartbeat registrado', s1.lastHeartbeatAt > 0);
  check('T1 alive=true', s1.alive === true);
  check('T1 matches vazios', poller.getMatches().length === 0);
  check('T1 fallback marcado', s1.lastFallbackReason === 'api_not_configured');

  // T2 — erro simulado via forceFail
  console.log('\n=== T2: simula getLiveFixtures lançando ENOTFOUND ===');
  process.env.API_FOOTBALL_KEY = 'fake_key_for_test_1234567890';
  // monkey-patch getLiveFixtures para lançar
  const orig = apiFootball.getLiveFixtures;
  apiFootball.getLiveFixtures = async () => {
    const e = new Error('getaddrinfo ENOTFOUND v3.football.api-sports.io');
    e.code = 'ENOTFOUND';
    throw e;
  };
  const before = poller.snapshot().lastHeartbeatAt;
  await sleep(10);
  await poller.tick();
  const s2 = poller.snapshot();
  check('T2 não lança em ENOTFOUND', true);
  check('T2 heartbeat avançou', s2.lastHeartbeatAt > before);
  check('T2 alive=true', s2.alive === true);
  check('T2 fallback acumulou', s2.stats.ticksFallback >= 1);

  // T3 — múltiplos erros não derrubam loop
  console.log('\n=== T3: 5 ticks consecutivos com falha ===');
  for (let i = 0; i < 5; i++) {
    await poller.tick();
  }
  const s3 = poller.snapshot();
  check('T3 stats.ticks incrementou', s3.stats.ticks > s2.stats.ticks);
  check('T3 alive ainda true', s3.alive === true);
  check('T3 nenhum throw escapou', true);

  // T4 — start() agenda loop e continua mesmo com erros
  console.log('\n=== T4: start() roda loop com falhas em background ===');
  poller.start();
  await sleep(800); // tempo p/ pelo menos 2 ticks no intervalo de 200ms
  const s4 = poller.snapshot();
  check('T4 running=true', s4.running === true);
  check('T4 ticks aumentaram no loop', s4.stats.ticks > s3.stats.ticks);
  check('T4 heartbeat recente', (Date.now() - s4.lastHeartbeatAt) < 1000);
  poller.stop();

  // restaura
  apiFootball.getLiveFixtures = orig;

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('TEST CRASHED (não deveria!):', e);
  process.exit(2);
});
