#!/usr/bin/env node
/**
 * Robotrend IA — Gerador de secrets para produção
 *
 * Saída padrão: formato KEY=value (cola direto no painel do Render
 * em Environment, ou em um arquivo .env.production).
 *
 * Uso:
 *   node scripts/generate-secrets.js              # KEY=value (default)
 *   node scripts/generate-secrets.js --json       # JSON estruturado
 *   node scripts/generate-secrets.js --render     # instruções para Render
 *
 * Os valores são criptograficamente seguros (crypto.randomBytes).
 */
'use strict';

const crypto = require('crypto');

const args = new Set(process.argv.slice(2));
const fmtJson   = args.has('--json');
const fmtRender = args.has('--render');

const secrets = {
  JWT_SECRET:               crypto.randomBytes(64).toString('hex'),       // 128 chars hex
  SESSION_SECRET:           crypto.randomBytes(48).toString('hex'),       //  96 chars hex
  BOOTSTRAP_ADMIN_PASSWORD: crypto.randomBytes(16).toString('base64url'), //  22 chars base64url
  WEBHOOK_SECRET:           crypto.randomBytes(32).toString('hex'),       //  64 chars hex
  METRICS_TOKEN:            crypto.randomBytes(24).toString('hex'),       //  48 chars hex
  POSTGRES_PASSWORD:        crypto.randomBytes(24).toString('base64url').slice(0, 32),
};

if (fmtJson) {
  console.log(JSON.stringify(secrets, null, 2));
  process.exit(0);
}

if (fmtRender) {
  console.log('# ============================================================');
  console.log('# Robotrend IA — Variáveis de ambiente para Render.com');
  console.log('# Cole cada uma no painel Environment do serviço web.');
  console.log('# ============================================================\n');
  console.log('NODE_ENV=production');
  console.log('PORT=3010');
  console.log('TZ=America/Sao_Paulo\n');
  console.log('# --- Secrets (recém-gerados) ---');
  for (const [k, v] of Object.entries(secrets)) {
    console.log(`${k}=${v}`);
  }
  console.log('\n# --- Domínios / CORS ---');
  console.log('ALLOWED_ORIGINS=https://SEU-DOMINIO.onrender.com');
  console.log('APP_URL=https://SEU-DOMINIO.onrender.com');
  console.log('PUBLIC_URL=https://SEU-DOMINIO.onrender.com\n');
  console.log('# --- Postgres (Render vincula automaticamente via blueprint) ---');
  console.log('# DATABASE_URL → "Add from Database" → robotrend-pg / connectionString');
  console.log('# PGSSL=true  (ligado automaticamente para hosts *.render.com)\n');
  console.log('# --- API externas (preencher manualmente) ---');
  console.log('API_FOOTBALL_KEY=...');
  console.log('MP_ACCESS_TOKEN=...');
  console.log('MP_PUBLIC_KEY=...');
  console.log('STRIPE_SECRET_KEY=...');
  console.log('TELEGRAM_BOT_TOKEN=...');
  process.exit(0);
}

// Default: KEY=value plano
console.log('# Robotrend IA — secrets gerados ' + new Date().toISOString());
console.log('# Cole estas linhas no painel Environment do Render (ou em .env.production)');
console.log('');
for (const [k, v] of Object.entries(secrets)) {
  console.log(`${k}=${v}`);
}
