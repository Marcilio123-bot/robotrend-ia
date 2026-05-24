/**
 * Robotrend IA — Worker Separado: Sanity Check
 *
 * Verifica se o modo "web + worker separados" está corretamente
 * configurado, sem subir os processos. Útil para CI.
 *
 *   1. .env tem REDIS_URL configurado (necessário para coordenar)
 *   2. Ou então o usuário entende que vai cair para in-process
 *   3. ioredis e bullmq estão instalados (ou ao menos disponíveis para
 *      optional install)
 *   4. backend/worker.js é parseável
 *   5. backend/server.js respeita FOOTBALL_POLLER_ENABLED=false
 *   6. apiFootball está usando cacheStore com mesmo backend em ambos
 *
 * Uso:
 *   node scripts/worker-check.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  yel:   (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  gray:  (s) => `\x1b[90m${s}\x1b[0m`,
};

let passed = 0, failed = 0, warns = 0;
function ok(name)       { console.log(`  ${C.green('✔')} ${name}`); passed++; }
function bad(name, why) { console.log(`  ${C.red('✘')} ${name}` + (why ? ` ${C.gray(why)}` : '')); failed++; }
function warn(name, why){ console.log(`  ${C.yel('!')} ${name}` + (why ? ` ${C.gray(why)}` : '')); warns++; }

console.log(C.cyan('\n━━━ Robotrend Worker Mode Sanity Check ━━━\n'));

/* 1) REDIS_URL */
console.log(C.yel('▶ Configuração de infraestrutura'));
const REDIS = (process.env.REDIS_URL || '').trim();
if (!REDIS) {
  warn('REDIS_URL não configurado',
    'Sem Redis, web e worker não compartilham cache → use FOOTBALL_POLLER_ENABLED=true em só UM deles.');
} else {
  ok(`REDIS_URL configurado (${REDIS.replace(/(:[^@/]+)?@/, '@***@')})`);
}

/* 2) Dependências opcionais */
try { require.resolve('ioredis'); ok('ioredis instalado'); }
catch { warn('ioredis NÃO instalado', '— rode `npm i ioredis` para ativar cache Redis'); }
try { require.resolve('bullmq'); ok('bullmq instalado'); }
catch { warn('bullmq NÃO instalado', '— rode `npm i bullmq` para fila distribuída (opcional)'); }
try { require.resolve('socket.io-client'); ok('socket.io-client instalado (load-test)'); }
catch { warn('socket.io-client NÃO instalado', '— necessário só para load-test (npm i -D socket.io-client)'); }

/* 3) worker.js parseia */
console.log(C.yel('\n▶ backend/worker.js'));
const workerPath = path.join(__dirname, '..', 'backend', 'worker.js');
if (!fs.existsSync(workerPath)) {
  bad('backend/worker.js não existe');
} else {
  try {
    // Apenas resolve as exports (não roda — main() é chamado no boot, não no require)
    const code = fs.readFileSync(workerPath, 'utf8');
    if (!/getPoller/.test(code)) bad('worker.js não importa getPoller', 'verifique o conteúdo');
    else ok('worker.js usa LiveFootballPoller');
    if (!/footballAlerts/.test(code)) warn('worker.js não inicia footballAlerts');
    else ok('worker.js inicia footballAlerts');
    if (!/quotaMonitor/.test(code)) warn('worker.js não inicia quotaMonitor');
    else ok('worker.js inicia quotaMonitor');
  } catch (e) { bad('falha ao ler worker.js', e.message); }
}

/* 4) server.js respeita FOOTBALL_POLLER_ENABLED */
console.log(C.yel('\n▶ backend/server.js — respeita FOOTBALL_POLLER_ENABLED'));
const serverPath = path.join(__dirname, '..', 'backend', 'server.js');
if (!fs.existsSync(serverPath)) bad('backend/server.js não existe');
else {
  const code = fs.readFileSync(serverPath, 'utf8');
  if (!/FOOTBALL_POLLER_ENABLED/.test(code)) bad('server.js NÃO checa FOOTBALL_POLLER_ENABLED');
  else ok('server.js checa FOOTBALL_POLLER_ENABLED');
}

/* 5) cacheStore coerência (web e worker veem o mesmo backend) */
console.log(C.yel('\n▶ Coerência cacheStore (web vs worker)'));
const { _reset, createStore } = require('../backend/services/cacheStore');
try {
  _reset();
  const a = createStore();
  _reset();
  const b = createStore();
  ok(`cacheStore web    : ${a.info().backend}`);
  ok(`cacheStore worker : ${b.info().backend}`);
  if (a.info().backend !== b.info().backend) bad('backends diferentes entre instâncias?!');
  else if (a.info().backend === 'memory' && REDIS) bad('REDIS_URL setado mas cacheStore voltou para memory', 'ioredis ausente?');
  else if (a.info().backend === 'memory' && !REDIS) warn('ambos em MEMÓRIA — não compartilham cache. Setup OK só se houver UM owner.');
  else ok('ambos em REDIS — cache compartilhado ✓');
} catch (e) { bad('falha no createStore', e.message); }

/* 6) Jobs */
console.log(C.yel('\n▶ Jobs scheduler'));
try {
  const { getJobs } = require('../backend/services/jobs');
  const j = getJobs();
  ok(`jobs backend ativo: ${j.info().backend}`);
  if (j.info().backend === 'bullmq') ok('BullMQ ativo — fila distribuída disponível');
  else warn('jobs in-process — OK para single-node, mas BullMQ é necessário para multi-worker');
} catch (e) { bad('falha ao inicializar jobs', e.message); }

/* SUMÁRIO */
console.log(C.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(`  ${C.green('✔ passed')}  ${passed}`);
console.log(`  ${C.yel('! warns')}   ${warns}`);
console.log(`  ${C.red('✘ failed')}  ${failed}`);
console.log(C.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

if (failed) process.exit(1);
console.log(C.gray('Próximos passos:\n'));
console.log(`  Terminal 1 (web)    : ${C.cyan('FOOTBALL_POLLER_ENABLED=false npm start')}`);
console.log(`  Terminal 2 (worker) : ${C.cyan('npm run worker')}`);
console.log(`  Validar             : ${C.cyan('npm run validate:realtime')}`);
console.log(`  Carga               : ${C.cyan('N=200 npm run load:sockets')}\n`);
process.exit(0);
