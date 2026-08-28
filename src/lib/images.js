import path from 'node:path';
import { config } from '../config.js';

/* ------------------------------------------------------------------ */
/* URL 构造                                                            */
/* ------------------------------------------------------------------ */

export function encodeAssetPath(repoRelPosix) {
  return repoRelPosix.split('/').map(encodeURIComponent).join('/');
}

/**
 * 图片资源的三种地址形态。
 * - relative：文档中的原始相对引用（客户端需结合 recipe_dir 自行拼接）
 * - server：  本服务分发路径 /assets/<repo 相对路径>
 * - proxy：   ${ASSET_BASE_URL}/<repo 相对路径>（未配置反代时为 null）
 */
export function assetUrls(repoRelFile, originalTarget = null) {
  const encoded = encodeAssetPath(repoRelFile);
  return {
    relative: originalTarget || `./${path.posix.basename(repoRelFile)}`,
    server: `/assets/${encoded}`,
    proxy: config.assetBaseUrl ? `${config.assetBaseUrl}/${encoded}` : null,
  };
}

export function resolveAssetTarget(imageTarget, docDirPosix) {
  const joined = path.posix.normalize(path.posix.join(docDirPosix, imageTarget));
  return joined.replace(/^\.\//, '');
}

/* ------------------------------------------------------------------ */
/* 文档重写                                                            */
/* ------------------------------------------------------------------ */

const MD_IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi;
const EXTERNAL_RE = /^(https?:)?\/\//i;
const DATA_RE = /^data:/i;

function rewriteTarget(target, docDir, mode) {
  if (EXTERNAL_RE.test(target) || DATA_RE.test(target)) return target; // 外链原样保留
  const file = resolveAssetTarget(target, docDir);
  if (mode === 'relative') return target;
  const urls = assetUrls(file);
  if (mode === 'proxy') return urls.proxy || urls.server;
  return urls.server;
}

/**
 * 按图片模式重写 markdown 中的图片地址（markdown 与内嵌 <img> 两种写法都处理）。
 * mode: relative（原样）| server（/assets/...）| proxy（反代前缀）
 */
export function rewriteImageUrls(markdownText, docDirPosix, mode) {
  if (!markdownText) return markdownText;
  let text = markdownText.replace(MD_IMG_RE, (whole, alt, target, titlePart) => {
    const next = rewriteTarget(target, docDirPosix, mode);
    return `![${alt}](${next}${titlePart || ''})`;
  });
  text = text.replace(HTML_IMG_RE, (whole, pre, target, post) => {
    return `${pre}${rewriteTarget(target, docDirPosix, mode)}${post}`;
  });
  return text;
}

/* ------------------------------------------------------------------ */
/* 结构化图片清单                                                       */
/* ------------------------------------------------------------------ */

export function buildImageEntries(images, docDirPosix) {
  return (images || []).map((im) => {
    const file = im.external ? null : resolveAssetTarget(im.target, docDirPosix);
    const urls = file ? assetUrls(file, im.target) : null;
    return {
      alt: im.alt,
      external: im.external,
      target: im.target, // 文档中的原始引用
      file, // 仓库相对路径（外链为 null）
      urls, // { relative, server, proxy }
      section: im.section,
    };
  });
}

export function imageEntryUrl(entry, mode) {
  if (entry.external) return entry.target;
  if (mode === 'relative') return entry.urls.relative;
  if (mode === 'proxy') return entry.urls.proxy || entry.urls.server;
  return entry.urls.server;
}
