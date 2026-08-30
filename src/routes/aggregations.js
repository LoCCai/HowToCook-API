import { Router } from 'express';
import { HttpError } from '../middleware/error.js';
import { buildStats } from '../lib/discover.js';
import { queryRecipes, queryTips } from '../lib/search.js';
import { getStore, resolveImageMode } from './helpers.js';
import { summaryOf } from './recipes.js';

const router = Router();

// GET /api/search?q= —— 聚合搜索：一次请求同时返回菜谱与技巧文档
router.get('/search', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    const q = String(req.query.q || '').trim();
    if (!q) {
      throw new HttpError(400, 'MISSING_QUERY', '缺少 q 参数');
    }
    const recipes = queryRecipes(store, { q, page: 1, pageSize: 8 });
    const tips = queryTips(store, { q, page: 1, pageSize: 4 });
    res.json({
      data: {
        recipes: {
          total: recipes.meta.results ?? recipes.meta.total,
          items: recipes.items.map((r) => ({ ...summaryOf(r, imageMode), matched: r._matched })),
        },
        tips: {
          total: tips.meta.results ?? tips.meta.total,
          items: tips.items.map((t) => ({
            id: t.id,
            path: t.path,
            title: t.title,
            group: t.group,
            score: t._score,
            matched: t._matched,
          })),
        },
      },
      meta: { q, image_mode: imageMode },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/stats —— 全库统计
router.get('/stats', (req, res) => {
  res.json({ data: buildStats(getStore(req)) });
});

export default router;
