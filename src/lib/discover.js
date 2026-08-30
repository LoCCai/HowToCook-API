import { isToolName } from './parser.js';

const normalizeName = (s) => String(s || '').toLowerCase().replace(/[\s\u3000]+/g, '');

/* ------------------------------------------------------------------ */
/* 原料规范名归一（统计用）                                                */
/* ------------------------------------------------------------------ */

/**
 * 归一映射组：patterns 按「具体的在前、泛化的在后」排列，双向包含匹配。
 * 例：「葱姜蒜」拆为 葱/姜/蒜 三项计数；「郫县豆瓣」并入 豆瓣酱；「橄榄油」并入 食用油。
 */
const CANONICAL_GROUPS = [
  { canonical: '蚝油', patterns: ['蚝油'] },
  { canonical: '香油', patterns: ['香油', '芝麻油', '麻油'] },
  { canonical: '洋葱', patterns: ['洋葱'] },
  { canonical: '食用油', patterns: ['食用油', '花生油', '玉米油', '菜籽油', '大豆油', '橄榄油', '调和油', '油'] },
  { canonical: '生抽', patterns: ['生抽'] },
  { canonical: '老抽', patterns: ['老抽'] },
  { canonical: '酱油', patterns: ['酱油', '味极鲜', '豉油'] },
  { canonical: '醋', patterns: ['醋', '米醋', '陈醋', '白醋', '香醋'] },
  { canonical: '料酒', patterns: ['料酒', '黄酒'] },
  { canonical: '糖', patterns: ['糖', '白糖', '白砂糖', '绵白糖', '砂糖', '冰糖'] },
  { canonical: '盐', patterns: ['盐', '食盐'] },
  { canonical: '胡椒粉', patterns: ['胡椒粉', '胡椒'] },
  { canonical: '淀粉', patterns: ['淀粉', '生粉', '水淀粉'] },
  { canonical: '辣椒', patterns: ['干辣椒', '小米辣', '辣椒'] },
  { canonical: '花椒', patterns: ['花椒', '麻椒'] },
  { canonical: '豆瓣酱', patterns: ['豆瓣酱', '郫县豆瓣', '豆瓣'] },
  { canonical: '西红柿', patterns: ['西红柿', '番茄'] },
  { canonical: '土豆', patterns: ['土豆', '马铃薯', '洋芋'] },
  { canonical: '香菜', patterns: ['香菜', '芫荽'] },
  { canonical: '葱', patterns: ['葱', '大葱', '小葱', '香葱', '葱花', '葱白'] },
  { canonical: '姜', patterns: ['姜', '姜片', '姜末', '姜丝', '姜块'] },
  { canonical: '蒜', patterns: ['蒜', '大蒜', '蒜末', '蒜瓣', '蒜片'] },
  { canonical: '鸡蛋', patterns: ['鸡蛋', '蛋液', '全蛋'] },
  { canonical: '面粉', patterns: ['面粉'] },
];

/**
 * 原料名 → 规范名列表（多数为单项；复合名如「葱姜蒜」拆为多项）。
 * 无法归一的保持原名返回。
 */
export function canonicalIngredients(name) {
  const n = normalizeName(name);
  if (n === '葱姜蒜') return ['葱', '姜', '蒜'];
  for (const group of CANONICAL_GROUPS) {
    for (const pattern of group.patterns) {
      const pn = normalizeName(pattern);
      if (n === pn || n.includes(pn) || pn.includes(n)) return [group.canonical];
    }
  }
  return [name];
}

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
      // 归一后计数：「葱姜蒜」拆为三项、「郫县豆瓣」并入「豆瓣酱」等
      for (const canonical of canonicalIngredients(ing.name)) {
        ingredientCount.set(canonical, (ingredientCount.get(canonical) || 0) + 1);
      }
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

/* ------------------------------------------------------------------ */
/* 忌口 / 过敏原标签（启发式判定，供过滤与展示）                              */
/* ------------------------------------------------------------------ */

