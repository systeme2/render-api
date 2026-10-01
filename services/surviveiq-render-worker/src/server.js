'use strict';

const fastify = require('fastify');
const crypto = require('crypto');
const config = require('./config');
const { timingSafeEqual } = require('./security');
const healthRoute = require('./routes/health');
const probeRoute = require('./routes/probe');
const renderRoute = require('./routes/render');

function buildServer() {
  const app = fastify({
    logger: true,
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID()
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' && request.url.split('?')[0] === '/health') {
      return;
    }
    const header = String(request.headers['authorization'] || '');
    const tokenConfigured = !!config.renderWorkerToken;
    const expected = 'Bearer ' + (config.renderWorkerToken || '');
    if (!tokenConfigured || !header || !timingSafeEqual(header, expected)) {
      reply.code(401);
      throw new Error('Unauthorized');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const status = reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : 500;
    request.log.error({ route: request.url.split('?')[0], status: status }, error.message);
    reply.code(status).send({
      success: false,
      error: {
        code: status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
        message: status === 401 ? 'Unauthorized.' : 'Internal server error.'
      }
    });
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        request_id: request.id,
        route: request.url.split('?')[0],
        status: reply.statusCode,
        duration_ms: reply.elapsedTime
      },
      'request completed'
    );
  });

  app.register(healthRoute);
  app.register(async (instance) => probeRoute(instance, config));
  app.register(async (instance) => renderRoute(instance, config));

  return app;
}

if (require.main === module) {
  const app = buildServer();
  app.listen({ port: config.port, host: config.host }, (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}

module.exports = { buildServer };
