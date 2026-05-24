/**
 * Robotrend IA — Validação de ambiente (fail-fast em produção/staging)
 */
'use strict';

const APP_VERSION = '5.0.0';

const WEAK_JWT_PATTERNS = [
  /change_me/i,
  /change_in_production/i,
  /troque_isto/i,
  /default_secret/i,
  /dev_secret/i,
  /robotrend_default/i,
  /^x{8,}$/i,
];

const WEAK_ADMIN_PASSWORDS = new Set([
  'admin123',
  'password',
  '123456',
  'admin',
  'robotrend',
]);

function isProductionLike() {
  const env = process.env.NODE_ENV || 'development';
  return env === 'production' || env === 'staging';
}

function isWeakJwtSecret(secret) {
  if (!secret || typeof secret !== 'string') return true;
  const s = secret.trim();
  if (s.length < 32) return true;
  return WEAK_JWT_PATTERNS.some((re) => re.test(s));
}

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function assertProductionEnv() {
  if (!isProductionLike()) return;

  const errors = [];

  const dbUrl = process.env.DATABASE_URL || '';
  const pgHost = process.env.PGHOST || '';
  if (!dbUrl && !pgHost) {
    errors.push(
      'DATABASE_URL ou PGHOST é obrigatório em produção/staging.\n' +
      '    → No Render: aba "Environment" do serviço web, vincule o Postgres em DATABASE_URL\n' +
      '      (clique "Add from Database" → escolha robotrend-pg → property: connectionString).'
    );
  }

  const jwt = (process.env.JWT_SECRET || '').trim();
  if (isWeakJwtSecret(jwt)) {
    errors.push(
      'JWT_SECRET inválido ou fraco (mín. 32 chars aleatórios).\n' +
      '    → Gere com:  node scripts/generate-secrets.js\n' +
      '    → Ou:        openssl rand -hex 64'
    );
  }

  const session = (process.env.SESSION_SECRET || '').trim();
  if (!session || session.length < 32) {
    errors.push(
      'SESSION_SECRET é obrigatório em produção/staging (mín. 32 chars).\n' +
      '    → Gere com:  node scripts/generate-secrets.js'
    );
  }

  if (String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true') {
    errors.push('DEMO_MODE=true não é permitido em produção/staging.');
  }

  const strict = process.env.STRICT_REAL_ONLY;
  if (strict != null && String(strict).toLowerCase() === 'false') {
    errors.push('STRICT_REAL_ONLY=false não é permitido em produção/staging (jogos sintéticos seriam aceitos).');
  }

  const adminPw = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (WEAK_ADMIN_PASSWORDS.has(adminPw)) {
    errors.push('BOOTSTRAP_ADMIN_PASSWORD fraca (ex.: admin123) — troque antes do deploy.');
  }

  const origins = parseAllowedOrigins();
  if (!origins.length) {
    errors.push(
      'ALLOWED_ORIGINS vazio — defina os domínios permitidos separados por vírgula.\n' +
      '    Ex.: ALLOWED_ORIGINS=https://robotrend.onrender.com,https://www.robotrend.com.br'
    );
  }

  if (errors.length) {
    const msg = [
      '',
      '╔══════════════════════════════════════════════════════════════════╗',
      '║  [startup-check] Ambiente de produção/staging INVÁLIDO          ║',
      '╚══════════════════════════════════════════════════════════════════╝',
      '',
      ...errors.map((e, i) => `  ${i + 1}. ${e}`),
      '',
      '  Corrija as variáveis no painel do host (Render → Environment) e',
      '  faça um novo deploy. Em local: edite .env e reinicie.',
      '',
    ].join('\n');
    throw new Error(msg);
  }
}

function buildCorsOptions() {
  const origins = parseAllowedOrigins();
  if (!origins.length) {
    if (isProductionLike()) {
      throw new Error('[startup-check] ALLOWED_ORIGINS obrigatório em produção/staging.');
    }
    return { origin: true, credentials: true };
  }
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (origins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS bloqueado para origem: ${origin}`));
    },
    credentials: true,
  };
}

function buildSocketCors() {
  const origins = parseAllowedOrigins();
  if (!origins.length) {
    if (isProductionLike()) return { origin: [] };
    return { origin: true };
  }
  return { origin: origins, credentials: true };
}

module.exports = {
  APP_VERSION,
  isProductionLike,
  assertProductionEnv,
  buildCorsOptions,
  buildSocketCors,
  parseAllowedOrigins,
  isWeakJwtSecret,
};
