'use strict';

const { probeMediaUrl } = require('../ffmpeg');
const { ForbiddenUrlError } = require('../security');

function sanitizeUrlForLog(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    return u.hostname + u.pathname; // never log query params (signed URL signatures live there)
  } catch (e) {
    return '[unparsable]';
  }
}

async function probeRoute(fastify, config) {
  fastify.post('/probe', async (request, reply) => {
    const body = request.body || {};
    const url = body.url;

    if (typeof url !== 'string' || url.length === 0) {
      reply.code(400);
      return {
        success: false,
        error: { code: 'INVALID_BODY', message: 'Body must include a non-empty "url" string.' }
      };
    }

    request.log.info({ route: '/probe', url_hint: sanitizeUrlForLog(url) }, 'probe requested');

    try {
      const media = await probeMediaUrl(url, {
        allowedHosts: config.allowedMediaHosts,
        timeoutMs: config.probeTimeoutMs,
        maxBytes: config.maxDownloadBytes,
        maxRedirects: config.maxRedirects
      });
      return { success: true, media: media };
    } catch (err) {
      if (err instanceof ForbiddenUrlError) {
        reply.code(400);
        return { success: false, error: { code: err.code, message: 'The provided URL is not allowed.' } };
      }
      if (err && err.code === 'TIMEOUT') {
        reply.code(504);
        return { success: false, error: { code: 'PROBE_TIMEOUT', message: 'Media probe timed out.' } };
      }
      request.log.error({ route: '/probe', err_code: err && err.code }, 'probe failed');
      reply.code(502);
      return { success: false, error: { code: 'FFPROBE_FAILED', message: 'Media probe failed.' } };
    }
  });
}

module.exports = probeRoute;
