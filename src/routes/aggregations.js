import { Router } from 'express';
import { HttpError } from '../middleware/error.js';
import { buildStats, hashSeed, mulberry32, pickRandom, buildWeekPlan, buildShoppingList, parseTagParam, filterByTags, parseDailySlots, SLOT_CATEGORIES } from '../lib/discover.js';
import { queryRecipes, queryTips } from '../lib/search.js';
import { getStore, resolveImageMode } from './helpers.js';
import { summaryOf } from './recipes.js';

const router = Router();

// 启发式标签的诚信说明：随计划 / 清单类响应一并返回，防止下游当作营养学结论
const DIET_TAGS_NOTE = 'diet_tags 为原料关键词启发式判定，仅供过滤参考，不构成营养学或过敏原建议';

const DIET_NOTE = { diet_tags_note: DIET_TAGS_NOTE };

// 解析六槽位参数：返回 { slot: number[] }（按天）与原始槽数总计
function parsePlanSlots(query, days, { defaults = { meat: 1, vegetable: 1, soup: 1 } } = {}) {
  const slots = {};
  let total = 0;
  for (const slot of Object.keys(SLOT_CATEGORIES)) {
    const def = defaults[slot] ?? 0;
    const perDay = query != null && query[slot] != null ? parseDailySlots(query[slot], def, days) : parseDailySlots(null, def, days);
    slots[slot] = perDay;
    total += perDay.reduce((a, b) => a + b, 0);
  }
  return { slots, total };
}

// GET /api/plan/week —— 一周膳食计划（默认每日一荤一素一汤；支持六槽位、按天槽数、早餐等）
router.get('/plan/week', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    const seed = req.query.seed ? String(req.query.seed) : Date.now().toString(36);
    const rng = mulberry32(hashSeed(`week:${seed}:${req.query.with_shopping_list === '1' ? 'sl' : ''}`));

    const days = Math.min(14, Math.max(1, Number.parseInt(req.query.days, 10) || 7));
    const { slots, total } = parsePlanSlots(req.query, days);
    if (total === 0) {
      throw new HttpError(400, 'EMPTY_MENU', '至少需要一个槽位：meat / vegetable / soup / breakfast / drink / dessert');
    }
    const maxDiffRaw = Number.parseInt(req.query.max_difficulty, 10);
    const maxDifficulty = Number.isNaN(maxDiffRaw) ? null : Math.min(5, Math.max(1, maxDiffRaw));
    const excludeTags = parseTagParam(req.query.exclude_tags);

    const { days: plan, repeats, unfilled } = buildWeekPlan(store, { days, slots, rng, maxDifficulty, excludeTags });

    const withShopping = req.query.with_shopping_list === '1';
    let staticFactor = 1;
    let perServingFactor = 1;
    let servings = null;
    if (req.query.servings != null) {
      const s = Number.parseInt(req.query.servings, 10);
      if (Number.isNaN(s) || s < 1 || s > 100) {
        throw new HttpError(400, 'INVALID_SERVINGS', 'servings 必须是 1-100');
      }
      servings = s;
      staticFactor = s / 2;
      perServingFactor = s;
    }

    const data = {
      days: plan.map((d) => {
        const out = { day: d.day };
        for (const slot of Object.keys(slots)) {
          out[slot] = d[slot].map((r) => summaryOf(r, imageMode));
        }
        return out;
      }),
    };
    if (withShopping) {
      const allIds = plan.flatMap((d) => Object.keys(slots).flatMap((slot) => d[slot].map((r) => r.id)));
      data.shopping_list = buildShoppingList(store, allIds, { staticFactor, perServingFactor });
    }

    res.json({
      data,
      meta: {
        seed,
        days,
        slots,
        max_difficulty: maxDifficulty,
        exclude_tags: excludeTags,
        repeats, // 池子耗尽后重新洗牌，计划中允许出现重复菜
        unfilled, // 池子为空而未能提供的槽位次数
        ...(withShopping ? { shopping_list: { items: data.shopping_list.items.length, servings, scaled: staticFactor !== 1 } } : {}),
        ...DIET_NOTE,
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
    let staticFactor = 1;
    let perServingFactor = 1;
    let servings = null;
    if (req.query.servings != null) {
      const s = Number.parseInt(req.query.servings, 10);
      if (Number.isNaN(s) || s < 1 || s > 100) {
        throw new HttpError(400, 'INVALID_SERVINGS', 'servings 必须是 1-100');
      }
      servings = s;
      staticFactor = s / 2; // 静态数量基准为 2 人份
      perServingFactor = s; // 公式型数量（'* 份数'）本身即每份基准
    }
    const result = buildShoppingList(store, ids, { staticFactor, perServingFactor });
    res.json({
      data: result,
      meta: { requested: ids.length, servings: req.query.servings != null ? Number.parseInt(req.query.servings, 10) : null, ...DIET_NOTE },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/menu?seed=&meat=1&vegetable=1&soup=1&max_difficulty= —— 自动配一餐（六槽位自由组合）
router.get('/menu', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    const seed = req.query.seed ? String(req.query.seed) : Date.now().toString(36);
    const rng = mulberry32(hashSeed(`menu:${seed}`));

    const clampSlot = (v, def) => (v == null || v === '' ? def : Math.min(3, Math.max(0, Number.parseInt(v, 10) || 0)));
    const slots = {};
    let total = 0;
    for (const slot of Object.keys(SLOT_CATEGORIES)) {
      slots[slot] = clampSlot(req.query[slot], slot === 'meat' || slot === 'vegetable' || slot === 'soup' ? 1 : 0);
      total += slots[slot];
    }
    if (total === 0) {
      throw new HttpError(400, 'EMPTY_MENU', '至少需要一个槽位：meat / vegetable / soup / breakfast / drink / dessert');
    }
    const maxDiffRaw = Number.parseInt(req.query.max_difficulty, 10);
    const maxDiff = Number.isNaN(maxDiffRaw) ? null : Math.min(5, Math.max(1, maxDiffRaw));
    const excludeTags = parseTagParam(req.query.exclude_tags);

    // 各槽位按其分类池过滤
    const poolBy = (categories) =>
      filterByTags(
        store
          .listRecipes()
          .filter((r) => categories.includes(r.category) && (maxDiff == null || (r.difficulty != null && r.difficulty <= maxDiff))),
        null,
        excludeTags
      );

    const data = {};
    const pool_sizes = {};
    for (const [slot, categories] of Object.entries(SLOT_CATEGORIES)) {
      const pool = poolBy(categories);
      pool_sizes[slot] = pool.length;
      // 同一 rng 依次抽取，保证相同 seed 得到相同整桌
      data[slot] = slots[slot] > 0 ? pickRandom(pool, slots[slot], rng).map((r) => summaryOf(r, imageMode)) : [];
    }
    const unfilled = Object.keys(slots).filter((slot) => slots[slot] > 0 && data[slot].length < slots[slot]);
    res.json({
      data,
      meta: {
        seed,
        slots,
        max_difficulty: maxDiff,
        exclude_tags: excludeTags,
        pool_sizes,
        unfilled,
        ...DIET_NOTE,
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
