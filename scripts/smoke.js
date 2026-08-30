/**
 * 冒烟测试：启动服务（独立端口），验证核心端点后关闭。
 * 运行：npm run smoke
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 37890;
const BASE = `http://127.0.0.1:${PORT}`;
const XL_ID = 'e2a148eb6c'; // dishes/aquatic/小龙虾/小龙虾.md 的稳定 ID

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 参数为固定数组、无 shell，不涉及任何外部输入
const server = spawn('node', ['src/index.js'], {
  cwd: path.resolve(here, '..'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ASSET_BASE_URL: 'https://cdn.example.com/htc', WATCH: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('服务未在超时内就绪');
}

/** 限流验证：用独立端口起一个 RATE_LIMIT_MAX=5 的实例，第 6 个请求应 429。 */
async function testRateLimit() {
  const PORT2 = 37891;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const server2 = spawn('node', ['src/index.js'], {
    cwd: path.resolve(here, '..'),
    env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1', RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '60000', WATCH: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server2.stderr.on('data', () => {});
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = (await fetch(`${BASE2}/api/health`)).ok;
      } catch {}
      if (!ready) await new Promise((res) => setTimeout(res, 250));
    }
    if (!ready) {
      check('限流实例就绪', false);
      return;
    }
    // health 不限流：连续探测也不消耗配额
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${BASE2}/api/health`);
      check(`health 不受限流（第 ${i + 1} 次）`, r.status === 200);
    }
    const codes = [];
    let lastHeaders = null;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${BASE2}/api/categories`);
      codes.push(r.status);
      lastHeaders = r.headers;
    }
    check('第 6 个请求被限流 429', codes[5] === 429, `codes=${codes.join(',')}`);
    check('429 带 Retry-After', (lastHeaders.get('retry-after') || '') !== '');
    const limited = codes[5] === 429 ? await (await fetch(`${BASE2}/api/categories`)).json() : null;
    check('429 错误结构', limited?.error?.code === 'RATE_LIMITED');
  } finally {
    server2.kill();
  }
}

