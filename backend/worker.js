/**
 * Robotrend IA — Worker Standalone
 *
 * Roda o LiveFootballPoller + history + alerts em um processo separado.
 * Usa Redis (cacheStore + jobs) para coordenar com o servidor web.
 *
 * Por que separar?
 *   - Web pods focam em servir HTTP/WS sem competir CPU com polling
 *   - Worker pode escalar horizontalmente independente
 *   - Em caso de crash do worker, o web continua servindo cache stale
 *
 * Uso:
 *   REDIS_URL=redis://... node backend/worker.js
 *
 * Importante:
 *   - Esse worker NÃO sobe Express. Só os jobs.
 *   - O web pode usar `FOOTBALL_POLLER_ENABLED=false` para evitar
 *     duplicar trabalho quando o worker estiver rodando.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

const { logger } = require('./logger');
const log = logger.child({ module: 'worker' });

const footballHistory = require('./services/footballHistory');
const footballAlerts  = require('./services/footballAlerts');
const signalsEngine   = require('./services/signalsEngine');
const quotaMonitor    = require('./services/quotaMonitor');
const { getPoller }   = require('./workers/liveFootballPoller');
const { getEnricher } = require('./services/fixtureEnricher');

async function main() {
  log.info('worker starting…', {
    redis: !!process.env.REDIS_URL,
    pollInterval: process.env.FOOTBALL_POLL_INTERVAL_MS || 12000,
  });

  await footballHistory.init();
  footballAlerts.start();
  signalsEngine.start();
  quotaMonitor.start();

  const poller = getPoller();
  const enricher = getEnricher();
  enricher.setPoller(poller);
  // No worker isolado, sem socket subscribers o enricher só faz AUTO_TOP (se >0).
  // Quando Redis estiver compartilhado, o cache de enrichment beneficia o web.
  enricher.start();
  poller.start();

  log.info('worker online');
}

function shutdown(sig) {
  log.warn(`worker shutdown (${sig})`);
  try { getPoller().stop(); } catch {}
  try { getEnricher().stop(); } catch {}
  try { footballAlerts.stop(); } catch {}
  try { signalsEngine.stop(); } catch {}
  try { quotaMonitor.stop(); } catch {}
  setTimeout(() => process.exit(0), 500).unref();
}

['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', { err: err?.message || String(err) }));
process.on('uncaughtException',  (err) => log.fatal('uncaughtException',  { err: err?.message || String(err) }));

main().catch((e) => {
  log.fatal('worker boot failed', { err: e.message });
  process.exit(1);
});
