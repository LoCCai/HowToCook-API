export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
}

// 只读 API + 一个受令牌保护的更新动作：允许任意来源的 GET/HEAD/OPTIONS/POST
export function cors(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST',
    'Access-Control-Allow-Headers': 'Content-Type, X-Update-Token',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
