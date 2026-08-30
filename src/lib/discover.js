import { isToolName } from './parser.js';

const normalizeName = (s) => String(s || '').toLowerCase().replace(/[\s\u3000]+/g, '');

/* ------------------------------------------------------------------ */
/* 原料别名与覆盖匹配                                                    */
/* ------------------------------------------------------------------ */

// 完全同义的原料别名组（匹配时互相展开）；保持小而准，避免误匹配
export const INGREDIENT_ALIAS_GROUPS = [
  ['西红柿', '番茄'],
  ['土豆', '马铃薯', '洋芋'],
  ['包菜', '卷心菜', '圆白菜'],
  ['菜花', '花菜'],
  ['香菜', '芫荽'],
  ['淀粉', '生粉'],
];

/** 展开原料词为其别名组（无别名时返回原词）。 */
export function expandIngredient(name) {
  const n = normalizeName(name);
  for (const group of INGREDIENT_ALIAS_GROUPS) {
    if (group.some((g) => normalizeName(g) === n)) return group.map((g) => normalizeName(g));
  }
  return [n];
}

/** 菜谱的可食用原料条目（排除工具）。 */
function edibleIngredients(recipe) {
  return (recipe.ingredients || []).filter((i) => !isToolName(i.name));
}

/**
 * 计算「手头原料」对某菜谱的覆盖情况。
 * 匹配为双向包含（"葱"可命中"小葱"，"五花肉"可命中"五花肉片"）。
 * 返回 { coverage, hit_count, total, missing }。
 */
export function matchByIngredients(recipe, haveList) {
  const expanded = haveList.flatMap((w) => expandIngredient(w));
  const ingredients = edibleIngredients(recipe);
  let hits = 0;
  const missing = [];
  for (const ing of ingredients) {
    const n = normalizeName(ing.name);
    const matched = expanded.some((alias) => n.includes(alias) || alias.includes(n));
    if (matched) hits++;
    else missing.push(ing.name);
  }
  return {
    coverage: ingredients.length ? Math.round((hits / ingredients.length) * 1000) / 1000 : 0,
    hit_count: hits,
    total: ingredients.length,
    missing,
  };
}

/* ------------------------------------------------------------------ */
/* 相似菜谱                                                            */
/* ------------------------------------------------------------------ */

/**
 * 基于原料重合度（Jaccard）+ 同分类加权的相似菜谱推荐。
 * 返回 [{ recipe, score, shared_ingredients }]，已按分降序截取 limit 条。
 */
export function relatedRecipes(store, recipe, limit = 5) {
  const base = new Set(edibleIngredients(recipe).map((i) => normalizeName(i.name)));
  const scored = [];
  for (const c of store.listRecipes()) {
    if (c.id === recipe.id) continue;
    const names = edibleIngredients(c).map((i) => normalizeName(i.name));
    const set = new Set(names);
    let shared = 0;
    for (const n of base) if (set.has(n)) shared++;
    if (shared === 0 && c.category !== recipe.category) continue; // 完全无关的跳过
    const union = new Set([...base, ...names]).size;
    const jaccard = union ? shared / union : 0;
    const score = Math.round((jaccard * 2 + (c.category === recipe.category ? 1 : 0)) * 1000) / 1000;
    scored.push({ recipe: c, score, shared_ingredients: shared });
  }
  scored.sort((a, b) => b.score - a.score || a.recipe.path.localeCompare(b.recipe.path, 'zh-Hans-CN'));
  return scored.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 随机推荐（可复现 seed）                                                */
/* ------------------------------------------------------------------ */

/** FNV-1a 字符串哈希 → uint32，用于把 seed 参数转成随机源初值。 */
export function hashSeed(str) {
  let h = 2166136261;
  for (const c of String(str)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而快的确定性伪随机源。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 洗牌后取前 count 条（不改原数组）。 */
export function pickRandom(items, count, rng) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

/* ------------------------------------------------------------------ */
/* 全库统计                                                            */
/* ------------------------------------------------------------------ */

/** 全库统计：分类 / 难度 / 烹饪方式分布、最常用原料 Top N 等。 */
export function buildStats(store) {
  const recipes = store.listRecipes();
  const difficulty = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, unknown: 0 };
  const ingredientCount = new Map();
  const methodCount = new Map();
  let calSum = 0;
  let calCount = 0;
  let withTime = 0;

  for (const r of recipes) {
    difficulty[String(r.difficulty ?? 'unknown')] = (difficulty[String(r.difficulty ?? 'unknown')] || 0) + 1;
    for (const m of r.methods || []) methodCount.set(m, (methodCount.get(m) || 0) + 1);
    for (const ing of edibleIngredients(r)) {
      ingredientCount.set(ing.name, (ingredientCount.get(ing.name) || 0) + 1);
    }
    if (r.calories) {
      calSum += r.calories.value;
      calCount++;
    }
    if (r.timeEstimate) withTime++;
  }

  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
      .slice(0, n)
      .map(([name, count]) => ({ name, count }));

  return {
    recipes: recipes.length,
    tips: store.tips.size,
    categories: store.categories,
    difficulty,
    methods: top(methodCount, 12),
    top_ingredients: top(ingredientCount, 15),
    avg_calories: calCount ? Math.round((calSum / calCount) * 10) / 10 : null,
    recipes_with_time_estimate: withTime,
    index_built_at: store.builtAt,
  };
}
