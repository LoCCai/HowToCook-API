import { readdir, readFile } from 'node:fs/promises';
import { statSync as fsStat } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { toPosix, makeId } from './ids.js';
import { parseRecipe, parseDocument } from './parser.js';

export const CATEGORY_TITLES = {
  vegetable_dish: '素菜',
  meat_dish: '荤菜',
  aquatic: '水产',
  breakfast: '早餐',
  staple: '主食',
  'semi-finished': '半成品加工',
  soup: '汤与粥',
  drink: '饮料',
  condiment: '酱料和其它材料',
  dessert: '甜品',
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_TITLES);

const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '.mimosa']);
const RECIPE_DIR = 'dishes';
const TIPS_DIR = 'tips';
// 模板目录不对外暴露
const EXCLUDE_RE = /^dishes\/template\//;

const BOT_AUTHOR_RE = /(\[bot\]|github-actions)/i;

/**
 * 把仓库相对路径解析为绝对路径，并强制校验结果仍在仓库根内。
 * 所有对本地文件的读取都必须经过这里，杜绝目录穿越。
 */
function safeResolve(repoRoot, relPosix) {
  const cleaned = relPosix.replace(/\0/g, '');
  const abs = path.resolve(repoRoot, cleaned);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (abs !== repoRoot && !abs.startsWith(rootWithSep)) {
    throw new Error(`路径越界: ${relPosix}`);
  }
  return abs;
}

/* ------------------------------------------------------------------ */
/* 目录遍历（路径全部由 readdir 产生，不接收外部输入）                      */
/* ------------------------------------------------------------------ */

