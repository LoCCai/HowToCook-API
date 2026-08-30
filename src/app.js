import express from 'express';
import { securityHeaders, cors } from './middleware/security.js';
import { accessLog } from './middleware/access-log.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { assetsHandler } from './routes/assets.js';
import apiRouter from './routes/index.js';
import { config } from './config.js';

export function createApp(store) {
  const app = express();
  app.disable('x-powered-by');

  app.locals.store = store;

  app.use(securityHeaders);
  app.use(cors);
  app.use(accessLog);

  app.get('/', (req, res) => res.redirect('/api'));
  app.use('/api', apiRouter);
  app.use('/assets', assetsHandler(store.repoRoot));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export { config };
