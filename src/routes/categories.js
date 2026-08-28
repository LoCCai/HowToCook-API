import { Router } from 'express';
import { getStore } from './helpers.js';

const router = Router();

// GET /api/categories —— 分类列表（含中文名与菜谱数量）
router.get('/', (req, res) => {
  const store = getStore(req);
  const categories = store.categories.map((c) => ({
    ...c,
    recipes_url: `/api/recipes?category=${encodeURIComponent(c.id)}`,
  }));
  res.json({ data: categories, meta: { total: categories.length } });
});

export default router;
