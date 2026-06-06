#!/usr/bin/env node
'use strict';
// Probe local: simula resposta do endpoint sem subir o servidor.
const usage = require('../backend/services/apiUsageTracker').snapshot();
const payload = {
  ok: true,
  callsToday: usage.callsToday,
  callsLastHour: usage.callsLastHour,
  byEndpoint: usage.byEndpoint,
  credits: { limit: null, consumed: usage.callsToday, remaining: null, source: 'probe' },
  gamesMonitored: 0,
  consumption: {
    poller: usage.pollerToday,
    enricher: usage.enricherToday,
    route: usage.routeToday,
    other: usage.otherToday,
  },
  report: {
    avgDaily: usage.avgDaily,
    todayProjected: usage.todayProjected,
    monthlyProjection: usage.avgDaily * 30,
    riskLevel: 'BAIXO',
    riskRatio: null,
  },
  charts: { hourly: usage.charts.hourly.length, daily: usage.charts.daily.length },
  totalSinceBoot: usage.totalSinceBoot,
  generatedAt: usage.generatedAt,
};
console.log(JSON.stringify(payload, null, 2));
