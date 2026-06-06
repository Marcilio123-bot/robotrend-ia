/**
 * Robotrend IA — Versão de assets (cache busting central)
 * ---------------------------------------------------------------
 * Fonte única da verdade para o "selo de versão" dos arquivos
 * estáticos (JS/CSS) servidos ao navegador.
 *
 * ASSET_VERSION = <versão do package.json>-<hash do conteúdo dos assets>
 *
 * O hash é calculado a partir do CONTEÚDO de todos os .js/.css do
 * frontend no boot do processo. Consequência:
 *   - Sempre que QUALQUER asset muda (deploy real), o hash muda →
 *     todas as URLs versionadas mudam → navegador e service worker
 *     são forçados a baixar a versão nova (fim do cache stale).
 *   - Se nada mudou, o hash permanece igual → o navegador reaproveita
 *     o cache (resposta 304/cache-hit), sem download desnecessário.
 *
 * Override opcional: defina ASSET_BUILD_ID no ambiente (ex.: SHA do
 * commit no deploy) para um selo determinístico por release.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pkgVersion = '0.0.0';
try {
  pkgVersion = require('../package.json').version || '0.0.0';
} catch (_) { /* mantém fallback */ }

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const ASSET_EXT_RE = /\.(js|css)$/i;

/** Coleta recursivamente todos os arquivos .js/.css do frontend. */
function collectAssetFiles(dir, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectAssetFiles(full, acc);
    } else if (ASSET_EXT_RE.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Hash curto (8 chars) do conteúdo de todos os assets. */
function computeBuildSignature() {
  try {
    const files = collectAssetFiles(FRONTEND_DIR).sort();
    if (!files.length) return 'static';
    const hash = crypto.createHash('sha1');
    for (const file of files) {
      try {
        const rel = path.relative(FRONTEND_DIR, file).replace(/\\/g, '/');
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
      } catch (_) { /* ignora arquivo ilegível */ }
    }
    return hash.digest('hex').slice(0, 8);
  } catch (_) {
    return 'static';
  }
}

const BUILD_SIGNATURE = (process.env.ASSET_BUILD_ID || '').trim() || computeBuildSignature();
const ASSET_VERSION = `${pkgVersion}-${BUILD_SIGNATURE}`;

module.exports = {
  APP_VERSION: pkgVersion,
  BUILD_SIGNATURE,
  ASSET_VERSION,
};
