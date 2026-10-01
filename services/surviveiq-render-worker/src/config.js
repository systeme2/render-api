'use strict';

const DEFAULT_PORT = 3000;
const DEFAULT_PROBE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB, generous for audio/video probing
const DEFAULT_MAX_REDIRECTS = 3;

function parseAllowedHosts(raw) {
  return String(raw || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

function loadConfig(env) {
  env = env || process.env;
  return {
    port: Number(env.PORT) || DEFAULT_PORT,
    host: '0.0.0.0',
    nodeEnv: env.NODE_ENV || 'development',
    renderWorkerToken: env.RENDER_WORKER_TOKEN || null,
    allowedMediaHosts: parseAllowedHosts(env.ALLOWED_MEDIA_HOSTS),
    probeTimeoutMs: Number(env.PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS,
    maxDownloadBytes: Number(env.MAX_PROBE_DOWNLOAD_BYTES) || DEFAULT_MAX_DOWNLOAD_BYTES,
    maxRedirects: DEFAULT_MAX_REDIRECTS
  };
}

module.exports = loadConfig(process.env);
module.exports.loadConfig = loadConfig;
