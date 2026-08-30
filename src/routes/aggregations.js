import { Router } from 'express';
import { HttpError } from '../middleware/error.js';
import { buildStats, hashSeed, mulberry32, pickRandom, buildWeekPlan, buildShoppingList, parseTagParam, filterByTags } from '../lib/discover.js';
import { queryRecipes, queryTips } from '../lib/search.js';
import { getStore, resolveImageMode } from './helpers.js';
import { summaryOf } from './recipes.js';

const router = Router();

// GET /api/plan/week?seed=&days=7&meat=1&vegetable=1&soup=1 —— 一周膳食计划（日内组合、周内不重样）
router.get('/plan/week', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    const seed = req.query.seed ? String(req.query.seed) : Date.now().toString(36);
    const rng = mulberry32(hashSeed(`week:${seed}`));

    const days = Math.min(14, Math.max(1, Number.parseInt(req.query.days, 10) || 7));
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
    const maxDifficulty = Number.isNaN(maxDiffRaw) ? null : Math.min(5, Math.max(1, maxDiffRaw));
    const excludeTags = parseTagParam(req.query.exclude_tags);

    const { days: plan, repeats } = buildWeekPlan(store, { days, slots, rng, maxDifficulty, excludeTags });
    res.json({
      data: {
        days: plan.map((d) => ({
          day: d.day,
          meat: d.meat.map((r) => summaryOf(r, imageMode)),
          vegetable: d.vegetable.map((r) => summaryOf(r, imageMode)),
          soup: d.soup.map((r) => summaryOf(r, imageMode)),
        })),
      },
      meta: {
        seed,
        days,
        slots,
        max_difficulty: maxDifficulty,
        exclude_tags: excludeTags,
        repeats, // 池子耗尽后重新洗牌，计划中允许出现重复菜
        image_mode: imageMode,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/shopping-list?ids=a,b,c&servings=4 —— 合并多菜谱原料为购物清单
router.post('/shopping-list', (req, res, next) => {
  try {
    const store = getStore(req);
    const ids = String(req.query.ids || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      throw new HttpError(400, 'MISSING_IDS', '缺少 ids 参数（逗号分隔的菜谱 id，见 GET /api/recipes）');
    }
    if (ids.length > 50) {
      throw new HttpError(400, 'TOO_MANY_RECIPES', '一次最多合并 50 个菜谱');
    }
    let factor = 1;
    if (req.query.servings != null) {
      const servings = Number.parseInt(req.query.servings, 10);
      if (Number.isNaN(servings) || servings < 1 || servings > 100) {
        throw new HttpError(400, 'INVALID_SERVINGS', 'servings 必须是 1-100');
      }
      factor = servings / 2; // HowToCook 菜谱默认基准为 2 人份
    }
    const result = buildShoppingList(store, ids, factor);
    res.json({
      data: result,
      meta: { requested: ids.length, servings: req.query.servings != null ? Number.parseInt(req.query.servings, 10) : null },
    });
  } catch (err) {
    next(err);
  }
});

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
    const excludeTags = parseTagParam(req.query.exclude_tags);

    // 荤菜池包含荤菜与水产
    const poolBy = (categories) =>
      filterByTags(
        store
          .listRecipes()
          .filter((r) => categories.includes(r.category) && (maxDiff == null || (r.difficulty != null && r.difficulty <= maxDiff))),
        null,
        excludeTags
      );

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
        exclude_tags: excludeTags,
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