const MEAT_WORDS = ['肉', '鸡', '鸭', '鹅', '牛', '羊', '猪', '鱼', '虾', '蟹', '贝', '蚝', '鳝', '鱿', '火腿', '腊', '蛋', '奶', '黄油', '芝士', '奶酪'];
const SPICY_WORDS = ['辣椒', '小米辣', '花椒', '麻椒', '藤椒', '胡椒', '辣'];
const SEAFOOD_WORDS = ['鱼', '虾', '蟹', '贝', '蚝', '鳝', '鱿', '海米', '虾米', '虾皮', '紫菜', '海带', '蛤', '蛏'];
const PEANUT_WORDS = ['花生'];
const EGG_WORDS = ['蛋'];
const DAIRY_WORDS = ['牛奶', '奶油', '黄油', '芝士', '奶酪', '炼乳', '酸奶', '奶'];
const GLUTEN_WORDS = ['面粉', '面条', '挂面', '面包', '意面', '方便面', '饺子皮', '馄饨皮', '馒头', '吐司', '油条', '饼皮'];

const nameContainsAny = (n, words) => words.some((w) => n.includes(w));

/**
 * 启发式计算菜谱标签（构建期执行一次）：
 * vegetarian=素食（原料不含任何肉/禽/水产/蛋/奶词）、spicy=含辣、
 * seafood=海鲜水产、peanut/egg/dairy/gluten=常见过敏原。
 */
export function computeDietTags(recipe) {
  const ingredients = (recipe.ingredients || []).filter((i) => !isToolName(i.name)).map((i) => normalizeName(i.name));
  const tags = [];
  if (ingredients.length > 0 && !ingredients.some((n) => nameContainsAny(n, MEAT_WORDS))) tags.push('vegetarian');
  if (ingredients.some((n) => nameContainsAny(n, SPICY_WORDS))) tags.push('spicy');
  if (recipe.category === 'aquatic' || ingredients.some((n) => nameContainsAny(n, SEAFOOD_WORDS))) tags.push('seafood');
  if (ingredients.some((n) => nameContainsAny(n, PEANUT_WORDS))) tags.push('peanut');
  if (ingredients.some((n) => nameContainsAny(n, EGG_WORDS))) tags.push('egg');
  if (ingredients.some((n) => nameContainsAny(n, DAIRY_WORDS))) tags.push('dairy');
  if (ingredients.some((n) => nameContainsAny(n, GLUTEN_WORDS))) tags.push('gluten');
  return tags;
}

/**
 * 按标签过滤菜谱数组：includeTags 全部命中才保留，excludeTags 命中任一即剔除。
 */
export function filterByTags(items, includeTags, excludeTags) {
  let out = items;
  if (includeTags && includeTags.length > 0) {
    out = out.filter((r) => includeTags.every((t) => (r.dietTags || []).includes(t)));
  }
  if (excludeTags && excludeTags.length > 0) {
    out = out.filter((r) => !excludeTags.some((t) => (r.dietTags || []).includes(t)));
  }
  return out;
}

const KNOWN_TAGS = ['vegetarian', 'spicy', 'seafood', 'peanut', 'egg', 'dairy', 'gluten'];

/** 索引重建 hook：为全部菜谱计算启发式标签（构建期一次）。 */
export function attachDietTags(store) {
  for (const r of store.recipes.values()) {
    r.dietTags = computeDietTags(r);
  }
}

/** 解析逗号分隔的标签参数为小写数组（未知标签忽略）。 */
export function parseTagParam(raw) {
  return String(raw || '')
    .split(/[,，]/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => KNOWN_TAGS.includes(t));
}

/* ------------------------------------------------------------------ */
/* 一周膳食计划（每日多槽位、周内不重样）                                   */
/* ------------------------------------------------------------------ */

/** 槽位 → 参与分类（荤池含水产；早餐/饮料/甜品为独立池）。 */
export const SLOT_CATEGORIES = {
  meat: ['meat_dish', 'aquatic'],
  vegetable: ['vegetable_dish'],
  soup: ['soup'],
  breakfast: ['breakfast'],
  drink: ['drink'],
  dessert: ['dessert'],
};

