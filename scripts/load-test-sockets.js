/**
 * Robotrend IA — Socket.io Load Test
 *
 * Abre N conexões simultâneas no namespace /football, distribui em rooms
 * (lobby + fixture random + league random), opcionalmente reconnecta tudo
 * no meio do teste, e reporta:
 *
 *   - tempo até connect (avg, p95, p99)
 *   - mensagens recebidas/segundo agregadas
 *   - erros de connect
 *   - quedas/reconnects
 *
 * Uso:
 *   node scripts/load-test-sockets.js
 *   N=200 DURATION_SEC=60 URL=http://localhost:3010 node scripts/load-test-sockets.js
 *   N=100 RECONNECT_AT_SEC=20 node scripts/load-test-sockets.js
 *
 * Variáveis:
 *   N                Quantidade de clientes (default 100)
 *   DURATION_SEC     Quanto tempo manter (default 30)
 *   URL              http(s)://host:port (default localhost:3010)
 *   ROOMS_PER_CLIENT Rooms extras assinadas por cliente (default 2)
 *   RECONNECT_AT_SEC Se setado, desconecta + reconnecta todos os clientes nesse segundo
 *   TOKEN            JWT para autenticar (se necessário)
 *   QUIET            "1" para reduzir log por cliente
 */

'use strict';

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

let io;
try { io = require('socket.io-client'); }
catch (e) {
  console.error('❌ socket.io-client não está instalado.');
  console.error('   Rode: npm i -D socket.io-client');
  process.exit(2);
}

const N                = Number(process.env.N || 100);
const DURATION_SEC     = Number(process.env.DURATION_SEC || 30);
const URL              = process.env.URL || `http://localhost:${process.env.PORT || 3010}`;
const ROOMS_PER_CLIENT = Number(process.env.ROOMS_PER_CLIENT || 2);
const RECONNECT_AT_SEC = process.env.RECONNECT_AT_SEC ? Number(process.env.RECONNECT_AT_SEC) : null;
const TOKEN            = process.env.TOKEN || '';
const QUIET            = process.env.QUIET === '1';

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  yel:   (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  gray:  (s) => `\x1b[90m${s}\x1b[0m`,
};

function pct(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function avg(arr) { return arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : null; }

console.log(C.cyan(`\n━━━ Robotrend Load Test (sockets) ━━━`));
console.log(`URL              : ${URL}`);
console.log(`Clientes         : ${N}`);
console.log(`Duração          : ${DURATION_SEC}s`);
console.log(`Rooms/cliente    : ${ROOMS_PER_CLIENT}`);
if (RECONNECT_AT_SEC) console.log(`Reconnect em     : ${RECONNECT_AT_SEC}s`);
console.log(`Token            : ${TOKEN ? 'sim' : 'não'}`);
console.log('');

const clients = [];
const stats = {
  connectTimes: [],
  connectErrors: 0,
  disconnects: 0,
  reconnects: 0,
  msgs: 0,
  msgsByEvent: {},
  startedAt: Date.now(),
};

const fakeFixtureIds = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 1_000_000 + i);
const fakeLeagueIds = [39, 140, 78, 135, 61, 2, 3, 71]; // EPL, La Liga, Bundesliga, etc.

function buildClient(idx) {
  const t0 = Date.now();
  const sock = io(URL + '/football', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 500,
    timeout: 10000,
    auth: TOKEN ? { token: TOKEN } : undefined,
    extraHeaders: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });

  sock.on('connect', () => {
    stats.connectTimes.push(Date.now() - t0);
    if (!QUIET && idx < 5) console.log(C.green(`✔ client #${idx} connected (${Date.now() - t0}ms)`));

    // Assina rooms aleatórias
    for (let i = 0; i < ROOMS_PER_CLIENT; i++) {
      const type = Math.random() > 0.5 ? 'fixture' : 'league';
      const id = type === 'fixture'
        ? fakeFixtureIds[Math.floor(Math.random() * fakeFixtureIds.length)]
        : fakeLeagueIds[Math.floor(Math.random() * fakeLeagueIds.length)];
      sock.emit('subscribe', { type, id });
    }
  });

  sock.on('connect_error', (e) => {
    stats.connectErrors++;
    if (!QUIET && stats.connectErrors < 5) console.error(C.red(`✘ client #${idx} connect_error: ${e.message}`));
  });

  sock.on('disconnect', () => { stats.disconnects++; });
  sock.on('reconnect', () => { stats.reconnects++; });

  const onAny = (event) => {
    stats.msgs++;
    stats.msgsByEvent[event] = (stats.msgsByEvent[event] || 0) + 1;
  };
  // Não temos onAny universal em todas as versões — registramos os eventos conhecidos
  ['hello','tick','match:upsert','match:update','match:remove',
   'fixture:goal','fixture:corner','fixture:card','fixture:pressure','fixture:btts-near',
   'quota','quota:low','circuit:open','circuit:close','poller:error']
    .forEach((e) => sock.on(e, () => onAny(e)));

  return sock;
}

