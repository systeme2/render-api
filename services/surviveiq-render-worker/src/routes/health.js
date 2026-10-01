'use strict';

const { getFfmpegVersion, getFfprobeVersion } = require('../ffmpeg');

async function healthRoute(fastify) {
  fastify.get('/health', async () => {
    const [ffmpeg, ffprobe] = await Promise.all([getFfmpegVersion(), getFfprobeVersion()]);
    return {
      ok: ffmpeg.available && ffprobe.available,
      service: 'surviveiq-render-worker',
      ffmpeg_available: ffmpeg.available,
      ffprobe_available: ffprobe.available,
      ffmpeg_version: ffmpeg.version,
      ffprobe_version: ffprobe.version
    };
  });
}

module.exports = healthRoute;
