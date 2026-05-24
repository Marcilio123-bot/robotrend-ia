/* Smoke-test do startup-check (Render hardening) */
'use strict';

const fs = require('fs');
const lines = [];
const log = (...args) => lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));

const sc = require('../backend/startup-check');

function reset() {
  for (const k of ['DATABASE_URL', 'PGHOST', 'JWT_SECRET', 'SESSION_SECRET',
                   'ALLOWED_ORIGINS', 'APP_URL', 'PUBLIC_URL', 'DEMO_MODE',
                   'STRICT_REAL_ONLY', 'BOOTSTRAP_ADMIN_PASSWORD', 'NODE_ENV',
                   'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_URL', 'RENDER_SERVICE_URL']) {
    delete process.env[k];
  }
}

function passIf(cond, name) { log((cond ? '  PASS   ' : '  FAIL   '), name); return cond; }

let allOk = true;
function record(b) { if (!b) allOk = false; }

// --- T1: Render-like com fallback automático ---
log('\n=== T1: Render injeta RENDER_EXTERNAL_URL como fallback CORS ===');
reset();
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://u:p@dpg-x.oregon-postgres.render.com/robotrend';
process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(48);
process.env.RENDER = 'true';
process.env.RENDER_EXTERNAL_URL = 'https://robotrend-ia.onrender.com';
try {
  sc.assertProductionEnv();
  const origins = sc.parseAllowedOrigins();
  log('   origins =', origins);
  record(passIf(origins.length === 1 && origins[0] === 'https://robotrend-ia.onrender.com',
    'Fallback Render funciona sem ALLOWED_ORIGINS manual'));
} catch (e) {
  record(passIf(false, 'T1 inesperadamente falhou: ' + e.message.split('\n')[2]));
}

// --- T2: Vars com whitespace/newline do painel ---
log('\n=== T2: Trim DATABASE_URL/JWT_SECRET/SESSION_SECRET ===');
reset();
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = '  postgresql://u:p@dpg-x.render.com/robotrend\n';
process.env.JWT_SECRET = '  ' + 'c'.repeat(64) + '\n';
process.env.SESSION_SECRET = ' ' + 'd'.repeat(40) + '  ';
process.env.RENDER_EXTERNAL_URL = 'https://robotrend.onrender.com';
try {
  sc.assertProductionEnv();
  record(passIf(true, 'Whitespace/newline aceitos após trim'));
} catch (e) {
  record(passIf(false, 'T2 falhou: ' + e.message.split('\n')[2]));
}

// --- T3: ALLOWED_ORIGINS multi com / e entradas vazias ---
log('\n=== T3: Parse ALLOWED_ORIGINS multi com sanitização ===');
reset();
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://u:p@dpg-x.render.com/db';
process.env.JWT_SECRET = 'e'.repeat(64);
process.env.SESSION_SECRET = 'f'.repeat(40);
process.env.ALLOWED_ORIGINS = 'https://a.com/, https://b.com//, , undefined, null,https://c.com';
try {
  sc.assertProductionEnv();
  const origins = sc.parseAllowedOrigins();
  log('   origins =', origins);
  record(passIf(
    origins.length === 3 && origins[0] === 'https://a.com' &&
    origins[1] === 'https://b.com' && origins[2] === 'https://c.com',
    'Parse remove vazias/undefined/null e barras finais'
  ));
} catch (e) {
  record(passIf(false, 'T3 falhou: ' + e.message));
}

// --- T4: DATABASE_URL inválido (deve BLOQUEAR) ---
log('\n=== T4: DATABASE_URL inválido bloqueia boot ===');
reset();
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'http://wrong-protocol';
process.env.JWT_SECRET = 'g'.repeat(64);
process.env.SESSION_SECRET = 'h'.repeat(40);
process.env.RENDER_EXTERNAL_URL = 'https://x.onrender.com';
try {
  sc.assertProductionEnv();
  record(passIf(false, 'T4 deveria ter bloqueado'));
} catch (e) {
  record(passIf(/connection string PostgreSQL/.test(e.message),
    'Bloqueia URL não-postgres com erro claro'));
}

