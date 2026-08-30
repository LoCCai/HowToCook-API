import { Router } from 'express';
import path from 'node:path';
import { HttpError } from '../middleware/error.js';
import { renderMarkdown } from '../lib/parser.js';
import { buildImageEntries, imageEntryUrl, rewriteImageUrls } from '../lib/images.js';
import { queryRecipes } from '../lib/search.js';
import { matchByIngredients, relatedRecipes, hashSeed, mulberry32, pickRandom } from '../lib/discover.js';
import { getStore, resolveImageMode, parsePagination, categoryTitle, docDir, pickFields } from './helpers.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* 响应构造                                                            */
/* ------------------------------------------------------------------ */

function coverOf(recipe, dir, imageMode) {
  if (!recipe.cover) return null;
  const [entry] = buildImageEntries([recipe.cover], dir);
  return {
    alt: entry.alt,
    url: imageEntryUrl(entry, imageMode),
    urls: entry.urls,
    section: entry.section,
  };
}

export function summaryOf(recipe, imageMode) {
  const dir = docDir(recipe.path);
  const item = {
    id: recipe.id,
    path: recipe.path,
    title: recipe.title,
    category: { id: recipe.category, title: categoryTitle(recipe.category) },
    difficulty: recipe.difficulty,
    difficulty_display: recipe.difficultyDisplay,
    calories: recipe.calories,
    time_estimate: recipe.timeEstimate,
    methods: recipe.methods,
    author: recipe.author ? recipe.author.name : null,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
    recipe_dir: dir,
    cover: coverOf(recipe, dir, imageMode),
  };
  if (recipe._score != null) {
    item.score = recipe._score;
    item.matched = recipe._matched;
  }
  return item;
}

function fullOf(recipe, imageMode) {
  const dir = docDir(recipe.path);
  const images = buildImageEntries(recipe.images, dir).map((entry) => ({
    alt: entry.alt,
    external: entry.external,
    file: entry.file,
    target: entry.target,
    urls: entry.urls,
    url: imageEntryUrl(entry, imageMode),
    section: entry.section,
  }));
  const markdown = rewriteImageUrls(recipe.rawMarkdown, dir, imageMode);
  const html = renderMarkdown(markdown);
  return {
    ...summaryOf(recipe, imageMode),
    description: recipe.description,
    contributors: recipe.contributors,
    ingredients: recipe.ingredients,
    tools: recipe.tools,
    steps: recipe.steps,
    notes: recipe.notes,
    feedback_note: recipe.feedbackNote,
    sections: recipe.sections.map((s) => ({
      heading: s.heading,
      markdown: s.markdown,
      html: renderMarkdown(rewriteImageUrls(s.markdown, dir, imageMode)),
    })),
    images,
    content: { markdown, html },
  };
}

/* ------------------------------------------------------------------ */
/* 中间件                                                              */
/* ------------------------------------------------------------------ */

function loadRecipe(req, res, next) {
  const store = getStore(req);
  const recipe = store.findRecipe(req.params.id);
  if (!recipe) {
    next(new HttpError(404, 'RECIPE_NOT_FOUND', `菜谱不存在：${req.params.id}（可用 GET /api/recipes 查询 id/path）`));
    return;
  }
  res.locals.recipe = recipe;
  next();
}

/* ------------------------------------------------------------------ */
/* 列表 / 搜索                                                         */
/* ------------------------------------------------------------------ */

