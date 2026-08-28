import path from 'node:path';
import { statSync } from 'node:fs';
import { HttpError } from '../middleware/error.js';

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

/**
 * /assets/<仓库相对路径> —— 图片等静态资源分发。
 * 只读本地文件；路径必须解析后落在仓库根内，且扩展名在白名单中。
 * 挂载方式：app.use('/assets', assetsHandler)
 */
export function assetsHandler(repoRoot) {
  return (req, res, next) => {
    try {
      const relEncoded = req.path.replace(/^\/+/, '');
      if (!relEncoded || relEncoded.includes('\0')) {
        throw new HttpError(404, 'ASSET_NOT_FOUND', '资源不存在');
      }
      let rel;
      try {
        rel = decodeURIComponent(relEncoded);
      } catch {
        throw new HttpError(400, 'BAD_REQUEST', '路径编码非法');
      }
      if (/(^|\/)\.\.?(\/|$)/.test(rel)) {
        throw new HttpError(403, 'FORBIDDEN', '路径不允许');
      }
      const ext = path.posix.extname(rel).toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) {
        throw new HttpError(404, 'ASSET_NOT_FOUND', `不支持的资源类型：${ext || '(无扩展名)'}`);
      }
      const abs = path.resolve(repoRoot, rel);
      const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
      if (abs !== repoRoot && !abs.startsWith(rootWithSep)) {
        throw new HttpError(403, 'FORBIDDEN', '路径不允许');
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        throw new HttpError(404, 'ASSET_NOT_FOUND', '资源不存在');
      }
      if (!st.isFile()) {
        throw new HttpError(404, 'ASSET_NOT_FOUND', '资源不存在');
      }
      res.set('Cache-Control', 'public, max-age=86400');
      res.sendFile(abs, { dotfiles: 'deny', acceptRanges: true, lastModified: true });
    } catch (err) {
      next(err);
    }
  };
}
