'use strict';
/**
 * Gera secrets e grava em BACKUP (nunca no repo).
 * Uso: node scripts/apply-secrets-to-env.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const backupDir = 'C:\\sites\\Robotrend_BACKUP_2026-05-21';
const secrets = {
  generatedAt: new Date().toISOString(),
  JWT_SECRET: crypto.randomBytes(64).toString('hex'),
  SESSION_SECRET: crypto.randomBytes(64).toString('hex'),
  POSTGRES_PASSWORD: crypto.randomBytes(24).toString('base64url').slice(0, 32),
};

fs.mkdirSync(backupDir, { recursive: true });
const outPath = path.join(backupDir, 'secrets.generated.json');
fs.writeFileSync(outPath, JSON.stringify(secrets, null, 2), 'utf8');
console.log('Secrets gravados em:', outPath);
console.log(JSON.stringify(secrets, null, 2));
