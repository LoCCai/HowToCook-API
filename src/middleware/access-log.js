// 轻量访问日志：方法、路径、状态码、耗时；静态资源不打日志
export function accessLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/assets')) return;
    console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}
