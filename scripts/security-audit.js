/**
 * Robotrend IA — Security Audit
 *
 * Auditoria estática para garantir que:
 *
 *   1. API_FOOTBALL_KEY nunca aparece em arquivos do frontend
 *   2. .env, secrets/, *.key, *.pem não estão sendo servidos
 *   3. Toda rota /api/football/* exige requireAuth(db)
 *   4. Rotas admin-sensíveis (force-fail, cache/clear, poller/refresh,
 *      metrics, diagnostics, quota) exigem requireAdmin
 *   5. CSP não tem 'unsafe-eval' nem * em script-src
 *   6. Rate-limit configurado em /api/*
 *   7. JWT_SECRET não é o default
 *   8. Helmet ativo
 *   9. Telegram/Bot tokens nunca enviados ao frontend
 *
 * Uso:
 *   node scripts/security-audit.js
 *
 * Exit code != 0 quando algum problema crítico for encontrado.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  yel:   (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  gray:  (s) => `\x1b[90m${s}\x1b[0m`,
};

let crit = 0, warn = 0, ok = 0;
function pass(msg) { console.log(`  ${C.green('✔')} ${msg}`); ok++; }
function bad(msg, extra) {
  console.log(`  ${C.red('✘ CRIT')} ${msg}` + (extra ? ` ${C.gray(extra)}` : ''));
  crit++;
}
function alert(msg, extra) {
  console.log(`  ${C.yel('! WARN')} ${msg}` + (extra ? ` ${C.gray(extra)}` : ''));
  warn++;
}

function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (!exts || exts.some((x) => full.endsWith(x))) out.push(full);
    }
  }
  return out;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/* ============================================================
   1) API KEY no frontend
   ============================================================ */
console.log(C.yel('\n▶ 1) API_FOOTBALL_KEY / segredos no frontend'));
const frontendFiles = walk(path.join(ROOT, 'frontend'), ['.html', '.js', '.css']);
const secretPatterns = [
  { name: 'API_FOOTBALL_KEY', re: /API_FOOTBALL_KEY|x-apisports-key/i },
  { name: 'TELEGRAM_BOT_TOKEN', re: /TELEGRAM_BOT_TOKEN/ },
  { name: 'JWT_SECRET', re: /JWT_SECRET/ },
  { name: 'STRIPE_SECRET', re: /STRIPE_SECRET|sk_(test|live)_/ },
  { name: 'MP_ACCESS_TOKEN', re: /MP_ACCESS_TOKEN/ },
  { name: 'PG password', re: /PGPASSWORD|DATABASE_URL=postgres/ },
];
let leakFound = false;
for (const f of frontendFiles) {
  const txt = read(f);
  for (const p of secretPatterns) {
    if (p.re.test(txt)) {
      bad(`vazamento de "${p.name}" em ${path.relative(ROOT, f)}`);
      leakFound = true;
    }
  }
}
if (!leakFound) pass('nenhum segredo conhecido no frontend');

/* ============================================================
   2) Arquivos sensíveis NÃO acessíveis (estático)
   ============================================================ */
