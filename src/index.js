import path from 'node:path';
import { watch } from 'node:fs';
import { config } from './config.js';
import { Store } from './lib/scanner.js';
import { buildRecipeSearchIndex, buildTipSearchIndex } from './lib/search.js';
import { ensureContent } from './lib/content-fetcher.js';
import { createApp } from './app.js';

const REBUILD_HOOKS = [buildRecipeSearchIndex, buildTipSearchIndex];

// 内容缺失时自动从官方 HowToCook 仓库下载（CONTENT_DIR 指定的目录不会触发下载）
const contentState = await ensureContent(config.repoRoot);
if (contentState.action === 'cloned') {
  console.log(`  内容目录: ${config.repoRoot}`);
}

const store = new Store(config.repoRoot);
await store.rebuild(REBUILD_HOOKS);

const app = createApp(store);
const server = app.listen(config.port, config.host, () => {
  console.log(`HowToCook API 已启动: http://${config.host}:${config.port}/api`);
  console.log(`  菜谱 ${store.recipes.size} 个 · 技巧 ${store.tips.size} 篇 · 图片模式默认 ${config.defaultImageMode}`);
  if (config.assetBaseUrl) console.log(`  资源反代地址: ${config.assetBaseUrl}`);
});

// 开发模式：内容目录变化后防抖重建索引
if (config.watch) {
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      store.rebuild(REBUILD_HOOKS).catch((err) => console.error('[watch] 重建失败:', err));
    }, 300);
  };
  for (const dir of ['dishes', 'tips']) {
    try {
      watch(path.join(config.repoRoot, dir), { recursive: true }, trigger);
    } catch (err) {
      console.warn(`[watch] 无法监视 ${dir}:`, err.message);
    }
  }
  console.log('  已开启内容监视（WATCH=1），修改 dishes/ 或 tips/ 后自动重建索引');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