// --- T5: JWT_SECRET fraco (placeholder) ---
log('\n=== T5: JWT_SECRET com padrão fraco ===');
reset();
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://u:p@dpg-x.render.com/db';
process.env.JWT_SECRET = 'your-secret-here-your-secret-here-your-secret';
process.env.SESSION_SECRET = 'i'.repeat(40);
process.env.RENDER_EXTERNAL_URL = 'https://x.onrender.com';
try {
  sc.assertProductionEnv();
  record(passIf(false, 'T5 deveria ter bloqueado'));
} catch (e) {
  record(passIf(/JWT_SECRET inválido/.test(e.message),
    'Bloqueia placeholders (your-*)'));
}

// --- T6: Diagnóstico não expõe secrets ---
log('\n=== T6: Diagnóstico nunca expõe valores secretos ===');
reset();
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://supersecret_PASSWORD_visible@host/db';
process.env.JWT_SECRET = 'short';
process.env.SESSION_SECRET = 'short';
try {
  sc.assertProductionEnv();
} catch (e) {
  const leaks = ['supersecret_PASSWORD_visible', 'postgresql://supersecret'];
  const hit = leaks.find(s => e.message.includes(s));
  record(passIf(!hit, 'Erro NÃO contém valores secretos'));
  record(passIf(/Diagnóstico/.test(e.message), 'Erro mostra diagnóstico'));
  record(passIf(/DATABASE_URL=set\(\d+ chars\)/.test(e.message),
    'Diagnóstico usa formato set(N chars)'));
}

// --- T7: NODE_ENV=development pula validação ---
log('\n=== T7: Development mode bypassa validação ===');
reset();
process.env.NODE_ENV = 'development';
try {
  sc.assertProductionEnv();
  record(passIf(true, 'Development pula validação produção'));
} catch (e) {
  record(passIf(false, 'T7 não deveria bloquear: ' + e.message));
}

// --- T8: CORS builder respeita lista normalizada ---
log('\n=== T8: buildCorsOptions normaliza origens ===');
reset();
process.env.NODE_ENV = 'production';
process.env.ALLOWED_ORIGINS = 'https://a.onrender.com,  https://b.com/  ';
const corsOpts = sc.buildCorsOptions();
let corsOk = true;
corsOpts.origin('https://a.onrender.com', (err) => { if (err) corsOk = false; });
corsOpts.origin('https://b.com', (err) => { if (err) corsOk = false; });
corsOpts.origin('https://malicioso.com', (err) => { if (!err) corsOk = false; });
record(passIf(corsOk, 'CORS aceita lista + bloqueia origem desconhecida'));

// --- T9: STRICT_REAL_ONLY=false bloqueia em produção ---
log('\n=== T9: STRICT_REAL_ONLY=false bloqueia em produção ===');
reset();
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://u:p@host/db';
process.env.JWT_SECRET = 'j'.repeat(64);
process.env.SESSION_SECRET = 'k'.repeat(40);
process.env.STRICT_REAL_ONLY = 'false';
process.env.RENDER_EXTERNAL_URL = 'https://x.onrender.com';
try {
  sc.assertProductionEnv();
  record(passIf(false, 'T9 deveria ter bloqueado'));
} catch (e) {
  record(passIf(/STRICT_REAL_ONLY/.test(e.message), 'Bloqueia STRICT_REAL_ONLY=false'));
}

// --- T10: Sem DATABASE_URL nem PGHOST bloqueia ---
log('\n=== T10: Sem Postgres em produção bloqueia ===');
reset();
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'l'.repeat(64);
process.env.SESSION_SECRET = 'm'.repeat(40);
process.env.RENDER_EXTERNAL_URL = 'https://x.onrender.com';
try {
  sc.assertProductionEnv();
  record(passIf(false, 'T10 deveria ter bloqueado'));
} catch (e) {
  record(passIf(/DATABASE_URL ou PGHOST/.test(e.message),
    'Bloqueia produção sem Postgres'));
}

// === Resumo final ===
log('\n=== RESUMO ===');
log(allOk ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');

fs.writeFileSync('scripts/test-startup-check.out', lines.join('\n'));
process.exit(allOk ? 0 : 1);
