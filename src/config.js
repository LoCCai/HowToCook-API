import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_ROOT = path.resolve(here, '..');

/**
 * 内容根目录（含 dishes/ 与 tips/）解析优先级：
 * 1. CONTENT_DIR 环境变量显式指定的 HowToCook 目录
 * 2. 上一级目录（与 HowToCook 主仓库同仓开发）
 * 3. ./content（自动下载目标：启动时若缺内容会从官方仓库克隆到此处，见 lib/content-fetcher.js）
 */
function resolveRepoRoot() {
  if (process.env.CONTENT_DIR) return path.resolve(process.env.CONTENT_DIR);
  if (fs.existsSync(path.join(API_ROOT, '..', 'dishes'))) return path.resolve(API_ROOT, '..');
  return path.resolve(API_ROOT, 'content');
}
export const REPO_ROOT = resolveRepoRoot();

// 轻量 .env 加载，避免额外依赖；已存在的环境变量优先
function loadEnvFile() {
  const envPath = path.join(API_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvFile();

export const IMAGE_MODES = ['relative', 'server', 'proxy'];

const assetBaseUrl = (process.env.ASSET_BASE_URL || '').trim().replace(/\/+$/, '');
const defaultImageMode =
  process.env.DEFAULT_IMAGE_MODE || (assetBaseUrl ? 'proxy' : 'server');

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  assetBaseUrl: assetBaseUrl || null,
  defaultImageMode,
  watch: /^(1|true|yes)$/i.test(process.env.WATCH || ''),
  repoRoot: REPO_ROOT,
  // 每窗口每 IP 最大请求数；0 = 不限流（默认）
  rateLimitMax: Math.max(0, Number.parseInt(process.env.RATE_LIMIT_MAX, 10) || 0),
  rateLimitWindowMs: Math.max(1000, Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000),
  // 部署在反向代理之后时开启，使限流按 X-Forwarded-For 识别真实客户端 IP
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
};
