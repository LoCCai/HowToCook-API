import { Router } from 'express';
import docsRouter from './docs.js';
import categoriesRouter from './categories.js';
import recipesRouter from './recipes.js';
import tipsRouter from './tips.js';
import aggregationsRouter from './aggregations.js';

const api = Router();

api.use('/', docsRouter);
api.use('/', aggregationsRouter);
api.use('/categories', categoriesRouter);
api.use('/recipes', recipesRouter);
api.use('/tips', tipsRouter);

export default api;
