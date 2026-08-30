import express from 'express';
import { securityHeaders, cors } from './middleware/security.js';
import { accessLog } from './middleware/access-log.js';
import { cacheControl } from './middleware/cache-control.js';
import { rateLimit } from './middleware/rate-limit.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { assetsHandler } from './routes/assets.js';
import apiRouter from './routes/index.js';
import { config } from './config.js';

export function createApp(store, rebuild) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  app.locals.store = store;
  app.locals.rebuild = rebuild; // 内容更新后重建索引用

  app.use(securityHeaders);
  app.use(cors);
  app.use(cacheControl);
  app.use(rateLimit);
  app.use(accessLog);

  app.get('/', (req, res) => res.redirect('/api'));
  app.use('/api', apiRouter);
  app.use('/assets', assetsHandler(store.repoRoot));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export { config };
