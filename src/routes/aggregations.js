import { Router } from 'express';
import { HttpError } from '../middleware/error.js';
import { buildStats, hashSeed, mulberry32, pickRandom } from '../lib/discover.js';
import { queryRecipes, queryTips } from '../lib/search.js';
import { getStore, resolveImageMode } from './helpers.js';
import { summaryOf } from './recipes.js';

const router = Router();

// GET /api/menu?seed=&meat=1&vegetable=1&soup=1&max_difficulty= —— 自动配一餐（荤+素+汤）
router.get('/menu', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    const seed = req.query.seed ? String(req.query.seed) : Date.now().toString(36);
    const rng = mulberry32(hashSeed(`menu:${seed}`));

    const clampSlot = (v) => Math.min(3, Math.max(0, Number.parseInt(v, 10) || 0));
    const slotParam = (v, defaultValue) => (v == null || v === '' ? defaultValue : clampSlot(v));
    const slots = {
      meat: slotParam(req.query.meat, 1),
      vegetable: slotParam(req.query.vegetable, 1),
      soup: slotParam(req.query.soup, 1),
    };
    if (slots.meat + slots.vegetable + slots.soup === 0) {
      throw new HttpError(400, 'EMPTY_MENU', '至少需要一个槽位：meat / vegetable / soup');
    }
    const maxDiffRaw = Number.parseInt(req.query.max_difficulty, 10);
    const maxDiff = Number.isNaN(maxDiffRaw) ? null : Math.min(5, Math.max(1, maxDiffRaw));

    // 荤菜池包含荤菜与水产
    const poolBy = (categories) =>
      store
        .listRecipes()
        .filter((r) => categories.includes(r.category) && (maxDiff == null || (r.difficulty != null && r.difficulty <= maxDiff)));

    const pools = {
      meat: poolBy(['meat_dish', 'aquatic']),
      vegetable: poolBy(['vegetable_dish']),
      soup: poolBy(['soup']),
    };

    const data = {};
    for (const [slot, count] of Object.entries(slots)) {
      // 同一 rng 依次抽取，保证相同 seed 得到相同整桌
      data[slot] = count > 0 ? pickRandom(pools[slot], count, rng).map((r) => summaryOf(r, imageMode)) : [];
    }
    // 池子比要求数量少时如实告知（如 max_difficulty 过滤后汤池为空）
    const unfilled = Object.keys(slots).filter((slot) => slots[slot] > data[slot].length);
    res.json({
      data,
      meta: {
        seed,
        slots,
        max_difficulty: maxDiff,
        pool_sizes: { meat: pools.meat.length, vegetable: pools.vegetable.length, soup: pools.soup.length },
        unfilled,
        image_mode: imageMode,
      },
    });
  } catch (err) {
    next(err);
  }
});

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
