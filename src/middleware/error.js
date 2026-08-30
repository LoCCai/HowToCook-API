export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 错误响应一律禁止缓存：避免 CDN/浏览器把 404/400 缓存后，
// 在内容新增或参数修正后仍持续命中过期错误
function sendError(res, status, code, message) {
  res.set('Cache-Control', 'no-store');
  res.status(status).json({ error: { code, message } });
}

export function notFoundHandler(req, res) {
  sendError(res, 404, 'NOT_FOUND', `接口不存在：${req.method} ${req.path}`);
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  console.error('[api] 未处理错误:', err);
  sendError(res, 500, 'INTERNAL_ERROR', '服务内部错误');
}
