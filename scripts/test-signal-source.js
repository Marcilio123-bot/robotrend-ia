'use strict';
/**
 * Unit test do guard de fonte de sinal.
 * node scripts/test-signal-source.js
 */
const freshness = require('../backend/freshness');

const cases = [
  {
    name: 'real api-football fresh (50s ago)',
    match: { id: '12345', isFromLiveAPI: true, source: 'api-football', lastApiUpdate: Date.now() - 50_000 },
    expect: true,
  },
  {
    name: 'real api-football stale (120s ago)',
    match: { id: '12345', isFromLiveAPI: true, source: 'api-football', lastApiUpdate: Date.now() - 120_000 },
    expect: false,
  },
  {
    name: 'demo source',
    match: { id: 'demo-1', isFromLiveAPI: false, source: 'demo', lastApiUpdate: null },
    expect: false,
  },
  {
    name: 'api-football-prelive (não-live)',
    match: { id: '99', isFromLiveAPI: false, source: 'api-football-prelive', lastApiUpdate: Date.now() },
    expect: false,
  },
  {
    name: 'sem flag isFromLiveAPI',
    match: { id: '12345', source: 'api-football', lastApiUpdate: Date.now() },
    expect: false,
  },
  {
    name: 'sem source',
    match: { id: '12345', isFromLiveAPI: true, lastApiUpdate: Date.now() },
    expect: false,
  },
  {
    name: 'source desconhecido',
    match: { id: '12345', isFromLiveAPI: true, source: 'mystery', lastApiUpdate: Date.now() },
    expect: false,
  },
  {
    name: 'sem lastApiUpdate',
    match: { id: '12345', isFromLiveAPI: true, source: 'api-football', lastApiUpdate: 0 },
    expect: false,
  },
  {
    name: 'match vazio',
    match: null,
    expect: false,
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = freshness.checkSignalSource(c.match);
  const ok = r.ok === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  →  ok=${r.ok} reason="${r.reason}"`);
  ok ? pass++ : fail++;
}
console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} — ${pass}/${cases.length}`);
process.exit(fail === 0 ? 0 : 1);
