/**
 * Validação de hosts/URLs para APIs externas — evita fetch com host vazio/undefined.
 */
'use strict';

const PLACEHOLDER_HOSTS = new Set(['undefined', 'null', 'none', 'localhost', '']);

/** Hostname válido (FQDN ou subdomínio API-Sports). */
function normalizeHost(raw) {
  const h = String(raw ?? '').trim();
  if (!h || PLACEHOLDER_HOSTS.has(h.toLowerCase())) return '';
  // Remove protocolo/path acidental no env
  const cleaned = h.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].trim();
  if (!cleaned || PLACEHOLDER_HOSTS.has(cleaned.toLowerCase())) return '';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(cleaned) && !/^[a-z0-9.-]+$/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

function buildHttpsBase(host, pathSuffix = '') {
  const h = normalizeHost(host);
  if (!h) return '';
  const suffix = pathSuffix ? (pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`) : '';
  return `https://${h}${suffix}`;
}

/**
 * Monta URL absoluta para log (sem expor apiKey em query).
 */
function buildRequestUrl(baseUrl, path, params = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  const p = String(path || '').replace(/^\//, '');
  const url = new URL(p ? `${base}/${p}` : base);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Mascara apiKey em query string para logs. */
function maskSecretsInUrl(url) {
  return String(url).replace(/([?&]apiKey=)[^&]+/gi, '$1***');
}

function logExternalRequest(service, method, url, extra = {}) {
  const safe = maskSecretsInUrl(url);
  if (!safe) {
    console.warn(`[${service}] request bloqueada — URL vazia ou host inválido`, extra);
    return;
  }
  console.log(`[${service}] ${method} ${safe}`, Object.keys(extra).length ? extra : undefined);
}

function isDnsOrNetworkSkip(err) {
  const code = err?.code || '';
  const msg = String(err?.message || '');
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    /getaddrinfo/i.test(msg)
  );
}

module.exports = {
  normalizeHost,
  buildHttpsBase,
  buildRequestUrl,
  maskSecretsInUrl,
  logExternalRequest,
  isDnsOrNetworkSkip,
};