/** 解析按天槽数语法：`2`（每天相同）或 `1,2,1,2`（逐天，短则循环填充、长则截断）。 */
export function parseDailySlots(raw, defaultValue, days) {
  const clamp = (v) => Math.min(3, Math.max(0, Number.parseInt(v, 10) || 0));
  if (raw == null || raw === '') return Array.from({ length: days }, () => defaultValue);
  const parts = String(raw)
    .split(/[,，]/)
    .map((s) => clamp(s));
  if (parts.length === 1) return Array.from({ length: days }, () => parts[0]);
  return Array.from({ length: days }, (_, i) => parts[i % parts.length]);
}

/**
 * 生成 days 天的膳食计划：每个槽位维护自己的牌堆，抽过的不再出现，
 * 池耗尽时重新洗牌（repeats 标注允许重复）。
 * slots 形如 { meat: [1,2,1,...], breakfast: [0,1,...], ... }（按天数量）。
 * 返回 { days: [{ day, meat: [], breakfast: [], ... }], repeats, unfilled }。
 */
export function buildWeekPlan(store, { days = 7, slots = { meat: [1], vegetable: [1], soup: [1] }, rng, maxDifficulty = null, excludeTags = [] }) {
  const poolBy = (categories) =>
    filterByTags(
      store
        .listRecipes()
        .filter((r) => categories.includes(r.category) && (maxDifficulty == null || (r.difficulty != null && r.difficulty <= maxDifficulty))),
      null,
      excludeTags
    );
  const pools = {};
  const decks = {};
  for (const slot of Object.keys(slots)) {
    pools[slot] = poolBy(SLOT_CATEGORIES[slot] || []);
    decks[slot] = [];
  }
  let repeats = false;
  let unfilled = 0;
  const plan = [];
  for (let d = 1; d <= days; d++) {
    const day = { day: d };
    for (const slot of Object.keys(slots)) {
      day[slot] = [];
      for (let k = 0; k < slots[slot][d - 1]; k++) {
        if (decks[slot].length === 0) {
          if (pools[slot].length === 0) {
            unfilled++;
            break;
          }
          decks[slot] = pickRandom(pools[slot], pools[slot].length, rng);
          if (plan.length > 0) repeats = true;
        }
        day[slot].push(decks[slot].pop());
      }
    }
    plan.push(day);
  }
  return { days: plan, repeats, unfilled };
}

/* ------------------------------------------------------------------ */
/* 购物清单（多菜谱原料合并）                                              */
/* ------------------------------------------------------------------ */

const UNIT_NORMALIZE = { 克: 'g', 千克: 'kg', 公斤: 'kg', 毫克: 'mg', 毫升: 'ml', 升: 'l', 大卡: 'kcal' };

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字 → 阿拉伯（半=0.5、两=2、十~九十九）；无法解析返回 null。 */
function cnToInt(cn) {
  if (cn === '半') return 0.5;
  if (/^[一二两三四五六七八九]$/.test(cn)) return CN_DIGIT[cn];
  const m = cn.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) {
    return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  }
  return null;
}

const UNIT_CHARS = '克|千克|公斤|毫克|毫升|大卡|g|kg|mg|ml|mL|L|升|斤|两|个|只|条|根|片|瓣|张|滴|块|杯|罐|瓶|袋|把|勺|匙|撮|粒|颗|枚|份';

