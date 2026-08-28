import { config, IMAGE_MODES } from '../config.js';
import { HttpError } from '../middleware/error.js';
import { CATEGORY_TITLES } from '../lib/scanner.js';

export function getStore(req) {
  return req.app.locals.store;
}

/** 解析并校验 image_mode 查询参数，缺省取全局配置。 */
export function resolveImageMode(req) {
  const mode = req.query.image_mode || config.defaultImageMode;
  if (!IMAGE_MODES.includes(mode)) {
    throw new HttpError(400, 'INVALID_IMAGE_MODE', `image_mode 必须是 ${IMAGE_MODES.join(' / ')}，收到：${mode}`);
  }
  if (mode === 'proxy' && !config.assetBaseUrl) {
    throw new HttpError(400, 'PROXY_NOT_CONFIGURED', '未配置 ASSET_BASE_URL，无法使用 proxy 模式');
  }
  return mode;
}

export function parsePagination(req, { defaultPageSize = 20, maxPageSize = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const rawSize = Number.parseInt(req.query.page_size, 10) || defaultPageSize;
  const pageSize = Math.min(Math.max(1, rawSize), maxPageSize);
  return { page, pageSize };
}

export function categoryTitle(categoryId) {
  return CATEGORY_TITLES[categoryId] || categoryId;
}

export function docDir(entryPath) {
  const parts = entryPath.split('/');
  parts.pop();
  return parts.join('/');
}

/** 按 fields=a,b,c 过滤对象顶层字段（id 与 path 始终保留）。 */
export function pickFields(obj, fieldsParam) {
  if (!fieldsParam) return obj;
  const wanted = String(fieldsParam)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return obj;
  const out = {};
  for (const key of new Set(['id', 'path', ...wanted])) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}
