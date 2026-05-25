/**
 * Robotrend IA — variáveis de ambiente centralizadas.
 * Importe daqui em vez de acessar process.env espalhado ou usar
 * identificadores globais não declarados (ex.: BASE_URL).
 */
'use strict';

const PORT = Number(process.env.PORT || 3010);

/** URL pública do app (frontend + links). */
const BASE_URL = String(
  process.env.BASE_URL ||
  process.env.APP_URL ||
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, '');

const APP_URL = String(process.env.APP_URL || BASE_URL).replace(/\/+$/, '');
const PUBLIC_URL = String(process.env.PUBLIC_URL || BASE_URL).replace(/\/+$/, '');

const NODE_ENV = process.env.NODE_ENV || 'development';

module.exports = {
  PORT,
  BASE_URL,
  APP_URL,
  PUBLIC_URL,
  NODE_ENV,
};