console.log(C.yel('\n▶ 2) Arquivos sensíveis não publicáveis'));
const exposedRoot = ['.env', '.env.production', '.env.local', 'secrets', 'credentials.json'];
for (const f of exposedRoot) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { pass(`${f} ausente (OK)`); continue; }
  // Se for static-served, conferir gitignore + verificar express.static path
  // A regra: arquivos sensíveis NÃO devem estar dentro de frontend/
  if (p.includes('frontend' + path.sep)) bad(`${f} está dentro de frontend/`, 'remova daqui');
  else pass(`${f} fora de frontend/ (OK)`);
}
// Checar se serverstatic aponta para algo perigoso
const serverCode = read(path.join(ROOT, 'backend', 'server.js'));
if (/express\.static\([^)]*['"]\.\.['"]/.test(serverCode)) bad('express.static aponta para "..": expõe a raiz do projeto');
else pass('express.static não expõe raiz do projeto');

/* ============================================================
   3) /api/football/* protegidas por requireAuth
   ============================================================ */
console.log(C.yel('\n▶ 3) Rotas /api/football/* exigem requireAuth'));
const footballRoutesCode = read(path.join(ROOT, 'backend', 'routes', 'football.js'));
if (/app\.use\(['"]\/api\/football['"],\s*requireAuth\s*\(/.test(footballRoutesCode)) pass('app.use(/api/football, requireAuth(db), router) presente');
else bad('routes/football.js não monta o router com requireAuth(db)');

/* ============================================================
   4) Rotas admin com requireAdmin
   ============================================================ */
console.log(C.yel('\n▶ 4) Rotas admin-sensíveis exigem requireAdmin'));
const adminSensitiveRoutes = [
  '/quota',
  '/cache/clear',
  '/poller/refresh',
  '/metrics',
  '/metrics.prom',
  '/diagnostics',
  '/test/force-fail',
  '/signals/engine',
];
for (const route of adminSensitiveRoutes) {
  // procura router.(get|post)\([..]'route'.. requireAdmin
  const re = new RegExp(`router\\.(get|post)\\(['"\`]${route.replace('/', '\\/')}['"\`][^)]+requireAdmin`);
  if (re.test(footballRoutesCode)) pass(`${route} exige requireAdmin`);
  else bad(`${route} NÃO exige requireAdmin (ou regex falhou)`);
}

/* ============================================================
   5) CSP segura
   ============================================================ */
console.log(C.yel('\n▶ 5) CSP / Helmet'));
const securityCode = read(path.join(ROOT, 'backend', 'security.js'));
if (/require\(['"]helmet['"]\)/.test(securityCode)) pass('helmet importado');
else bad('helmet NÃO importado em security.js');
if (/contentSecurityPolicy/.test(securityCode)) pass('CSP configurada');
else bad('CSP NÃO configurada');
if (/unsafe-eval/.test(securityCode)) bad("CSP tem 'unsafe-eval' (perigoso)");
else pass("CSP sem 'unsafe-eval'");
if (/"script-src":\s*\[[^\]]*"\*"/.test(securityCode)) bad('CSP script-src contém wildcard *');
else pass('CSP script-src sem wildcard *');

/* ============================================================
   6) Rate limit
   ============================================================ */
console.log(C.yel('\n▶ 6) Rate limit'));
if (/express-rate-limit/.test(securityCode)) pass('express-rate-limit configurado');
else alert('express-rate-limit não configurado');
if (/app\.use\(['"]\/api\/['"],\s*generalLimiter\)/.test(securityCode)) pass('rate-limit aplicado em /api/');
else alert('rate-limit não aplicado especificamente em /api/');

/* ============================================================
   7) JWT_SECRET não-default
   ============================================================ */
console.log(C.yel('\n▶ 7) JWT_SECRET'));
const secret = process.env.JWT_SECRET || '';
if (!secret) bad('JWT_SECRET ausente');
else if (/dev_secret|change_in_production|robotrend_dev_secret/i.test(secret) || secret.length < 32) {
  bad('JWT_SECRET parece ser default/dev', 'gere com `npm run secrets:generate`');
} else pass('JWT_SECRET parece forte (≥32 chars, não-default)');

/* ============================================================
   8) CORS
   ============================================================ */
console.log(C.yel('\n▶ 8) CORS'));
const allowed = (process.env.ALLOWED_ORIGINS || '').trim();
if (!allowed) alert('ALLOWED_ORIGINS vazio (CORS pode estar liberado)');
else if (allowed === '*') bad('ALLOWED_ORIGINS=* (perigoso em produção)');
else pass(`ALLOWED_ORIGINS configurado: ${allowed}`);
if (/cors\(\{[^}]*origin\s*:\s*['"]?\*/.test(serverCode)) bad('server.js usa cors({ origin: "*" })');
else pass('server.js não usa cors origin:*');

/* ============================================================
   9) Logs não vazam tokens
   ============================================================ */
console.log(C.yel('\n▶ 9) Logs não vazam tokens'));
const logCode = read(path.join(ROOT, 'backend', 'logger.js'));
if (/Authorization|Bearer\s*\$/.test(logCode)) alert('logger pode estar logando headers Authorization', 'verifique sanitização');
else pass('logger.js não loga Authorization (heurística)');

// Checa httpMiddleware do logger
if (/Authorization/.test(serverCode)) alert('server.js menciona Authorization — confirmar que NÃO loga');
else pass('server.js não menciona Authorization em código de log');

/* ============================================================
   10) .env é gitignored
   ============================================================ */
console.log(C.yel('\n▶ 10) .env no .gitignore'));
const ignore = read(path.join(ROOT, '.gitignore'));
if (!ignore) alert('.gitignore não encontrado');
else if (!/\.env\b/.test(ignore)) bad('.env NÃO está no .gitignore');
else pass('.env está no .gitignore');

/* ============================================================
   SUMÁRIO
   ============================================================ */
console.log(C.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(`  ${C.green('✔ ok')}    ${ok}`);
console.log(`  ${C.yel('! warn')}  ${warn}`);
console.log(`  ${C.red('✘ crit')}  ${crit}`);
console.log(C.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

if (crit > 0) {
  console.log(C.red(`Auditoria FALHOU com ${crit} problemas críticos.`));
  process.exit(1);
}
if (warn > 0) console.log(C.yel(`Auditoria passou com ${warn} avisos para revisão.`));
else console.log(C.green('Auditoria 100% aprovada. ✓'));
process.exit(0);
