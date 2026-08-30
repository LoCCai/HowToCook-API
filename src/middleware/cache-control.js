/**
 * 分级缓存策略（内容由内存索引构建，变化频率低，允许 CDN/浏览器短缓存）：
 * - no-store：探活与随机结果（每次需新鲜值）
 * - max-age=60：列表 / 搜索 / 统计类
 * - max-age=300：详情 / 全文文档类（默认）
 * /assets 静态资源已有独立的 max-age=86400，不经过本中间件匹配。
 */
const NO_STORE = [
  /^\/api\/health$/,
  /^\/api\/recipes\/random$/,
  /^\/api\/menu$/,
];

const LIST_60S = [
  /^\/api\/(categories|stats|search)$/,
  /^\/api\/recipes$/,
  /^\/api\/tips$/,
];

export function cacheControl(req, res, next) {
  // 归一化尾斜杠：/api/recipes/ 与 /api/recipes 应用同一策略
  const path = req.path === '/' ? '/' : req.path.replace(/\/+$/, '');
  let value = 'public, max-age=300';
  if (NO_STORE.some((re) => re.test(path))) value = 'no-store';
  else if (LIST_60S.some((re) => re.test(path))) value = 'public, max-age=60';
  res.set('Cache-Control', value);
  next();
}
