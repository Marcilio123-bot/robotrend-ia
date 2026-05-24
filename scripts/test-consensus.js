'use strict';
/**
 * Unit test do Multi-API Consensus Engine.
 *   node scripts/test-consensus.js
 *
 * Usa fontes mockadas (injetadas via opts.sources) — não bate em APIs reais.
 */
const consensus = require('../backend/consensus');

const NOW = Date.now();
const ts = (deltaSec = 0) => NOW + deltaSec * 1000;

function mockSource(map) {
  return async () => new Map(Object.entries(map).map(([k, v]) => [
    consensus.matchKey({ home: k.split('__vs__')[0], away: k.split('__vs__')[1] }),
    v,
  ]));
}

const matches = [
  { id: '1', home: 'Flamengo', away: 'Vasco' },                // confirmado nas 3
  { id: '2', home: 'Manchester City', away: 'Liverpool' },     // só em status (divergente)
  { id: '3', home: 'Real Madrid', away: 'Barcelona' },         // spread > 60s
  { id: '4', home: 'PSG', away: 'Marseille' },                 // confirmado nas 3
];

const sourcesAllOk = {
  status: mockSource({
    'flamengo__vs__vasco':            { status: '1H', timestamp: ts(0) },
    'manchestercity__vs__liverpool':  { status: '1H', timestamp: ts(0) },
    'realmadrid__vs__barcelona':      { status: '1H', timestamp: ts(0) },
    'psg__vs__marseille':             { status: '2H', timestamp: ts(0) },
  }),
  events: mockSource({
    'flamengo__vs__vasco':            { status: 'live', timestamp: ts(5) },
    'realmadrid__vs__barcelona':      { status: 'live', timestamp: ts(120) }, // spread 2 min
    'psg__vs__marseille':             { status: 'live', timestamp: ts(-3) },
  }),
  odds: mockSource({
    'flamengo__vs__vasco':            { status: 'live', timestamp: ts(-2) },
    'realmadrid__vs__barcelona':      { status: 'live', timestamp: ts(-5) },
    'psg__vs__marseille':             { status: 'live', timestamp: ts(10) },
  }),
};

const sourcesOneFail = {
  status: mockSource({
    'flamengo__vs__vasco': { status: '1H', timestamp: ts(0) },
  }),
  events: mockSource({
    'flamengo__vs__vasco': { status: 'live', timestamp: ts(5) },
  }),
  odds: async () => { throw new Error('odds api down'); },
};

(async () => {
  let pass = 0, fail = 0;

  // Caso 1: STRICT off → tudo passa intacto
  const r1 = await consensus.confirmMatches(matches, { strict: false, sources: sourcesAllOk });
  if (r1.confirmed.length === matches.length && r1.failedSources.length === 0) {
    console.log('PASS  strict=false bypass (4/4)');
    pass++;
  } else {
    console.log(`FAIL  strict=false bypass — confirmed=${r1.confirmed.length} failed=${r1.failedSources.length}`);
    fail++;
  }

  // Caso 2: STRICT on, todas fontes ok
  const r2 = await consensus.confirmMatches(matches, { strict: true, sources: sourcesAllOk });
  const exp2 = ['Flamengo', 'PSG'];
  const got2 = r2.confirmed.map((m) => m.home);
  if (r2.confirmed.length === 2 && got2.every((h) => exp2.includes(h))) {
    console.log('PASS  strict=true: 2 confirmados (Flamengo, PSG); 2 divergentes (Man City sem source, Real Madrid spread)');
    pass++;
  } else {
    console.log(`FAIL  strict=true: confirmed=${JSON.stringify(got2)} divergences=${r2.divergences.length}`);
    fail++;
  }

  // Caso 3: metadados de consensus presentes
  const flam = r2.confirmed.find((m) => m.home === 'Flamengo');
  if (flam?.consensus?.sources?.length === 3 && Number.isFinite(flam.consensus.timestampSpreadMs)) {
    console.log(`PASS  metadados consensus presentes (spread=${flam.consensus.timestampSpreadMs}ms)`);
    pass++;
  } else {
    console.log('FAIL  metadados consensus ausentes');
    fail++;
  }

  // Caso 4: divergências logadas
  if (r2.divergences.length === 2) {
    console.log(`PASS  divergências detectadas (${r2.divergences.length})`);
    pass++;
  } else {
    console.log(`FAIL  divergências esperadas=2 obtidas=${r2.divergences.length}`);
    fail++;
  }

  // Caso 5: source falhando → bloqueio total
  const r3 = await consensus.confirmMatches(matches, { strict: true, sources: sourcesOneFail });
  if (r3.confirmed.length === 0 && r3.failedSources.includes('odds')) {
    console.log(`PASS  source "odds" falhou → 0/${matches.length} confirmados (failed=${r3.failedSources.join(',')})`);
    pass++;
  } else {
    console.log(`FAIL  bloqueio por source — confirmed=${r3.confirmed.length} failed=${r3.failedSources}`);
    fail++;
  }

  // Caso 6: array vazio
  const r4 = await consensus.confirmMatches([], { strict: true, sources: sourcesAllOk });
  if (r4.confirmed.length === 0 && r4.failedSources.length === 0) {
    console.log('PASS  array vazio devolve []');
    pass++;
  } else {
    console.log(`FAIL  array vazio — confirmed=${r4.confirmed.length}`);
    fail++;
  }

  // Caso 7: matchKey normalização (acentos + caixa)
  const k1 = consensus.matchKey({ home: 'São Paulo', away: 'Atlético-MG' });
  const k2 = consensus.matchKey({ home: 'sao paulo', away: 'atletico mg' });
  if (k1 === k2) {
    console.log(`PASS  matchKey normaliza acentos + caixa (${k1})`);
    pass++;
  } else {
    console.log(`FAIL  matchKey normalize — "${k1}" vs "${k2}"`);
    fail++;
  }

  // Caso 8: withRetry tenta 3 vezes
  let attempts = 0;
  try {
    await consensus.withRetry('mock', async () => { attempts++; throw new Error('boom'); }, 3, 5);
    console.log('FAIL  withRetry deveria lançar');
    fail++;
  } catch (_) {
    if (attempts === 3) {
      console.log('PASS  withRetry executou 3 tentativas');
      pass++;
    } else {
      console.log(`FAIL  withRetry attempts=${attempts}`);
      fail++;
    }
  }

  // Caso 9: withRetry sucesso na 2ª
  let attempts2 = 0;
  const ok = await consensus.withRetry('mock2', async () => {
    attempts2++;
    if (attempts2 < 2) throw new Error('temporário');
    return 'ok';
  }, 3, 5);
  if (ok === 'ok' && attempts2 === 2) {
    console.log('PASS  withRetry recupera na 2ª tentativa');
    pass++;
  } else {
    console.log(`FAIL  withRetry recovery — attempts=${attempts2} result=${ok}`);
    fail++;
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} — ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(2);
});