// GET /api/recipes
router.get('/', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    const { page, pageSize } = parsePagination(req);

    const filters = {};
    if (req.query.category) {
      filters.category = String(req.query.category);
      if (!store.recipes.size || !categoryTitle(filters.category) || !store.categories.some((c) => c.id === filters.category)) {
        throw new HttpError(400, 'INVALID_CATEGORY', `未知分类：${filters.category}，见 GET /api/categories`);
      }
    }
    const difficulty = Number.parseInt(req.query.difficulty, 10);
    if (req.query.difficulty != null && (Number.isNaN(difficulty) || difficulty < 1 || difficulty > 5)) {
      throw new HttpError(400, 'INVALID_DIFFICULTY', 'difficulty 必须是 1-5');
    }
    const maxDifficulty = Number.parseInt(req.query.max_difficulty, 10);
    if (req.query.max_difficulty != null && (Number.isNaN(maxDifficulty) || maxDifficulty < 1 || maxDifficulty > 5)) {
      throw new HttpError(400, 'INVALID_DIFFICULTY', 'max_difficulty 必须是 1-5');
    }

    const result = queryRecipes(store, {
      q: req.query.q ? String(req.query.q) : '',
      category: filters.category || null,
      difficulty: Number.isNaN(difficulty) ? null : difficulty,
      maxDifficulty: Number.isNaN(maxDifficulty) ? null : maxDifficulty,
      ingredient: req.query.ingredient ? String(req.query.ingredient) : null,
      sort: req.query.sort ? String(req.query.sort) : null,
      page,
      pageSize,
    });

    const items = result.items.map((r) => pickFields(summaryOf(r, imageMode), req.query.fields));
    res.json({ data: items, meta: { ...result.meta, image_mode: imageMode } });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 随机推荐 / 按原料找菜（须注册在 /:id 之前）                              */
/* ------------------------------------------------------------------ */

// GET /api/recipes/random?count=1&seed=xxx&category=&difficulty=
router.get('/random', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    let items = store.listRecipes();
    if (req.query.category) {
      const category = String(req.query.category);
      if (!store.categories.some((c) => c.id === category)) {
        throw new HttpError(400, 'INVALID_CATEGORY', `未知分类：${category}，见 GET /api/categories`);
      }
      items = items.filter((r) => r.category === category);
    }
    const difficulty = Number.parseInt(req.query.difficulty, 10);
    if (req.query.difficulty != null && (Number.isNaN(difficulty) || difficulty < 1 || difficulty > 5)) {
      // 与列表接口一致：提供了非法难度直接 400，而非静默忽略
      throw new HttpError(400, 'INVALID_DIFFICULTY', 'difficulty 必须是 1-5');
    }
    if (req.query.difficulty != null) {
      items = items.filter((r) => r.difficulty === difficulty);
    }
    if (items.length === 0) {
      throw new HttpError(404, 'NO_MATCHING_RECIPES', '过滤条件下没有可选菜谱');
    }
    const count = Math.min(Math.max(1, Number.parseInt(req.query.count, 10) || 1), 20);
    const seed = req.query.seed ? String(req.query.seed) : Date.now().toString(36);
    const picks = pickRandom(items, count, mulberry32(hashSeed(seed)));
    res.json({
      data: picks.map((r) => summaryOf(r, imageMode)),
      meta: { count: picks.length, seed, total_available: items.length, image_mode: imageMode },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/recipes/by-ingredients?have=鸡蛋,西红柿&mode=loose&limit=20
router.get('/by-ingredients', (req, res, next) => {
  try {
    const store = getStore(req);
    const imageMode = resolveImageMode(req);
    const have = String(req.query.have || '')
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (have.length === 0) {
      throw new HttpError(400, 'MISSING_HAVE', '缺少 have 参数（逗号分隔的手头原料，如 have=鸡蛋,西红柿）');
    }
    const mode = req.query.mode || 'loose';
    if (!['loose', 'strict'].includes(mode)) {
      throw new HttpError(400, 'INVALID_MODE', 'mode 必须是 loose（按覆盖率排序）或 strict（原料齐全才返回）');
    }
    const limit = Math.min(Math.max(1, Number.parseInt(req.query.limit, 10) || 20), 50);

    let matched = [];
    for (const r of store.listRecipes()) {
      const match = matchByIngredients(r, have);
      if (mode === 'strict' && match.missing.length > 0) continue;
      if (match.hit_count === 0) continue;
      matched.push({ recipe: r, match });
    }
    matched.sort(
      (a, b) =>
        b.match.coverage - a.match.coverage ||
        a.match.total - b.match.total ||
        a.recipe.path.localeCompare(b.recipe.path, 'zh-Hans-CN')
    );
    matched = matched.slice(0, limit);
    res.json({
      data: matched.map(({ recipe, match }) => ({
        ...summaryOf(recipe, imageMode),
        ingredients_match: match,
      })),
      meta: { have, mode, matched: matched.length, total_recipes: store.recipes.size, image_mode: imageMode },
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* 单个菜谱                                                            */
/* ------------------------------------------------------------------ */

// 完整结构化数据
router.get('/:id', loadRecipe, (req, res) => {
  const imageMode = resolveImageMode(req);
  res.json({ data: fullOf(res.locals.recipe, imageMode), meta: { image_mode: imageMode } });
});

// 元信息
router.get('/:id/meta', loadRecipe, (req, res) => {
  const imageMode = resolveImageMode(req);
  const r = res.locals.recipe;
  const dir = docDir(r.path);
  res.json({
    data: {
      id: r.id,
      path: r.path,
      title: r.title,
      category: { id: r.category, title: categoryTitle(r.category) },
      difficulty: r.difficulty,
      difficulty_display: r.difficultyDisplay,
      calories: r.calories,
      time_estimate: r.timeEstimate,
      methods: r.methods,
      description: r.description,
      author: r.author,
      contributors: r.contributors,
      created_at: r.created_at,
      updated_at: r.updated_at,
      recipe_dir: dir,
      cover: coverOf(r, dir, imageMode),
      counts: {
        ingredients: r.ingredients.length,
        tools: r.tools.length,
        steps: r.steps.length,
        images: r.images.length,
      },
    },
    meta: { image_mode: imageMode },
  });
});

// 原料（含数量）
router.get('/:id/ingredients', loadRecipe, (req, res) => {
  const r = res.locals.recipe;
  res.json({
    data: r.ingredients,
    meta: { id: r.id, title: r.title, total: r.ingredients.length },
  });
});

// 工具
router.get('/:id/tools', loadRecipe, (req, res) => {
  const r = res.locals.recipe;
  res.json({ data: r.tools, meta: { id: r.id, title: r.title, total: r.tools.length } });
});

// 步骤（含 H3 分组）
router.get('/:id/steps', loadRecipe, (req, res) => {
  const r = res.locals.recipe;
  const groups = [];
  for (const step of r.steps) {
    const g = step.group || null;
    let bucket = groups.find((x) => x.group === g);
    if (!bucket) {
      bucket = { group: g, steps: [] };
      groups.push(bucket);
    }
    bucket.steps.push(step);
  }
  res.json({ data: { flat: r.steps, grouped: groups }, meta: { id: r.id, title: r.title, total: r.steps.length } });
});

// 原始段落
router.get('/:id/sections', loadRecipe, (req, res) => {
  const imageMode = resolveImageMode(req);
  const r = res.locals.recipe;
  const dir = docDir(r.path);
  res.json({
    data: r.sections.map((s) => ({
      heading: s.heading,
      markdown: s.markdown,
      html: renderMarkdown(rewriteImageUrls(s.markdown, dir, imageMode)),
    })),
    meta: { id: r.id, title: r.title },
  });
});

// 附加内容
router.get('/:id/notes', loadRecipe, (req, res) => {
  const r = res.locals.recipe;
  res.json({
    data: { notes: r.notes, feedback_note: r.feedbackNote },
    meta: { id: r.id, title: r.title },
  });
});

// 图片清单
router.get('/:id/images', loadRecipe, (req, res) => {
  const imageMode = resolveImageMode(req);
  const r = res.locals.recipe;
  const dir = docDir(r.path);
  const images = buildImageEntries(r.images, dir).map((entry) => ({
    alt: entry.alt,
    external: entry.external,
    file: entry.file,
    target: entry.target,
    urls: entry.urls,
    url: imageEntryUrl(entry, imageMode),
    section: entry.section,
  }));
  res.json({
    data: images,
    meta: { id: r.id, title: r.title, recipe_dir: dir, image_mode: imageMode, total: images.length },
  });
});

// 完整 Markdown（图片地址按 image_mode 重写）
router.get('/:id/markdown', loadRecipe, (req, res) => {
  const imageMode = resolveImageMode(req);
  const r = res.locals.recipe;
  const dir = docDir(r.path);
  res.type('text/markdown; charset=utf-8').send(rewriteImageUrls(r.rawMarkdown, dir, imageMode));
});

// 正文 HTML 片段（无 html/head/body 包裹）
router.get('/:id/html', loadRecipe, (req, res) => {
  const imageMode = resolveImageMode(req);
  const r = res.locals.recipe;
  const dir = docDir(r.path);
  const html = renderMarkdown(rewriteImageUrls(r.rawMarkdown, dir, imageMode));
  res.type('text/html; charset=utf-8').send(html);
});

// 相似菜谱（原料重合度 + 同分类加权）
router.get('/:id/related', loadRecipe, (req, res) => {
  const imageMode = resolveImageMode(req);
  const r = res.locals.recipe;
  const limit = Math.min(Math.max(1, Number.parseInt(req.query.limit, 10) || 5), 20);
  const related = relatedRecipes(getStore(req), r, limit);
  res.json({
    data: related.map(({ recipe, score, shared_ingredients }) => ({
      ...summaryOf(recipe, imageMode),
      score,
      shared_ingredients,
    })),
    meta: { id: r.id, title: r.title, limit, image_mode: imageMode },
  });
});

// 原始文件
router.get('/:id/raw', loadRecipe, (req, res, next) => {  const store = getStore(req);
  const r = res.locals.recipe;
  const abs = path.resolve(store.repoRoot, r.path);
  const rootWithSep = store.repoRoot.endsWith(path.sep) ? store.repoRoot : store.repoRoot + path.sep;
  if (abs !== store.repoRoot && !abs.startsWith(rootWithSep)) {
    next(new HttpError(403, 'FORBIDDEN', '路径越界'));
    return;
  }
  res.type('text/markdown; charset=utf-8').sendFile(abs, { dotfiles: 'deny', maxAge: 0 });
});

export default router;
