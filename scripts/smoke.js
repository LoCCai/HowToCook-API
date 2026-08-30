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
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ASSET_BASE_URL: 'https://cdn.example.com/htc', WATCH: '0', UPDATE_TOKEN: 'smoke-token' },
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
  const postJson = async (p) => {
    const r = await fetch(assertLocalUrl(BASE + p), { method: 'POST' });
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
    const menuBlank = await getJson('/api/menu?meat=&vegetable=1&soup=1&seed=x');
    check('menu 留空槽位按默认 1（而非 0）', menuBlank.body.data.meat.length === 1);
    check('menu meta 含 unfilled 字段', Array.isArray(menu.body.meta.unfilled));

    const rndBad = await getJson('/api/recipes/random?difficulty=9');
    check('random 非法难度 400（不静默忽略）', rndBad.status === 400);

    // 错误响应必须 no-store，防止 CDN 缓存 404/400
    const nfRecipe = await getJson('/api/recipes/nonexistentid');
    check('404 响应 no-store', nfRecipe.headers.get('cache-control') === 'no-store');
    const badCat = await getJson('/api/recipes?category=nonexistent');
    check('400 响应 no-store', badCat.headers.get('cache-control') === 'no-store');

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

  console.log('[13] 内容版本与更新');
  {
    const info = await getJson('/api/content');
    check('content 版本信息 tracked', info.body.data.tracked === true);
    check('content commit 为 40 位哈希', /^[0-9a-f]{40}$/.test(info.body.data.commit || ''), `got ${info.body.data.commit}`);
    check('content 响应 no-store', info.headers.get('cache-control') === 'no-store');

    const noToken = await fetch(assertLocalUrl(BASE + '/api/content/update'), { method: 'POST' });
    check('update 无令牌 403', noToken.status === 403);

    // 检查更新依赖外网可达：200 为正常结果，502（上游不可达）也接受
    const checkRes = await getJson('/api/content/check');
    check(
      'check 返回合法结构',
      checkRes.status === 200
        ? typeof checkRes.body.data.up_to_date === 'boolean' && /^[0-9a-f]{40}$/.test(checkRes.body.data.remote || '')
        : checkRes.status === 502,
      `status=${checkRes.status}`
    );

    // dry_run 只检查不拉取（绝不真更新测试环境的内容目录）
    const dry = await fetch(assertLocalUrl(BASE + '/api/content/update?dry_run=1'), {
      method: 'POST',
      headers: { 'X-Update-Token': 'smoke-token' },
    });
    const dryBody = await dry.json();
    check(
      'dry_run 仅检查不拉取',
      dry.status === 200 ? (dryBody.data.dry_run === true && dryBody.data.updated === false) : dry.status === 502,
      `status=${dry.status}`
    );
  }

  console.log('[14] 周计划 / 购物清单 / 标签 / JSON-LD / changelog / 份数缩放');
  {
    // 一周膳食计划
    const week = await getJson('/api/plan/week?seed=wk&days=7');
    check('week 7 天计划', week.body.data.days.length === 7);
    const allIds = week.body.data.days.flatMap((d) => [...d.meat, ...d.vegetable, ...d.soup].map((x) => x.id));
    check('week 周内不重样', new Set(allIds).size === allIds.length, `total=${allIds.length} unique=${new Set(allIds).size}`);
    check('week 每日荤素汤齐全', week.body.data.days.every((d) => d.meat.length === 1 && d.vegetable.length === 1 && d.soup.length === 1));
    const week2 = await getJson('/api/plan/week?seed=wk&days=7');
    check('week 同 seed 可复现', week2.body.data.days[0].meat[0].id === week.body.data.days[0].meat[0].id);
    check('week meta 标注 repeats', week.body.meta.repeats === false);

    // 忌口标签过滤
    const veg = await getJson('/api/recipes?tag=vegetarian&page_size=100');
    check('tag=vegetarian 全部为素', veg.body.data.length > 0 && veg.body.data.every((x) => x.diet_tags.includes('vegetarian')));
    const noSea = await getJson('/api/recipes?exclude_tags=seafood&page_size=100');
    check('exclude_tags=seafood 无水产', noSea.body.data.length > 0 && noSea.body.data.every((x) => !x.diet_tags.includes('seafood')));
    const detail = await getJson(`/api/recipes/${XL_ID}`);
    check('详情含 diet_tags（小龙虾 spicy+seafood）', detail.body.data.diet_tags.includes('spicy') && detail.body.data.diet_tags.includes('seafood'));

    // 购物清单：蛏抱蛋 + 微波炉荷包蛋（鸡蛋均为纯数字数量「2 个」，合并应得 4 个）
    const byId = (title) =>
      getJson(`/api/recipes?q=${encodeURIComponent(title)}&page_size=1`).then((r) => r.body.data[0]?.id);
    const chengId = await byId('蛏抱蛋');
    const omeletteId = await byId('微波炉荷包蛋');
    if (chengId && omeletteId) {
      const sl = await postJson(`/api/shopping-list?ids=${chengId},${omeletteId}`);
      check('shopping-list 合并原料', sl.body.data.items.length > 0 && sl.body.data.recipes.length === 2);
      const eggItem = sl.body.data.items.find((i) => i.name === '鸡蛋');
      check('shopping-list 鸡蛋跨菜谱合并相加（2 个 + 2 个 = 4 个）', eggItem && eggItem.amounts.length === 1 && eggItem.amounts[0].value === 4, JSON.stringify(eggItem));
      check('shopping-list 规范名归一（display_names）', sl.body.data.items.every((i) => i.display_names.length >= 1));
      const slScaled = await postJson(`/api/shopping-list?ids=${chengId}&servings=4`);
      check('shopping-list servings 缩放', slScaled.body.data.items.some((i) => i.amounts.some((a) => a.scaled === true && a.value > 0)));
    } else {
      check('找到蛏抱蛋与微波炉荷包蛋', false, `cheng=${chengId} omelette=${omeletteId}`);
    }
    const slBad = await postJson('/api/shopping-list');
    check('shopping-list 缺 ids 400', slBad.status === 400);

    // JSON-LD
    const ld = await fetch(assertLocalUrl(BASE + `/api/recipes/${XL_ID}/jsonld`));
    const ldBody = await ld.json();
    check('jsonld content-type', (ld.headers.get('content-type') || '').includes('application/ld+json'));
    check('jsonld 结构（Recipe + HowToStep + 原料）', ldBody['@type'] === 'Recipe' && ldBody.recipeIngredient.length === 17 && ldBody.recipeInstructions[0]['@type'] === 'HowToStep');
    check('jsonld 作者来自 git', ldBody.author.name === 'Allen');

    // 份数缩放
    const ing = await getJson(`/api/recipes/${XL_ID}/ingredients?servings=4`);
    check('ingredients servings 缩放元数据', ing.body.meta.servings === 4 && ing.body.meta.base_servings >= 1);
    const scaledItem = ing.body.data.find((i) => i.scaled === true);
    check('数值型数量已缩放且保留原文', scaledItem && scaledItem.quantity_original != null && scaledItem.quantity !== scaledItem.quantity_original);
    check('无法缩放项标注 scaled=false', ing.body.data.every((i) => typeof i.scaled === 'boolean'));

    // changelog
    const log = await getJson('/api/content/changelog?days=365');
    check('changelog 结构', Array.isArray(log.body.data.added) && Array.isArray(log.body.data.updated));
    check('changelog 覆盖全部菜谱（365 天窗口）', log.body.meta.added + log.body.meta.updated >= 368, `added=${log.body.meta.added} updated=${log.body.meta.updated}`);
  }

  console.log('[15] 计划模型升级（六槽/按天槽数/早餐/清单联动/标签诚信）');
  {
    // 按天槽数：周一两荤、周二一荤（循环填充）
    const varied = await getJson('/api/plan/week?seed=v&meat=2,1&days=7');
    check('week 按天槽数（day1 两荤 day2 一荤）', varied.body.data.days[0].meat.length === 2 && varied.body.data.days[1].meat.length === 1);
    check('week 按天槽数循环填充（day3 两荤）', varied.body.data.days[2].meat.length === 2);
    const allMeat = varied.body.data.days.flatMap((d) => d.meat);
    check('week 变槽数后仍不重样', new Set(allMeat.map((x) => x.id)).size === allMeat.length);

    // 早餐槽 + 荤素汤默认
    const full = await getJson('/api/plan/week?seed=f&breakfast=1');
    check('week 早餐槽生效', full.body.data.days.every((d) => d.breakfast.length === 1));
    check('week 早餐来自早餐分类', full.body.data.days.every((d) => d.breakfast[0].category.id === 'breakfast'));
    check('week 默认荤素汤保持', full.body.data.days.every((d) => d.meat.length === 1 && d.vegetable.length === 1 && d.soup.length === 1));

    // 周计划打通购物清单
    const withSl = await getJson('/api/plan/week?seed=f&breakfast=1&with_shopping_list=1&servings=4');
    const slItems = withSl.body.data.shopping_list.items;
    check('week 附整周购物清单', withSl.body.meta.shopping_list?.items > 0 && slItems.length > 0);
    check('清单 servings 缩放标注', slItems.some((i) => i.amounts.some((a) => a.scaled === true)));
    check('meta 带标签诚信说明', typeof withSl.body.meta.diet_tags_note === 'string' && withSl.body.meta.diet_tags_note.includes('启发式'));

    // menu 六槽位：早餐 + 饮料 + 甜品
    const feast = await getJson('/api/menu?seed=feast&breakfast=1&drink=1&dessert=1&meat=0&vegetable=0&soup=0');
    check('menu 六槽位（早/饮/甜）', feast.body.data.breakfast.length === 1 && feast.body.data.drink.length === 1 && feast.body.data.dessert.length === 1);
    check('menu 分类池正确', feast.body.data.breakfast[0].category.id === 'breakfast' && feast.body.data.drink[0].category.id === 'drink' && feast.body.data.dessert[0].category.id === 'dessert');
    const menuNote = await getJson('/api/menu?seed=feast');
    check('menu meta 带标签诚信说明', typeof menuNote.body.meta.diet_tags_note === 'string');
  }
} catch (err) {
  failed++;
  console.error('冒烟测试异常中断:', err);
} finally {
  server.kill();
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
