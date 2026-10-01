'use strict';

const DEFAULT_PORT = 3000;
const DEFAULT_PROBE_TIMEOUT_MS = 30000;
const DEFAULT_RENDER_TIMEOUT_MS = 180000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RENDER_VIDEOS = 10;

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
    renderTimeoutMs: Number(env.RENDER_TIMEOUT_MS) || DEFAULT_RENDER_TIMEOUT_MS,
    maxDownloadBytes: Number(env.MAX_PROBE_DOWNLOAD_BYTES) || DEFAULT_MAX_DOWNLOAD_BYTES,
    maxRedirects: DEFAULT_MAX_REDIRECTS,
    maxRenderVideos: DEFAULT_MAX_RENDER_VIDEOS
  };
}

module.exports = loadConfig(process.env);
module.exports.loadConfig = loadConfig;
