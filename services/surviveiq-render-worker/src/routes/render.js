'use strict';

const { renderEpisode } = require('../render');
const { ForbiddenUrlError } = require('../security');

async function renderRoute(fastify, config) {
  fastify.post('/render', async (request, reply) => {
    const body = request.body || {};
    const videoCount = Array.isArray(body.video_urls) ? body.video_urls.length : 0;

    request.log.info({
      route: '/render',
      episode_id: typeof body.episode_id === 'string' ? body.episode_id : null,
      video_count: videoCount
    }, 'render requested');

    try {
      const rendered = await renderEpisode(body, config);

      reply
        .code(200)
        .type('video/mp4')
        .header('Content-Length', String(rendered.size_bytes))
        .header('X-Render-Duration-Ms', String(rendered.media.duration_ms || ''))
        .header('X-Render-Size-Bytes', String(rendered.size_bytes));

      return rendered.buffer;
    } catch (err) {
      if (err instanceof ForbiddenUrlError) {
        reply.code(400);
        return { success: false, error: { code: err.code, message: 'One or more media URLs are not allowed.' } };
      }

      if (err && (err.code === 'INVALID_BODY' || err.code === 'UNSUPPORTED_OUTPUT_PROFILE' ||
        err.code === 'INVALID_VIDEO_INPUT' || err.code === 'INVALID_AUDIO_INPUT' ||
        err.code === 'DURATION_MISMATCH')) {
        reply.code(400);
        return { success: false, error: { code: err.code, message: err.message } };
      }

      if (err && err.code === 'TIMEOUT') {
        reply.code(504);
        return { success: false, error: { code: 'RENDER_TIMEOUT', message: 'Video render timed out.' } };
      }

      request.log.error({ route: '/render', err_code: err && err.code }, 'render failed');
      reply.code(502);
      return { success: false, error: { code: 'RENDER_FAILED', message: 'Video render failed.' } };
    }
  });
}

module.exports = renderRoute;
