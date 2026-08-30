import { Router } from 'express';
import { config } from '../config.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* GET /api —— 端点自描述索引页                                          */
/* ------------------------------------------------------------------ */

router.get('/', (req, res) => {
  const rows = [
    ['GET', '/api/health', '健康检查（含索引统计）'],
    ['GET', '/api/openapi.json', 'OpenAPI 3.1 接口描述'],
    ['GET', '/api/docs', '交互式 API 文档（Swagger UI）'],
    ['GET', '/api/categories', '菜谱分类列表（中文名 + 数量）'],
    ['GET', '/api/recipes', '菜谱列表 / 模糊搜索。参数：q、category、difficulty、max_difficulty、ingredient、sort、page、page_size、fields、image_mode'],
    ['GET', '/api/recipes/random', '随机推荐（今天吃什么）。参数：count、seed（可复现）、category、difficulty、exclude_tags、image_mode'],
    ['GET', '/api/menu', '自动配一餐（荤+素+汤组合）。参数：seed（可复现）、meat、vegetable、soup（各槽数量，默认 1，上限 3）、max_difficulty、exclude_tags、image_mode'],
    ['GET', '/api/plan/week', '一周膳食计划（每日荤素汤、周内不重样、seed 可复现）。参数：days（默认 7）、meat、vegetable、soup、max_difficulty、exclude_tags、seed、image_mode'],
    ['POST', '/api/shopping-list', '合并多菜谱原料为购物清单（规范名归一、同单位相加）。参数：ids（逗号分隔）、servings'],
    ['GET', '/api/recipes/by-ingredients', '按手头原料找菜。参数：have（逗号分隔）、mode=loose|strict、limit、image_mode'],
    ['GET', '/api/recipes/:id', '单个菜谱完整结构化 JSON（含 markdown 与 html 全文）'],
    ['GET', '/api/recipes/:id/meta', '元信息：标题 / 分类 / 难度 / 卡路里 / 作者 / 编写时间 / 更新时间 / 封面'],
    ['GET', '/api/recipes/:id/ingredients', '原料清单（名称 / 数量 / 备注 / 是否可选）；?servings=N 按份数线性缩放'],
    ['GET', '/api/recipes/:id/tools', '工具清单'],
    ['GET', '/api/recipes/:id/steps', '烹饪步骤（text=Markdown，html=渲染后；含 H3 分组）'],
    ['GET', '/api/recipes/:id/sections', '原始 H2 段落（markdown + html）'],
    ['GET', '/api/recipes/:id/notes', '附加内容与反馈声明'],
    ['GET', '/api/recipes/:id/images', '图片资源清单（相对路径 + server / proxy URL）'],
    ['GET', '/api/recipes/:id/related', '相似菜谱推荐（原料重合度 + 同分类加权）。参数：limit'],
    ['GET', '/api/recipes/:id/jsonld', 'schema.org Recipe JSON-LD（Google 菜谱富摘要标准格式）'],
    ['GET', '/api/recipes/:id/markdown', '完整 Markdown（图片地址按 image_mode 重写）'],
    ['GET', '/api/recipes/:id/html', '正文 HTML 片段（仅正文，无 html/head/body 包裹）'],
    ['GET', '/api/recipes/:id/raw', '原始 markdown 文件字节'],
    ['GET', '/api/search', '聚合搜索：菜谱 + 技巧文档一次返回。参数：q、image_mode'],
    ['GET', '/api/stats', '全库统计（分类 / 难度 / 烹饪方式分布、最常用原料）'],
    ['GET', '/api/tips', '烹饪技巧文档列表 / 搜索（q、group、分页）'],
    ['GET', '/api/tips/:id', '技巧文档详情（+ /meta /markdown /html /raw）'],
    ['GET', '/api/content', '内容版本信息（当前 commit / 上游 / 分支 / 最近检查与更新时间）'],
    ['GET', '/api/content/check', '联网检查上游是否有新版本'],
    ['POST', '/api/content/update', '拉取上游更新并重建索引（?dry_run=1 仅检查；UPDATE_TOKEN 开启时需 X-Update-Token）'],
    ['GET', '/api/content/changelog', '最近新增 / 更新的菜谱（?days=30）'],
    ['GET', '/assets/*', '图片等静态资源（按仓库相对路径分发）'],
  ];
  const rowsHtml = rows
    .map(
      ([method, url, desc]) =>
        `<tr><td><code>${method}</code></td><td><code><a href="${url.replace(/:id/, '0').split(' ')[0]}">${url}</a></code></td><td>${desc}</td></tr>`
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HowToCook API</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.5rem; }
  code { background: #f6f8fa; padding: .1rem .35rem; border-radius: 4px; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #d0d7de; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .pill { display: inline-block; background: #ddf4e4; border: 1px solid #aceebb; border-radius: 999px; padding: 0 .6rem; font-size: .8rem; }
  p.tip { color: #59636e; font-size: .9rem; }
</style>
</head>
<body>
<h1>HowToCook 菜谱 API <span class="pill">只读</span></h1>
<p>程序员在家做饭指南的内容中间件。全部接口均为 GET，响应包格式 <code>{ data, meta }</code>，错误格式 <code>{ error: { code, message } }</code>。</p>
<p class="tip">当前图片模式默认值：<code>${config.defaultImageMode}</code>（可用 <code>?image_mode=relative|server|proxy</code> 覆盖；反代地址 <code>ASSET_BASE_URL</code> ${config.assetBaseUrl ? `已配置：<code>${config.assetBaseUrl}</code>` : '未配置'}）。</p>
<table>
<thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead>
<tbody>
${rowsHtml}
</tbody>
</table>
</body>
</html>`;
  res.type('text/html; charset=utf-8').send(html);
});

/* ------------------------------------------------------------------ */
/* GET /api/docs —— Swagger UI（读取本服务 openapi.json，CDN 单页）        */
/* ------------------------------------------------------------------ */

router.get('/docs', (req, res) => {
  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HowToCook API 文档</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  window.SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger', persistAuthorization: false });
</script>
</body>
</html>`);
});

/* ------------------------------------------------------------------ */
/* GET /api/health                                                     */
/* ------------------------------------------------------------------ */

router.get('/health', (req, res) => {
  const store = req.app.locals.store;
  res.json({
    data: {
      status: 'ok',
      recipes: store.recipes.size,
      tips: store.tips.size,
      categories: store.categories.length,
      index_built_at: store.builtAt,
      git_metadata: store.gitAvailable,
      image_mode_default: config.defaultImageMode,
      asset_base_url: config.assetBaseUrl,
    },
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/openapi.json                                               */
/* ------------------------------------------------------------------ */

router.get('/openapi.json', (req, res) => {
  res.json(openApiDocument());
});

function openApiDocument() {
  const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', description, schema });
  return {
    openapi: '3.1.0',
    info: {
      title: 'HowToCook API',
      version: '1.0.0',
      description: 'HowToCook（程序员在家做饭指南）菜谱内容中间件：模糊搜索、结构化字段、Markdown / HTML 全文与图片分发。',
      license: { name: 'Unlicense' },
    },
    servers: [{ url: '/' }],
    paths: {
      '/api/health': { get: { summary: '健康检查', responses: okRef() } },
      '/api/categories': { get: { summary: '分类列表', responses: okRef() } },
      '/api/recipes': {
        get: {
          summary: '菜谱列表 / 模糊搜索（标题子串、拼音全拼、拼音首字母、原料、正文）',
          parameters: [
            q('q', '搜索关键词（支持拼音，如 hongshaorou / hsr）'),
            q('category', '分类 id，见 /api/categories'),
            q('difficulty', '精确难度 1-5', { type: 'integer', minimum: 1, maximum: 5 }),
            q('max_difficulty', '难度上限 1-5', { type: 'integer', minimum: 1, maximum: 5 }),
            q('ingredient', '包含某原料（子串匹配）'),
            q('sort', '排序字段：title / path / difficulty / created_at / updated_at，加 - 前缀降序'),
            q('page', '页码，默认 1', { type: 'integer', default: 1 }),
            q('page_size', '每页数量，默认 20，最大 100', { type: 'integer', default: 20, maximum: 100 }),
            q('fields', '仅返回指定顶层字段（逗号分隔）'),
            imageModeParam(),
          ],
          responses: okRef(),
        },
      },
      '/api/recipes/{id}': { get: { summary: '菜谱完整结构化数据', parameters: [idParam(), imageModeParam()], responses: okRef() } },
      '/api/recipes/{id}/meta': { get: { summary: '元信息（作者 / 编写时间 / 更新时间 / 难度 / 卡路里等）', parameters: [idParam(), imageModeParam()], responses: okRef() } },
      '/api/recipes/{id}/ingredients': { get: { summary: '原料与数量', parameters: [idParam()], responses: okRef() } },
      '/api/recipes/{id}/tools': { get: { summary: '工具清单', parameters: [idParam()], responses: okRef() } },
      '/api/recipes/{id}/steps': { get: { summary: '烹饪步骤（含 H3 分组）', parameters: [idParam()], responses: okRef() } },
      '/api/recipes/{id}/sections': { get: { summary: '原始 H2 段落', parameters: [idParam(), imageModeParam()], responses: okRef() } },
      '/api/recipes/{id}/notes': { get: { summary: '附加内容', parameters: [idParam()], responses: okRef() } },
      '/api/recipes/{id}/images': { get: { summary: '图片资源清单', parameters: [idParam(), imageModeParam()], responses: okRef() } },
      '/api/recipes/{id}/markdown': { get: { summary: '完整 Markdown（图片地址按 image_mode 重写）', parameters: [idParam(), imageModeParam()], responses: { 200: { description: 'text/markdown' } } } },
      '/api/recipes/{id}/html': { get: { summary: '正文 HTML 片段', parameters: [idParam(), imageModeParam()], responses: { 200: { description: 'text/html 片段' } } } },
      '/api/recipes/{id}/raw': { get: { summary: '原始 markdown 文件', parameters: [idParam()], responses: { 200: { description: 'text/markdown' } } } },
      '/api/recipes/{id}/related': { get: { summary: '相似菜谱推荐（原料重合度 + 同分类加权）', parameters: [idParam(), q('limit', '返回数量，默认 5，最大 20', { type: 'integer', default: 5 })], responses: okRef() } },
      '/api/recipes/random': {
        get: {
          summary: '随机推荐（今天吃什么）；提供 seed 时结果可复现',
          parameters: [
            q('count', '返回数量，默认 1，最大 20', { type: 'integer', default: 1 }),
            q('seed', '随机种子：相同 seed 返回相同结果'),
            q('category', '限定分类'),
            q('difficulty', '限定难度 1-5', { type: 'integer', minimum: 1, maximum: 5 }),
            imageModeParam(),
          ],
          responses: okRef(),
        },
      },
      '/api/recipes/by-ingredients': {
        get: {
          summary: '按手头原料找菜：返回覆盖率与所缺原料（含常见别名匹配，如番茄=西红柿）',
          parameters: [
            q('have', '手头原料，逗号分隔，如 鸡蛋,西红柿', { required: false }),
            q('mode', 'loose=按覆盖率排序（默认）；strict=原料齐全才返回', { schema: { type: 'string', enum: ['loose', 'strict'], default: 'loose' } }),
            q('limit', '返回数量，默认 20，最大 50', { type: 'integer', default: 20 }),
            imageModeParam(),
          ],
          responses: okRef(),
        },
      },
      '/api/menu': {
        get: {
          summary: '自动配一餐：荤菜（含水产）+ 素菜 + 汤组合；提供 seed 时整桌可复现',
          parameters: [
            q('seed', '随机种子：相同 seed 返回相同整桌'),
            q('meat', '荤菜数量，默认 1，上限 3', { type: 'integer', default: 1 }),
            q('vegetable', '素菜数量，默认 1，上限 3', { type: 'integer', default: 1 }),
            q('soup', '汤数量，默认 1，上限 3', { type: 'integer', default: 1 }),
            q('max_difficulty', '难度上限 1-5', { type: 'integer', minimum: 1, maximum: 5 }),
            q('exclude_tags', '排除含这些标签的菜（逗号分隔：vegetarian/spicy/seafood/peanut/egg/dairy/gluten）'),
            imageModeParam(),
          ],
          responses: okRef(),
        },
      },
      '/api/plan/week': {
        get: {
          summary: '一周膳食计划：每日荤素汤组合，周内不重样；seed 可复现整周',
          parameters: [
            q('seed', '随机种子：相同 seed 返回相同整周'),
            q('days', '计划天数，默认 7，最大 14', { type: 'integer', default: 7 }),
            q('meat', '每日荤菜数量，默认 1，上限 3', { type: 'integer', default: 1 }),
            q('vegetable', '每日素菜数量，默认 1，上限 3', { type: 'integer', default: 1 }),
            q('soup', '每日汤数量，默认 1，上限 3', { type: 'integer', default: 1 }),
            q('max_difficulty', '难度上限 1-5', { type: 'integer', minimum: 1, maximum: 5 }),
            q('exclude_tags', '排除含这些标签的菜（忌口/过敏原）'),
            imageModeParam(),
          ],
          responses: okRef(),
        },
      },
      '/api/shopping-list': {
        post: {
          summary: '合并多菜谱原料为购物清单（规范名归一聚合、同单位相加、适量类单列）',
          parameters: [
            q('ids', '菜谱 id，逗号分隔', { required: true }),
            q('servings', '按份数缩放数量（基准 2 人份）', { type: 'integer' }),
          ],
          responses: okRef(),
        },
      },
      '/api/recipes/{id}/jsonld': { get: { summary: 'schema.org Recipe JSON-LD（Google 菜谱富摘要）', parameters: [idParam()], responses: { 200: { description: 'application/ld+json' } } } },
      '/api/content/changelog': {
        get: {
          summary: '最近新增 / 更新的菜谱（基于构建索引的 git 元数据）',
          parameters: [q('days', '回溯天数，默认 30，最大 365', { type: 'integer', default: 30 })],
          responses: okRef(),
        },
      },
      '/api/search': {
        get: {
          summary: '聚合搜索：菜谱 + 技巧文档一次返回',
          parameters: [q('q', '搜索关键词（支持拼音）', { required: true }), imageModeParam()],
          responses: okRef(),
        },
      },
      '/api/stats': { get: { summary: '全库统计（分类 / 难度 / 烹饪方式分布、最常用原料 Top 15）', responses: okRef() } },
      '/api/content': { get: { summary: '内容版本信息（当前 commit / 上游 / 分支 / 工作区状态 / 最近检查与更新）', responses: okRef() } },
      '/api/content/check': { get: { summary: '联网检查上游是否有新版本', responses: okRef() } },
      '/api/content/update': {
        post: {
          summary: '拉取上游更新并重建索引（dry_run=1 仅检查不拉取；UPDATE_TOKEN 开启时需携带 X-Update-Token）',
          parameters: [
            q('dry_run', '传 1 时只检查不实际拉取'),
            { name: 'X-Update-Token', in: 'header', required: false, schema: { type: 'string' }, description: 'UPDATE_TOKEN 开启时的更新令牌' },
          ],
          responses: okRef(),
        },
      },
      '/api/docs': { get: { summary: '交互式文档（Swagger UI）', responses: { 200: { description: 'text/html' } } } },
      '/api/tips': {
        get: {
          summary: '技巧文档列表 / 搜索',
          parameters: [
            q('q', '搜索关键词（支持拼音）'),
            q('group', 'learn 或 advanced'),
            q('page', '页码', { type: 'integer', default: 1 }),
            q('page_size', '每页数量', { type: 'integer', default: 20, maximum: 100 }),
          ],
          responses: okRef(),
        },
      },
      '/api/tips/{id}': { get: { summary: '技巧文档详情（另有 /meta /markdown /html /raw）', parameters: [idParam(), imageModeParam()], responses: okRef() } },
      '/assets/{path}': { get: { summary: '静态资源分发（图片）', parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: '仓库相对路径，如 dishes/aquatic/小龙虾/成品.jpg' }], responses: { 200: { description: '图片字节' } } } },
    },
  };
}

const okRef = () => ({ 200: { description: '成功', content: { 'application/json': { schema: { type: 'object' } } } } });
const idParam = () => ({ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '菜谱/文档 id（列表接口返回），也接受仓库相对路径' });
const imageModeParam = () => ({
  name: 'image_mode',
  in: 'query',
  description: '图片地址模式：relative（文档原样相对路径）/ server（/assets/...）/ proxy（ASSET_BASE_URL 前缀）',
  schema: { type: 'string', enum: ['relative', 'server', 'proxy'] },
});

export default router;