async function ramp() {
  for (let i = 0; i < N; i++) {
    clients.push(buildClient(i));
    if (i % 25 === 24) await new Promise((r) => setTimeout(r, 30));
  }
}

function liveReport() {
  setInterval(() => {
    const elapsed = ((Date.now() - stats.startedAt) / 1000).toFixed(1);
    const connected = clients.filter((c) => c.connected).length;
    process.stdout.write(
      `\r${C.gray(`[${elapsed}s]`)} ` +
      `connected=${C.cyan(connected)}/${N}  ` +
      `msgs=${C.cyan(stats.msgs)}  ` +
      `rate=${C.cyan(((stats.msgs / Math.max(1, +elapsed))).toFixed(1))}/s  ` +
      `err=${stats.connectErrors}  drops=${stats.disconnects}     `
    );
  }, 1000).unref?.();
}

function finalReport() {
  console.log('\n');
  console.log(C.cyan('━━━━━━━━━━━━━━━ RESULTADO ━━━━━━━━━━━━━━━'));
  const elapsed = ((Date.now() - stats.startedAt) / 1000).toFixed(1);
  const connected = clients.filter((c) => c.connected).length;
  console.log(`Tempo total           : ${elapsed}s`);
  console.log(`Clientes conectados   : ${C.cyan(connected)}/${N}`);
  console.log(`Falhas de connect     : ${stats.connectErrors ? C.red(stats.connectErrors) : C.green(0)}`);
  console.log(`Disconnects           : ${stats.disconnects}`);
  console.log(`Reconnects            : ${stats.reconnects}`);
  console.log('');
  console.log(`Connect time (ms)`);
  console.log(`  avg  : ${C.cyan(avg(stats.connectTimes))}`);
  console.log(`  p50  : ${C.cyan(pct(stats.connectTimes, 50))}`);
  console.log(`  p95  : ${C.cyan(pct(stats.connectTimes, 95))}`);
  console.log(`  p99  : ${C.cyan(pct(stats.connectTimes, 99))}`);
  console.log(`  max  : ${C.cyan(Math.max(...(stats.connectTimes.length ? stats.connectTimes : [0])))}`);
  console.log('');
  console.log(`Mensagens             : ${C.cyan(stats.msgs)} total`);
  console.log(`Throughput agregado   : ${C.cyan((stats.msgs / Math.max(1, +elapsed)).toFixed(1))} msgs/s`);
  console.log(`Por evento            :`);
  Object.entries(stats.msgsByEvent).sort((a, b) => b[1] - a[1]).forEach(([e, c]) => {
    console.log(`   ${e.padEnd(22)} ${C.cyan(c)}`);
  });
  console.log(C.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
}

async function main() {
  await ramp();
  liveReport();

  if (RECONNECT_AT_SEC && RECONNECT_AT_SEC < DURATION_SEC) {
    setTimeout(() => {
      console.log(C.yel(`\n⟲ disparando reconnect em massa (${N} clientes)…`));
      clients.forEach((c) => { try { c.disconnect(); c.connect(); } catch {} });
    }, RECONNECT_AT_SEC * 1000);
  }

  setTimeout(() => {
    clients.forEach((c) => { try { c.disconnect(); } catch {} });
    setTimeout(() => { finalReport(); process.exit(stats.connectErrors > N * 0.1 ? 1 : 0); }, 500);
  }, DURATION_SEC * 1000);
}

process.on('SIGINT', () => { finalReport(); process.exit(130); });
main();
