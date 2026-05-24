'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const DST = 'C:\\sites\\Robotrend_BACKUP_2026-05-21';
const SKIP = new Set(['node_modules', '.git']);
const LOG_MAX_AGE_MS = 3 * 24 * 3600 * 1000;

function shouldSkip(name) {
  return SKIP.has(name);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldSkip(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'logs') {
        copyLogs(s, d);
        continue;
      }
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function copyLogs(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  const cutoff = Date.now() - LOG_MAX_AGE_MS;
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.log')) continue;
    const fp = path.join(src, f);
    const st = fs.statSync(fp);
    if (st.mtimeMs >= cutoff) fs.copyFileSync(fp, path.join(dst, f));
  }
}

if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });
copyDir(SRC, DST);
const manifest = `BACKUP_OK\nsource=${SRC}\ndest=${DST}\nwhen=${new Date().toISOString()}\nexcluded=${[...SKIP].join(',')}\n`;
fs.writeFileSync(path.join(DST, 'BACKUP_MANIFEST.txt'), manifest, 'utf8');
console.log('BACKUP_OK', DST);
