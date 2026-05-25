#!/usr/bin/env node
/**
 * Smoke test do footballProvider híbrido.
 * Carrega providers, checa interface, NÃO faz request real à internet.
 *
 * Uso: node scripts/test-provider-switch.js
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const provider = require('../backend/services/footballProvider');

console.log('Priority order   :', provider.priority);
console.log('Active provider  :', provider.providerName);
console.log('Available        :', provider.providers);
console.log('isConfigured()   :', provider.isConfigured());
console.log('isSafeMode()     :', provider.isSafeMode());

const status = provider.status();
console.log('status() preview :', {
  provider: status.provider,
  activeProvider: status.activeProvider,
  baseURL: status.baseURL,
  breaker: status.breaker?.state,
});

// Checa que TODOS os métodos da interface existem e são funções
const expected = [
  'getLiveFixtures','getFixtureById','getFixturesByDate','getFixturesByTeam',
  'getFixtureStatistics','getFixtureEvents','getFixtureLineups',
  'getHeadToHead','getPredictions','getOdds','getOddsLive',
  'getTeamStatistics','getLeagues','cacheClear','status','quota',
  'isConfigured','isSafeMode','safeMode','remainingRatio',
];
const missing = expected.filter((m) => typeof provider[m] !== 'function');
console.log('Métodos faltando :', missing.length ? missing : '(nenhum)');

console.log('\n✅ Provider switch carregou sem crash.');
console.log('   Próximo passo: npm run dev → abrir http://localhost:3010/football.html');
