/**
 * Robotrend IA — Validação de ambiente (fail-fast em produção/staging)
 *
 * Regras:
 *   - Falha SOMENTE quando a variável está ausente, vazia ou fraca de verdade.
 *   - Valores com espaços/quebras de linha do painel Render são normalizados (.trim).
 *   - No Render, RENDER_EXTERNAL_URL preenche ALLOWED_ORIGINS / APP_URL / PUBLIC_URL
 *     automaticamente se o operador não definiu manualmente (evita falso "env missing").
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
  /^placeholder$/i,
  /^your[-_]?/i,
  /^seu[-_]?app/i,
  /^example\./i,
];

const WEAK_ADMIN_PASSWORDS = new Set([
  'admin123',
  'password',
  '123456',
  'admin',
  'robotrend',
]);

/** Lê env com trim — nunca chama .trim() em undefined. */
function envString(key) {
  const v = process.env[key];
  if (v == null || v === undefined) return '';
  return String(v).trim();
}

function isProductionLike() {
  const env = envString('NODE_ENV') || 'development';
  return env === 'production' || env === 'staging';
}

function isOnRender() {
  return Boolean(
    envString('RENDER') ||
    envString('RENDER_SERVICE_ID') ||
    envString('RENDER_EXTERNAL_URL')
  );
}

/**
 * URL pública do app (Render injeta RENDER_EXTERNAL_URL automaticamente).
 */
function resolvePublicBaseUrl() {
  const candidates = [
    envString('APP_URL'),
    envString('PUBLIC_URL'),
    envString('RENDER_EXTERNAL_URL'),
    envString('RENDER_SERVICE_URL'),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return u.origin;
      }
    } catch (_) {
      // ignora URL malformada — tenta próximo candidato
    }
  }
  return '';
}

function isWeakJwtSecret(secret) {
  if (!secret || typeof secret !== 'string') return true;
  const s = secret.trim();
  if (s.length < 32) return true;
  return WEAK_JWT_PATTERNS.some((re) => re.test(s));
}

/**
 * ALLOWED_ORIGINS explícito OU, em produção, fallback para URL pública do Render.
 */
function parseAllowedOrigins() {
  const raw = envString('ALLOWED_ORIGINS');
  const fromList = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o && o !== 'undefined' && o !== 'null');

  if (fromList.length) return [...new Set(fromList)];

  const base = resolvePublicBaseUrl();
  if (base) return [base.replace(/\/+$/, '')];

  return [];
}

function envPresence(key) {
  const v = envString(key);
  if (!v) return 'MISSING';
  return `set(${v.length} chars)`;
}

function assertProductionEnv() {
  if (!isProductionLike()) return;

  const errors = [];

  const dbUrl = envString('DATABASE_URL');
  const pgHost = envString('PGHOST');
  if (!dbUrl && !pgHost) {
    errors.push(
      'DATABASE_URL ou PGHOST é obrigatório em produção/staging.\n' +
      '    → Render: Environment → Add from Database → robotrend-pg → connectionString'
    );
  } else if (dbUrl && !/^postgres(ql)?:\/\//i.test(dbUrl)) {
    errors.push(
      'DATABASE_URL não parece uma connection string PostgreSQL válida.\n' +
      '    → Deve começar com postgresql:// ou postgres://'
    );
  }

  const jwt = envString('JWT_SECRET');
  if (isWeakJwtSecret(jwt)) {
    errors.push(
      'JWT_SECRET inválido ou fraco (mín. 32 chars aleatórios).\n' +
      '    → Render: use generateValue: true no blueprint ou cole um secret de 64+ chars'
    );
  }

  const session = envString('SESSION_SECRET');
  if (!session || session.length < 32) {
    errors.push(
      'SESSION_SECRET é obrigatório em produção/staging (mín. 32 chars).\n' +
      '    → Render: generateValue: true no blueprint'
    );
  }

  if (String(envString('DEMO_MODE') || 'false').toLowerCase() === 'true') {
    errors.push('DEMO_MODE=true não é permitido em produção/staging.');
  }

  const strict = process.env.STRICT_REAL_ONLY;
  if (strict != null && String(strict).toLowerCase() === 'false') {
    errors.push('STRICT_REAL_ONLY=false não é permitido em produção/staging.');
  }

  const adminPw = envString('BOOTSTRAP_ADMIN_PASSWORD');
  if (adminPw && WEAK_ADMIN_PASSWORDS.has(adminPw)) {
    errors.push('BOOTSTRAP_ADMIN_PASSWORD fraca — troque no painel Environment.');
  }

  const origins = parseAllowedOrigins();
  if (!origins.length) {
    const hint = isOnRender()
      ? 'No Render, RENDER_EXTERNAL_URL deveria existir automaticamente — verifique se o serviço é tipo "Web Service".'
      : 'Defina ALLOWED_ORIGINS=https://seu-dominio.com ou APP_URL com URL pública.';
    errors.push(`ALLOWED_ORIGINS / URL pública não resolvida.\n    → ${hint}`);
  }

  if (errors.length) {
    const diag = [
      `NODE_ENV=${envString('NODE_ENV') || '?'}`,
      `RENDER=${isOnRender() ? 'yes' : 'no'}`,
      `DATABASE_URL=${envPresence('DATABASE_URL')}`,
      `PGHOST=${envPresence('PGHOST')}`,
      `JWT_SECRET=${envPresence('JWT_SECRET')}`,
      `SESSION_SECRET=${envPresence('SESSION_SECRET')}`,
      `ALLOWED_ORIGINS=${envPresence('ALLOWED_ORIGINS')}`,
      `APP_URL=${envPresence('APP_URL')}`,
      `PUBLIC_URL=${envPresence('PUBLIC_URL')}`,
      `RENDER_EXTERNAL_URL=${envPresence('RENDER_EXTERNAL_URL')}`,
      `origins_resolved=${origins.length}`,
    ].join(' | ');

    const msg = [
      '',
      '╔══════════════════════════════════════════════════════════════════╗',
      '║  [startup-check] Ambiente de produção/staging INVÁLIDO          ║',
      '╚══════════════════════════════════════════════════════════════════╝',
      '',
      ...errors.map((e, i) => `  ${i + 1}. ${e}`),
      '',
      `  Diagnóstico (sem expor valores): ${diag}`,
      '',
      '  Corrija no Render → Environment e redeploy.',
      '',
    ].join('\n');
    throw new Error(msg);
  }

  // Log único de confirmação (sem secrets)
  const base = resolvePublicBaseUrl();
  const originsFinal = parseAllowedOrigins();
  console.log('[startup-check] produção OK', {
    db: dbUrl ? 'DATABASE_URL' : 'PGHOST',
    corsOrigins: originsFinal.length,
    publicUrl: base ? 'resolved' : 'none',
    render: isOnRender(),
  });
}

function buildCorsOptions() {
  const origins = parseAllowedOrigins();
  if (!origins.length) {
    if (isProductionLike()) {
      throw new Error('[startup-check] ALLOWED_ORIGINS / URL pública obrigatório em produção.');
    }
    return { origin: true, credentials: true };
  }
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const normalized = origin.replace(/\/+$/, '');
      if (origins.includes(normalized) || origins.includes(origin)) return cb(null, true);
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
  isOnRender,
  assertProductionEnv,
  buildCorsOptions,
  buildSocketCors,
  parseAllowedOrigins,
  resolvePublicBaseUrl,
  envString,
  isWeakJwtSecret,
};
