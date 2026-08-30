import { config } from '../config.js';

/**
 * 内存令牌桶限流（单实例）。
 * 默认关闭（RATE_LIMIT_MAX=0）；配置后按 IP 限流，/api/health 与 /assets 不受限。
 */
const buckets = new Map(); // ip -> { tokens, lastRefill, lastSeen }
let lastSweep = Date.now();
const SWEEP_INTERVAL = 10 * 60 * 1000;

export function rateLimit(req, res, next) {
  const max = config.rateLimitMax;
  if (!max) return next();
  const path = req.path;
  if (path === '/api/health' || path.startsWith('/assets')) return next();

  const now = Date.now();
  if (now - lastSweep > SWEEP_INTERVAL) {
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastSeen > SWEEP_INTERVAL) buckets.delete(key);
    }
  }

  const rate = max / config.rateLimitWindowMs; // tokens per ms
  const key = req.ip || 'unknown';
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: max, lastRefill: now, lastSeen: now };
    buckets.set(key, bucket);
  }
  bucket.tokens = Math.min(max, bucket.tokens + (now - bucket.lastRefill) * rate);
  bucket.lastRefill = now;
  bucket.lastSeen = now;

  res.set('X-RateLimit-Limit', String(max));
  if (bucket.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / rate / 1000));
    res.set('X-RateLimit-Remaining', '0');
    res.set('Retry-After', String(retryAfter));
    res.set('Cache-Control', 'no-store');
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: `请求过于频繁：每 ${Math.round(config.rateLimitWindowMs / 1000)} 秒最多 ${max} 次，请 ${retryAfter} 秒后重试`,
      },
    });
    return;
  }
  bucket.tokens -= 1;
  res.set('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));
  next();
}