try {
  await waitReady();
  // 测试辅助：仅允许请求本地冒烟服务基址，其它一律拒绝（防 SSRF 的固定基址校验）
  const assertLocalUrl = (url) => {
    if (!url.startsWith(BASE + '/')) throw new Error(`拒绝非本地请求: ${url}`);
    return url;
  };
  const getJson = async (p) => {
    const r = await fetch(assertLocalUrl(BASE + p));
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  const textOf = async (res) => ({ status: res.status, text: await res.text() });

  console.log('[1] 基础端点');
  {
    const { body } = await getJson('/api/health');
    check('health: 368 菜谱', body.data.recipes === 368, `got ${body.data.recipes}`);
    check('health: git 元数据可用', body.data.git_metadata === true);
    const docs = await textOf(await fetch(assertLocalUrl(BASE + '/api')));
    check('/api 索引页 200 HTML', docs.status === 200 && docs.text.includes('<table>'));
    const oa = await getJson('/api/openapi.json');
    check('openapi 3.1', oa.body.openapi === '3.1.0');
  }

  console.log('[2] 分类');
  {
    const { body } = await getJson('/api/categories');
    check('10 个分类', body.data.length === 10);
    check('含中文标题', body.data.some((c) => c.id === 'aquatic' && c.title === '水产'));
  }

  console.log('[3] 搜索与过滤');
  {
    const zh = await getJson(`/api/recipes?q=${encodeURIComponent('小龙虾')}`);
    check('中文命中小龙虾', zh.body.data.some((x) => x.title === '小龙虾'));
    const py = await getJson('/api/recipes?q=hongshaorou&page_size=5');
    check('拼音全拼命中红烧肉', py.body.data.some((x) => x.title.includes('红烧肉')));
    const ini = await getJson('/api/recipes?q=hsr&page_size=5');
    check('拼音首字母命中红烧肉', ini.body.data.some((x) => x.title.includes('红烧肉')));
    const ing = await getJson(`/api/recipes?ingredient=${encodeURIComponent('咖喱')}&page_size=100`);
    check('原料过滤', ing.body.meta.total >= 2, `total=${ing.body.meta.total}`);
    const diff = await getJson('/api/recipes?difficulty=5&page_size=100');
    check('难度过滤全为 5', diff.body.data.every((x) => x.difficulty === 5) && diff.body.meta.total > 0);
    const bad = await getJson('/api/recipes?difficulty=9');
    check('非法难度 400', bad.status === 400);
  }

  console.log('[4] 结构化字段');
  {
    const { body } = await getJson(`/api/recipes/${XL_ID}`);
    const f = body.data;
    check('标题', f.title === '小龙虾');
    check('作者来自 git', f.author === 'Allen');
    check('created_at 为 2022-03-22', String(f.created_at).startsWith('2022-03-22'));
    check('难度 4', f.difficulty === 4 && f.difficulty_display === '★★★★');
    check('卡路里 571 大卡', f.calories?.value === 571 && f.calories?.unit === '大卡');
    check('时间估计 45 分钟', f.time_estimate?.minutes === 45);
    check('原料 17 项含数量', f.ingredients.length === 17 && f.ingredients[0].name === '小龙虾' && f.ingredients[0].quantity === '2 斤');
    check('步骤 7 步', f.steps.length === 7 && f.steps[0].text.length > 5);
    check('烹饪方式标签', Array.isArray(f.methods) && f.methods.includes('炒'));
    check('段落齐全', ['必备原料和工具', '计算', '操作', '附加内容'].every((h) => f.sections.some((s) => s.heading === h)));
    check('封面 server URL（urls.server）', f.cover.urls.server.startsWith('/assets/dishes/aquatic/'));
    check('封面默认 proxy URL', f.cover.url.startsWith('https://cdn.example.com/htc/'));
  }

  console.log('[5] 子端点');
  {
    const meta = await getJson(`/api/recipes/${XL_ID}/meta`);
    check('meta 含作者/时间/计数', meta.body.data.author.name === 'Allen' && meta.body.data.counts.steps === 7);
    const ing = await getJson(`/api/recipes/${XL_ID}/ingredients`);
    check('ingredients 端点', ing.body.data.length === 17);
    const steps = await getJson(`/api/recipes/${XL_ID}/steps`);
    check('steps flat+grouped', steps.body.data.flat.length === 7);
    const sun = await getJson(`/api/recipes?q=${encodeURIComponent('太阳蛋')}&page_size=1`);
    const sunSteps = await getJson(`/api/recipes/${sun.body.data[0].id}/steps`);
    check('H3 分组（可控/不可控微波炉）', sunSteps.body.data.grouped.length === 2);
    const notes = await getJson(`/api/recipes/${XL_ID}/notes`);
    check('notes 数组', Array.isArray(notes.body.data.notes));
  }

  console.log('[6] 文档格式与图片模式');
  {
    const raw = await textOf(await fetch(assertLocalUrl(BASE + `/api/recipes/${XL_ID}/raw`)));
    check('raw 保持原始相对路径', raw.text.includes('./成品.jpg'));
    const md = await textOf(await fetch(assertLocalUrl(BASE + `/api/recipes/${XL_ID}/markdown`)));
    check('markdown 默认重写为 proxy（已配反代）', md.text.includes('https://cdn.example.com/htc/dishes/aquatic/'));
    const mdRel = await textOf(await fetch(assertLocalUrl(BASE + `/api/recipes/${XL_ID}/markdown?image_mode=relative`)));
    check('relative 模式原样', mdRel.text.includes('./成品.jpg'));
    const html = await textOf(await fetch(assertLocalUrl(BASE + `/api/recipes/${XL_ID}/html?image_mode=server`)));
    check('html 片段以 h1 开头', html.text.startsWith('<h1>'));
    const rel = await getJson(`/api/recipes/${XL_ID}?image_mode=relative`);
    check('relative JSON 附 recipe_dir', rel.body.data.recipe_dir === 'dishes/aquatic/小龙虾');
    const proxy = await getJson(`/api/recipes/${XL_ID}?image_mode=proxy`);
    check('proxy 模式重写', proxy.body.data.content.markdown.includes('https://cdn.example.com/htc/'));
  }

  console.log('[7] tips');
  {
    const list = await getJson('/api/tips');
    check('18 篇技巧', list.body.meta.total === 18);
    const q = await getJson(`/api/tips?q=${encodeURIComponent('去腥')}`);
    check('搜索命中去腥', q.body.data.some((t) => t.title === '去腥'));
    const one = await getJson(`/api/tips/${q.body.data[0].id}`);
    check('tips 详情 sections', one.body.data.sections.length > 0);
    const tipHtml = await textOf(await fetch(assertLocalUrl(BASE + `/api/tips/${q.body.data[0].id}/html`)));
    check('tips html 200', tipHtml.status === 200 && tipHtml.text.length > 100);
  }

  console.log('[8] 静态资源与安全');
  {
    const img = await fetch(`${BASE}/assets/dishes/aquatic/${encodeURIComponent('小龙虾')}/${encodeURIComponent('成品.jpg')}`);
    check('图片 200 image/jpeg', img.status === 200 && img.headers.get('content-type') === 'image/jpeg');
    check('图片 Cache-Control', (img.headers.get('cache-control') || '').includes('max-age'));
    const noExt = await fetch(`${BASE}/assets/dishes/aquatic/小龙虾/../../../package.json`);
    check('路径穿越被拒', noExt.status === 403 || noExt.status === 404);
    const encoded = await fetch(`${BASE}/assets/dishes/%2e%2e/%2e%2e/package.json`);
    check('编码穿越被拒', encoded.status === 403 || encoded.status === 404);
    const nf = await fetch(`${BASE}/api/recipes/zzzzzz`);
    check('不存在菜谱 404', nf.status === 404);
    const p404 = await fetch(`${BASE}/no/such/api`);
    check('未知接口 404 JSON', p404.status === 404 && (await p404.json()).error?.code === 'NOT_FOUND');
  }

  console.log('[9] path/title 兜底查找');
  {
    const byPath = await getJson(`/api/recipes/${encodeURIComponent('dishes/breakfast/太阳蛋.md')}`);
    check('按 path 查找', byPath.body.data.title === '太阳蛋');
    const list = await getJson('/api/recipes?page_size=1&fields=title,difficulty');
    check('fields 裁剪（保留 id/path）', 'id' in list.body.data[0] && 'path' in list.body.data[0] && !('author' in list.body.data[0]));
  }

  console.log('[10] 发现与统计');
  {
    const rnd = await getJson('/api/recipes/random?count=3&seed=abc');
    check('random 返回 3 个', rnd.body.data.length === 3 && rnd.body.meta.seed === 'abc');
    const rnd2 = await getJson('/api/recipes/random?count=3&seed=abc');
    check('同 seed 结果可复现', rnd.body.data[0].id === rnd2.body.data[0].id);
    const rndCat = await getJson('/api/recipes/random?category=soup&count=5');
    check('random 分类过滤', rndCat.body.data.every((x) => x.category.id === 'soup') && rndCat.body.data.length > 0);

    const byIng = await getJson(`/api/recipes/by-ingredients?have=${encodeURIComponent('鸡蛋,西红柿')}&limit=50`);
    check('by-ingredients 返回覆盖率结构', byIng.body.data.length > 0 && 'coverage' in byIng.body.data[0].ingredients_match);
    // 别名匹配：have=番茄 应同样命中原料写作"西红柿"的菜谱
    const byIngAlias = await getJson(`/api/recipes/by-ingredients?have=${encodeURIComponent('番茄,鸡蛋')}&limit=50`);
    const tomato = byIngAlias.body.data.find((x) => x.title === '西红柿炒鸡蛋');
    check('别名匹配（番茄→西红柿）', tomato && tomato.ingredients_match.hit_count >= 2, tomato ? JSON.stringify(tomato.ingredients_match) : '未找到西红柿炒鸡蛋');
    // strict 模式：返回的每一条都必须原料齐全
    const strict = await getJson(`/api/recipes/by-ingredients?have=${encodeURIComponent('鸡蛋,西红柿')}&mode=strict&limit=50`);
    check('strict 模式全部原料齐全', strict.body.data.every((x) => x.ingredients_match.missing.length === 0));
    check('strict 结果是 loose 的子集', strict.body.meta.matched <= byIng.body.meta.matched);
    const noHave = await getJson('/api/recipes/by-ingredients');
    check('缺 have 参数 400', noHave.status === 400);

    const rel = await getJson(`/api/recipes/${XL_ID}/related?limit=3`);
    check('related 返回相似菜谱', rel.body.data.length === 3 && rel.body.data[0].score > 0);

    const stats = await getJson('/api/stats');
    check('stats 全库统计', stats.body.data.recipes === 368 && stats.body.data.top_ingredients.length > 0 && stats.body.data.difficulty['4'] > 0);

    const agg = await getJson(`/api/search?q=${encodeURIComponent('蛋炒饭')}`);
    check('聚合搜索菜谱+技巧', agg.body.data.recipes.items.length > 0 && Array.isArray(agg.body.data.tips.items));
    const aggEmpty = await getJson('/api/search');
    check('聚合搜索缺 q 400', aggEmpty.status === 400);

    const docs = await textOf(await fetch(assertLocalUrl(BASE + '/api/docs')));
    check('/api/docs Swagger UI 页', docs.status === 200 && docs.text.includes('swagger-ui'));
  }

  console.log('[11] 套餐 / 归一统计 / 限流 / 缓存头');
  {
    const menu = await getJson('/api/menu?seed=dinner&max_difficulty=3');
    const m = menu.body.data;
    check('menu 三槽各 1 道', m.meat.length === 1 && m.vegetable.length === 1 && m.soup.length === 1);
    check('menu 荤菜池分类正确', ['meat_dish', 'aquatic'].includes(m.meat[0].category.id) && m.vegetable[0].category.id === 'vegetable_dish' && m.soup[0].category.id === 'soup');
    check('menu 难度上限生效', [m.meat[0], m.vegetable[0], m.soup[0]].every((x) => x.difficulty <= 3));
    const menu2 = await getJson('/api/menu?seed=dinner&max_difficulty=3');
    check('menu 同 seed 整桌可复现', menu2.body.data.meat[0].id === m.meat[0].id && menu2.body.data.vegetable[0].id === m.vegetable[0].id && menu2.body.data.soup[0].id === m.soup[0].id);
    const menuCustom = await getJson('/api/menu?meat=2&vegetable=0&soup=1&seed=x');
    check('menu 槽位数量可调', menuCustom.body.data.meat.length === 2 && menuCustom.body.data.vegetable.length === 0 && menuCustom.body.data.soup.length === 1);
    const menuEmpty = await getJson('/api/menu?meat=0&vegetable=0&soup=0');
    check('menu 全空槽 400', menuEmpty.status === 400);

    const stats = await getJson('/api/stats');
    const topNames = stats.body.data.top_ingredients.map((i) => i.name);
    check('stats 原料已归一（无「葱姜蒜」复合名）', !topNames.includes('葱姜蒜'));

    // 默认不限流：无 X-RateLimit-Limit 头
    const health = await getJson('/api/health');
    check('默认不限流', health.headers.get('x-ratelimit-limit') === null);
    check('health 响应 no-store', health.headers.get('cache-control') === 'no-store');
    const list = await getJson('/api/recipes?page_size=1');
    check('列表缓存头 max-age=60', (list.headers.get('cache-control') || '').includes('max-age=60'));
    const detail = await getJson(`/api/recipes/${XL_ID}`);
    check('详情缓存头 max-age=300', (detail.headers.get('cache-control') || '').includes('max-age=300'));
  }

  console.log('[12] 限流开启（独立实例）');
  await testRateLimit();
} catch (err) {
  failed++;
  console.error('冒烟测试异常中断:', err);
} finally {
  server.kill();
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
