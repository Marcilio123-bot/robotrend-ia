/**
 * Robotrend IA — Worker de Expiração de Assinaturas
 * ==================================================
 *
 * Garante o downgrade AUTOMÁTICO de assinaturas Premium vencidas, sem
 * intervenção manual e independente de o usuário acessar o sistema.
 *
 * Estratégia em camadas (defense-in-depth):
 *   1. Por requisição (auth.requireAuth → syncSubscriptionStatus): cada
 *      request reavalia a expiração e persiste o status.
 *   2. Por conexão socket (server.js / footballRealtime.js): o snapshot do
 *      usuário carrega expiresAt; isPremiumUser() reavalia a cada broadcast.
 *   3. Este worker (varredura periódica): rebaixa quem expirou mas não
 *      fez nenhuma requisição — fechando a janela de "Premium infinito".
 *
 * Idempotente e seguro: nunca toca contas admin; preserva o `plan` (modelo
 * "lapsed") para permitir renovação mensal.
 */

'use strict';

const subscription = require('../subscription');
const { logger } = require('../logger');
const log = logger.child({ module: 'subscriptionExpiry' });

// Intervalo da varredura (default 1h). A expiração efetiva é instantânea via
// resolveSubscriptionState; a varredura apenas materializa o estado no banco.
const SWEEP_INTERVAL_MS = Number(process.env.SUBSCRIPTION_SWEEP_INTERVAL_MS || 60 * 60 * 1000);

let timer = null;
let running = false;

/**
 * Executa uma varredura. Notifica via socket os usuários rebaixados (se
 * houver `emitToUser`), para que o frontend atualize a UI sem relogar.
 */
async function runSweep(db, emitToUser) {
  if (running) return { expired: 0, scanned: 0, skipped: true };
  running = true;
  try {
    const result = await subscription.expireSubscriptions(db, {
      onExpire: emitToUser
        ? (userId) => {
            // Avisa sockets abertos para o cliente refazer /api/auth/me e
            // atualizar o badge de plano (o conteúdo já é cortado por emit).
            try {
              emitToUser(userId, 'user:downgraded', {
                plan: 'FREE',
                reason: 'subscription_expired',
                at: new Date().toISOString(),
              });
            } catch (_) { /* não-crítico */ }
          }
        : null,
    });
    return result;
  } catch (err) {
    log.error('varredura de expiração falhou', { err: err.message });
    return { expired: 0, scanned: 0, error: err.message };
  } finally {
    running = false;
  }
}

/**
 * Inicia o worker: roda uma vez no boot e reagenda a cada SWEEP_INTERVAL_MS.
 * @param {object} db
 * @param {object} [opts]
 * @param {function} [opts.emitToUser]  (userId, event, payload) => number
 */
function start(db, opts = {}) {
  if (!db) {
    log.warn('subscriptionExpiry.start sem db — worker não iniciado');
    return;
  }
  const emitToUser = typeof opts.emitToUser === 'function' ? opts.emitToUser : null;

  // Varredura inicial no boot (não bloqueia se falhar).
  runSweep(db, emitToUser)
    .then((r) => log.info('varredura de expiração (boot)', r))
    .catch((e) => log.warn('varredura de boot falhou', { err: e.message }));

  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runSweep(db, emitToUser)
      .then((r) => { if (r.expired) log.info('varredura de expiração (periódica)', r); })
      .catch((e) => log.warn('varredura periódica falhou', { err: e.message }));
  }, SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();

  log.info('worker de expiração de assinaturas ativo', { intervalMs: SWEEP_INTERVAL_MS });
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runSweep, SWEEP_INTERVAL_MS };