/** 解析数量字符串为 { value, unit }；区间取中值；中文数量词（两片/半根/八个）自动转换；不可解析返回 null。 */
export function parseAmount(quantityStr) {
  let s = String(quantityStr || '').trim();
  // 中文数量词预处理：'两片' → '2 片'、'半根' → '0.5 根'、'八个' → '8 个'
  const cn = s.match(new RegExp(`^([半一二两三四五六七八九十]+)\\s*(${UNIT_CHARS})$`, 'i'));
  if (cn) {
    const v = cnToInt(cn[1]);
    if (v != null) s = `${v} ${cn[2]}`;
  }
  const m = s.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:[-~—到至]\\s*(\\d+(?:\\.\\d+)?))?\\s*(${UNIT_CHARS})?\\s*$`, 'i'));
  if (!m) return null;
  const first = parseFloat(m[1]);
  const value = m[2] != null ? (first + parseFloat(m[2])) / 2 : first;
  if (Number.isNaN(value)) return null;
  let unit = (m[3] || '').toLowerCase();
  unit = UNIT_NORMALIZE[unit] || unit;
  return { value, unit };
}

/**
 * 合并多个菜谱的原料为购物清单：
 * - 以规范名归一聚合（番茄/西红柿合并），排除工具；
 * - 可解析数量按「同名同单位」相加；两类数量的缩放系数不同：
 *   静态量（2 人份基准）乘 staticFactor（servings/2），
 *   每份量（「1.5 个 * 份数」公式型）乘 perServingFactor（servings）；
 * - 不可解析数量（适量/若干）归入 unspecified 保留原文。
 */
export function buildShoppingList(store, recipeIds, { staticFactor = 1, perServingFactor = 1 } = {}) {
  const items = new Map(); // canonical -> entry
  const resolved = [];
  const notFound = [];
  for (const id of recipeIds) {
    const recipe = store.recipes.get(id);
    if (!recipe) {
      notFound.push(id);
      continue;
    }
    resolved.push({ id, title: recipe.title });
    for (const ing of (recipe.ingredients || []).filter((i) => !isToolName(i.name))) {
      const canonical = canonicalIngredients(ing.name)[0];
      if (!items.has(canonical)) {
        items.set(canonical, { name: canonical, display_names: new Set(), amounts: new Map(), unspecified: new Set(), recipes: new Set() });
      }
      const entry = items.get(canonical);
      entry.display_names.add(ing.name);
      entry.recipes.add(recipe.title);
      const factor = ing.per_serving ? perServingFactor : staticFactor;
      const amount = parseAmount(ing.quantity);
      if (amount) {
        const value = Math.round(amount.value * factor * 100) / 100;
        const bucket = entry.amounts.get(amount.unit) || { unit: amount.unit, value: 0, scaled: factor !== 1 };
        bucket.value = Math.round((bucket.value + value) * 100) / 100;
        entry.amounts.set(amount.unit, bucket);
      } else if (ing.quantity) {
        entry.unspecified.add(String(ing.quantity));
      }
    }
  }
  return {
    items: [...items.values()].map((e) => ({
      name: e.name,
      display_names: [...e.display_names],
      amounts: [...e.amounts.values()].map((a) => ({ unit: a.unit, value: a.value, scaled: a.scaled })),
      unspecified: [...e.unspecified],
      recipes: [...e.recipes],
    })),
    recipes: resolved,
    not_found: notFound,
  };
}

/* ------------------------------------------------------------------ */
/* 份数缩放                                                            */
/* ------------------------------------------------------------------ */

/** 从菜谱简介解析基准份数（如「一份正好够 2 个人吃」）；默认 2。 */
export function parseBaseServings(description) {
  const d = String(description || '');
  const m = d.match(/(?:一份|每份)[^。\d]*?(\d+)\s*个?人/) || d.match(/(\d+)\s*人\s*(?:份|吃|食用)/);
  const n = m ? Number.parseInt(m[1], 10) : NaN;
  return Number.isNaN(n) || n <= 0 ? 2 : Math.min(20, n);
}

/**
 * 缩放数量字符串：纯数字（含区间、单位）乘 factor；
 * 不可解析的（适量/两片）返回 null，由调用方保留原文并标注未缩放。
 */
export function scaleQuantity(quantityStr, factor) {
  const amount = parseAmount(quantityStr);
  if (!amount || factor === 1) return null;
  const fmt = (v) => Math.round(v * 100) / 100;
  const scaled = fmt(amount.value * factor);
  return amount.unit ? `${scaled} ${amount.unit}`.trim() : `${scaled}`;
}
