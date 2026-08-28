import { createHash } from 'node:crypto';

export function toPosix(p) {
  return p.split('\\').join('/');
}

/**
 * 稳定 ID：仓库相对 posix 路径的 sha256 前 10 位。
 * 增删其它文件不会导致既有菜谱 ID 漂移。
 */
export function makeId(relPosixPath) {
  return createHash('sha256').update(relPosixPath).digest('hex').slice(0, 10);
}

export function normalizePosix(p) {
  return toPosix(p).replace(/^\.\/+/, '').replace(/\/+/g, '/');
}
