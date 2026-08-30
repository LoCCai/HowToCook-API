import { pinyin } from 'pinyin-pro';
import { filterByTags, parseTagParam } from './discover.js';

/**
 * 归一化查询与文本：小写、去空白。中英文混排均可匹配。
 */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s\u3000]+/g, '');
}

function pinyinFull(text) {
  return pinyin(text, { toneType: 'none', type: 'string', v: true }).replace(/[\s\u3000-]+/g, '');
}

function pinyinInitials(text) {
  return pinyin(text, { pattern: 'first', toneType: 'none', type: 'string' }).replace(/[\s\u3000-]+/g, '');
}

/* ------------------------------------------------------------------ */
/* 索引构建                                                            */
/* ------------------------------------------------------------------ */

/**
 * 为每个菜谱构建搜索记录，挂在 store.searchRecords（Map<id, record>）。
 * 在 Store.rebuild 的 hook 中调用。
 */
export function buildRecipeSearchIndex(store) {
  const records = new Map();
  for (const r of store.recipes.values()) {
    const plainText = normalize(
      [r.title, r.description, ...(r.sections || []).map((s) => `${s.heading}\n${s.markdown}`)].join('\n')
    );
    records.set(r.id, {
      id: r.id,
      title: r.title,
      titleNorm: normalize(r.title),
      titlePinyin: pinyinFull(r.title),
      titleInitials: pinyinInitials(r.title),
      ingredientsNorm: normalize((r.ingredients || []).map((i) => i.name).join(' ')),
      plainText,
      updatedAt: r.updated_at,
      difficulty: r.difficulty,
    });
  }
  store.searchRecords = records;
}

export function buildTipSearchIndex(store) {
  const records = new Map();
  for (const t of store.tips.values()) {
    records.set(t.id, {
      id: t.id,
      title: t.title,
      titleNorm: normalize(t.title),
      titlePinyin: pinyinFull(t.title),
      titleInitials: pinyinInitials(t.title),
      plainText: normalize(
        [t.title, t.description, ...(t.sections || []).map((s) => `${s.heading}\n${s.markdown}`)].join('\n')
      ),
    });
  }
  store.tipSearchRecords = records;
}

/* ------------------------------------------------------------------ */
/* 打分                                                                */
/* ------------------------------------------------------------------ */

/**
 * 返回 { score, matched }；score 越大越相关，0 表示不匹配。
 * 匹配优先级：标题精确 > 标题子串 > 拼音全拼/首字母 > 原料 > 分类 > 简介 > 正文。
 */
export function scoreRecord(record, qNorm, categoryTitle) {
  let score = 0;
  const matched = [];

  if (record.titleNorm === qNorm) {
    score = 1000;
    matched.push('title');
  } else if (record.titleNorm.includes(qNorm)) {
    score = 800;
    matched.push('title');
  } else if (record.titlePinyin === qNorm) {
    score = 750;
    matched.push('title_pinyin');
  } else if (record.titlePinyin.includes(qNorm)) {
    score = 700;
    matched.push('title_pinyin');
  } else if (record.titleInitials === qNorm) {
    score = 690;
    matched.push('title_initials');
  } else if (record.titleInitials.includes(qNorm)) {
    score = 650;
    matched.push('title_initials');
  }

  if (record.ingredientsNorm && record.ingredientsNorm.includes(qNorm)) {
    score = Math.max(score, 500);
    matched.push('ingredients');
  }
  if (categoryTitle && normalize(categoryTitle).includes(qNorm)) {
    score = Math.max(score, 400);
    matched.push('category');
  }
  if (record.plainText.includes(qNorm)) {
    score = Math.max(score, 200);
    matched.push('content');
  }
  return { score, matched };
}

/* ------------------------------------------------------------------ */
/* 查询入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 菜谱搜索 / 过滤 / 排序 / 分页。
 * options: { q, category, difficulty, maxDifficulty, ingredient, sort, page, pageSize, tag, excludeTags }
 */
export function queryRecipes(store, options = {}) {
  const {
    q = '',
    category = null,
    difficulty = null,
    maxDifficulty = null,
    ingredient = null,
    sort = null,
    page = 1,
    pageSize = 20,
    tag = null,
    excludeTags = null,
  } = options;

  let items = store.listRecipes();

  if (category) items = items.filter((r) => r.category === category);
  if (difficulty != null) items = items.filter((r) => r.difficulty === difficulty);
  if (maxDifficulty != null) items = items.filter((r) => r.difficulty != null && r.difficulty <= maxDifficulty);
  if (ingredient) {
    const ing = normalize(ingredient);
    items = items.filter((r) => (r.ingredients || []).some((i) => normalize(i.name).includes(ing)));
  }
  // 忌口 / 过敏原标签过滤（tag=vegetarian & exclude_tags=spicy,seafood）
  if (tag || excludeTags) {
    items = filterByTags(items, tag ? parseTagParam(tag) : null, excludeTags ? parseTagParam(excludeTags) : null);
  }

  let queryMeta = null;
  if (q) {
    const qNorm = normalize(q);
    const categoryTitles = new Map(store.categories.map((c) => [c.id, c.title]));
    const scored = [];
    for (const r of items) {
      const record = store.searchRecords?.get(r.id);
      if (!record) continue;
      const { score, matched } = scoreRecord(record, qNorm, categoryTitles.get(r.category));
      if (score > 0) scored.push({ recipe: r, score, matched });
    }
    scored.sort((a, b) => b.score - a.score || a.recipe.path.localeCompare(b.recipe.path, 'zh-Hans-CN'));
    items = scored.map((s) => ({ ...s.recipe, _score: s.score, _matched: s.matched }));
    queryMeta = { q, results: scored.length };
  } else if (sort) {
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    const allowed = ['title', 'path', 'difficulty', 'updated_at', 'created_at'];
    if (allowed.includes(key)) {
      items = [...items].sort((a, b) => {
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv), 'zh-Hans-CN');
        return desc ? -cmp : cmp;
      });
    }
  }

  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const slice = items.slice((safePage - 1) * pageSize, safePage * pageSize);

  return {
    items: slice,
    meta: {
      total,
      page: safePage,
      page_size: pageSize,
      pages,
      ...(queryMeta || {}),
    },
  };
}

/** 技巧文档搜索。 */
export function queryTips(store, options = {}) {
  const { q = '', group = null, page = 1, pageSize = 20 } = options;
  let items = store.listTips();
  if (group) items = items.filter((t) => t.group === group);

  let queryMeta = null;
  if (q) {
    const qNorm = normalize(q);
    const scored = [];
    for (const t of items) {
      const record = store.tipSearchRecords?.get(t.id);
      if (!record) continue;
      const { score, matched } = scoreRecord(record, qNorm);
      if (score > 0) scored.push({ tip: t, score, matched });
    }
    scored.sort((a, b) => b.score - a.score || a.tip.path.localeCompare(b.tip.path, 'zh-Hans-CN'));
    items = scored.map((s) => ({ ...s.tip, _score: s.score, _matched: s.matched }));
    queryMeta = { q, results: scored.length };
  }

  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((safePage - 1) * pageSize, safePage * pageSize),
    meta: { total, page: safePage, page_size: pageSize, pages, ...(queryMeta || {}) },
  };
}
