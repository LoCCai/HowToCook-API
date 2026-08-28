import { Router } from 'express';
import path from 'node:path';
import { HttpError } from '../middleware/error.js';
import { renderMarkdown } from '../lib/parser.js';
import { buildImageEntries, imageEntryUrl, rewriteImageUrls } from '../lib/images.js';
import { queryTips } from '../lib/search.js';
import { getStore, resolveImageMode, parsePagination, docDir } from './helpers.js';

const router = Router();

function summaryOf(tip) {
  return {
    id: tip.id,
    path: tip.path,
    title: tip.title,
    group: tip.group,
    updated_at: tip.updated_at,
  };
}

function fullOf(tip, imageMode) {
  const dir = docDir(tip.path);
  const markdown = rewriteImageUrls(tip.rawMarkdown, dir, imageMode);
  return {
    ...summaryOf(tip),
    description: tip.description,
    author: tip.author,
    contributors: tip.contributors,
    created_at: tip.created_at,
    sections: tip.sections.map((s) => ({
      heading: s.heading,
      level: s.level,
      markdown: s.markdown,
      html: renderMarkdown(rewriteImageUrls(s.markdown, dir, imageMode)),
    })),
    images: buildImageEntries(tip.images, dir).map((entry) => ({
      alt: entry.alt,
      external: entry.external,
      file: entry.file,
      target: entry.target,
      urls: entry.urls,
      url: imageEntryUrl(entry, imageMode),
      section: entry.section,
    })),
    content: { markdown, html: renderMarkdown(markdown) },
  };
}

function loadTip(req, res, next) {
  const store = getStore(req);
  const tip = store.findTip(req.params.id);
  if (!tip) {
    next(new HttpError(404, 'TIP_NOT_FOUND', `技巧文档不存在：${req.params.id}`));
    return;
  }
  res.locals.tip = tip;
  next();
}

// GET /api/tips —— 列表与搜索（q：标题/正文/拼音；group：learn | advanced）
router.get('/', (req, res, next) => {
  try {
    const store = getStore(req);
    const { page, pageSize } = parsePagination(req);
    const group = req.query.group ? String(req.query.group) : null;
    if (group && !['learn', 'advanced'].includes(group)) {
      throw new HttpError(400, 'INVALID_GROUP', 'group 必须是 learn 或 advanced');
    }
    const result = queryTips(store, {
      q: req.query.q ? String(req.query.q) : '',
      group,
      page,
      pageSize,
    });
    const items = result.items.map((t) => {
      const s = summaryOf(t);
      if (t._score != null) {
        s.score = t._score;
        s.matched = t._matched;
      }
      return s;
    });
    res.json({ data: items, meta: result.meta });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', loadTip, (req, res) => {
  const imageMode = resolveImageMode(req);
  res.json({ data: fullOf(res.locals.tip, imageMode), meta: { image_mode: imageMode } });
});

router.get('/:id/meta', loadTip, (req, res) => {
  const t = res.locals.tip;
  res.json({
    data: {
      id: t.id,
      path: t.path,
      title: t.title,
      group: t.group,
      description: t.description,
      author: t.author,
      contributors: t.contributors,
      created_at: t.created_at,
      updated_at: t.updated_at,
      counts: { sections: t.sections.length },
    },
  });
});

router.get('/:id/markdown', loadTip, (req, res) => {
  const imageMode = resolveImageMode(req);
  const t = res.locals.tip;
  res.type('text/markdown; charset=utf-8').send(rewriteImageUrls(t.rawMarkdown, docDir(t.path), imageMode));
});

router.get('/:id/html', loadTip, (req, res) => {
  const imageMode = resolveImageMode(req);
  const t = res.locals.tip;
  const html = renderMarkdown(rewriteImageUrls(t.rawMarkdown, docDir(t.path), imageMode));
  res.type('text/html; charset=utf-8').send(html);
});

router.get('/:id/raw', loadTip, (req, res, next) => {
  const store = getStore(req);
  const t = res.locals.tip;
  const abs = path.resolve(store.repoRoot, t.path);
  const rootWithSep = store.repoRoot.endsWith(path.sep) ? store.repoRoot : store.repoRoot + path.sep;
  if (abs !== store.repoRoot && !abs.startsWith(rootWithSep)) {
    next(new HttpError(403, 'FORBIDDEN', '路径越界'));
    return;
  }
  res.type('text/markdown; charset=utf-8').sendFile(abs, { dotfiles: 'deny', maxAge: 0 });
});

export default router;