async function walkMarkdown(rootAbs, relDir, out) {
  let entries;
  try {
    entries = await readdir(path.join(rootAbs, relDir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkMarkdown(rootAbs, rel, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* git 元数据                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一次 git log 提取所有文件的首次/末次提交信息。
 * 返回 Map<relPosixPath, {author, created_at, updated_at, contributors:[]}>。
 * 限制：不追踪重命名（重命名会被视作新文件）；git 不可用时返回空 Map。
 */
export function gitFileHistory(repoRoot) {
  const res = spawnSync(
    'git',
    [
      '-c', 'core.quotepath=false',
      'log', '--reverse', '--name-only', '--no-renames',
      '--format=__HTC__%x1f%an%x1f%ae%x1f%aI',
      '--', RECIPE_DIR, TIPS_DIR,
    ],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true }
  );
  if (res.status !== 0 || !res.stdout) return new Map();

  const map = new Map();
  let commitMeta = null; // [name, email, date]
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('__HTC__')) {
      // 格式为 "__HTC__\x1f作者\x1f邮箱\x1f日期"，去掉前缀后首段为空，取末 3 段
      const parts = line.slice(7).split('\x1f');
      commitMeta = parts.length >= 3 ? parts.slice(-3) : null;
      continue;
    }
    if (!commitMeta) continue;
    const file = toPosix(line);
    if (!file.startsWith(`${RECIPE_DIR}/`) && !file.startsWith(`${TIPS_DIR}/`)) continue;
    if (!file.endsWith('.md')) continue;
    const [name, email, date] = commitMeta;
    const isBot = BOT_AUTHOR_RE.test(name) || BOT_AUTHOR_RE.test(email);
    let e = map.get(file);
    if (!e) {
      e = { author: null, created_at: null, updated_at: null, contributors: [] };
      map.set(file, e);
    }
    if (!e.created_at) {
      e.created_at = date;
      if (!isBot) e.author = { name, email };
    }
    e.updated_at = date;
    if (!isBot && !e.contributors.some((c) => c.name === name)) {
      e.contributors.push({ name, email });
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 索引存储                                                            */
/* ------------------------------------------------------------------ */

export class Store {
  constructor(repoRoot) {
    this.repoRoot = path.resolve(repoRoot);
    this.recipes = new Map(); // id -> entry
    this.tips = new Map(); // id -> entry
    this.byPath = new Map(); // relPosixPath -> id
    this.categories = [];
    this.builtAt = null;
    this.gitAvailable = false;
  }

  /** 全量重建索引；rebuildHooks 在解析完成后调用（用于重建搜索索引等）。 */
  async rebuild(rebuildHooks = []) {
    const started = Date.now();
    const [recipePaths, tipPaths] = await Promise.all([
      walkMarkdown(this.repoRoot, RECIPE_DIR, []),
      walkMarkdown(this.repoRoot, TIPS_DIR, []),
    ]);

    const history = gitFileHistory(this.repoRoot);
    this.gitAvailable = history.size > 0;

    // 先在本地构建，完成后原子替换，避免重建窗口期读到半成品索引
    const nextRecipes = new Map();
    const nextTips = new Map();
    const nextByPath = new Map();

    const attachMeta = (entry, rel) => {
      const git = history.get(rel);
      let createdFallback = null;
      let updatedFallback = null;
      try {
        const s = fsStat(safeResolve(this.repoRoot, rel));
        createdFallback = s.birthtime.toISOString();
        updatedFallback = s.mtime.toISOString();
      } catch {
        /* 无 git 且 stat 失败时置空 */
      }
      entry.author = git?.author || null;
      entry.created_at = git?.created_at || createdFallback;
      entry.updated_at = git?.updated_at || updatedFallback;
      entry.contributors = git?.contributors || [];
    };

    for (const rel of recipePaths) {
      if (EXCLUDE_RE.test(rel)) continue;
      try {
        const raw = await readFile(safeResolve(this.repoRoot, rel), 'utf8');
        const parsed = parseRecipe(raw, rel);
        const id = makeId(rel);
        const entry = {
          id,
          path: rel,
          category: rel.split('/')[1] || 'unknown',
          rawMarkdown: raw,
          ...parsed,
        };
        attachMeta(entry, rel);
        nextRecipes.set(id, entry);
        nextByPath.set(rel, id);
      } catch (err) {
        console.warn(`[scanner] 解析失败 ${rel}: ${err.message}`);
      }
    }

    for (const rel of tipPaths) {
      try {
        const raw = await readFile(safeResolve(this.repoRoot, rel), 'utf8');
        const parsed = parseDocument(raw, rel);
        const id = makeId(rel);
        const entry = {
          id,
          path: rel,
          group: rel.startsWith(`${TIPS_DIR}/learn/`) ? 'learn' : 'advanced',
          rawMarkdown: raw,
          ...parsed,
        };
        attachMeta(entry, rel);
        nextTips.set(id, entry);
        nextByPath.set(rel, id);
      } catch (err) {
        console.warn(`[scanner] 解析失败 ${rel}: ${err.message}`);
      }
    }

    this.recipes = nextRecipes;
    this.tips = nextTips;
    this.byPath = nextByPath;

    this.categories = CATEGORY_ORDER.map((cid) => ({
      id: cid,
      title: CATEGORY_TITLES[cid],
      count: [...this.recipes.values()].filter((r) => r.category === cid).length,
    })).filter((c) => c.count > 0);

    this.builtAt = new Date().toISOString();
    for (const hook of rebuildHooks) hook(this);
    console.warn(
      `[scanner] 索引构建完成：${this.recipes.size} 个菜谱，${this.tips.size} 篇技巧，` +
        `git 元数据 ${this.gitAvailable ? '可用' : '不可用（回退文件时间）'}，耗时 ${Date.now() - started}ms`
    );
  }

  findRecipe(idOrKey) {
    if (this.recipes.has(idOrKey)) return this.recipes.get(idOrKey);
    const norm = toPosix(idOrKey).replace(/^\/+/, '');
    const id = this.byPath.get(norm) || this.byPath.get(`${RECIPE_DIR}/${norm}`);
    return id ? this.recipes.get(id) : undefined;
  }

  findTip(idOrKey) {
    if (this.tips.has(idOrKey)) return this.tips.get(idOrKey);
    const norm = toPosix(idOrKey).replace(/^\/+/, '');
    const id = this.byPath.get(norm) || this.byPath.get(`${TIPS_DIR}/${norm}`);
    return id ? this.tips.get(id) : undefined;
  }

  listRecipes() {
    return [...this.recipes.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
  }

  listTips() {
    return [...this.tips.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
  }
}
