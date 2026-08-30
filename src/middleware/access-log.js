// 轻量访问日志：方法、路径、状态码、耗时
// 静态资源与探活请求（Docker healthcheck 每 30s 一次）不打日志
export function accessLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/assets') || req.path === '/api/health') return;
    console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}
