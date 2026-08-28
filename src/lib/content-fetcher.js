import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 下载源固定为官方仓库（公网地址，写死为常量，不接受运行时覆盖，杜绝注入面）
const OFFICIAL_CONTENT_REPO = 'https://github.com/Anduin2017/HowToCook.git';

/**
 * 确保内容根目录可用：
 * - 已有 dishes/ 直接复用（CONTENT_DIR 指定的目录或上一级目录无需下载）；
 * - 否则从官方 HowToCook 仓库完整克隆到 repoRoot
 *   （保留 .git 历史以提取作者 / 编写时间元数据）。
 *
 * repoRoot 即下载目标目录（默认 <api>/content，见 config.js 探测逻辑）。
 */
export async function ensureContent(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, 'dishes'))) {
    return { action: 'existing' };
  }

  console.log(`[content] ${repoRoot} 下未找到 dishes/，开始从官方仓库下载：${OFFICIAL_CONTENT_REPO}`);

  if (fs.existsSync(repoRoot)) {
    const entries = fs.readdirSync(repoRoot);
    if (entries.length > 0) {
      throw new Error(
        `内容目录 ${repoRoot} 已存在且非空但缺少 dishes/，` +
          '请手动清理该目录，或通过 CONTENT_DIR 指向已有的 HowToCook 目录'
      );
    }
  } else {
    fs.mkdirSync(path.dirname(repoRoot), { recursive: true });
  }

  // 参数为固定常量数组（不经 shell）；目标路径位于 "--" 终止符之后，不会被解释为选项
  const res = spawnSync(
    'git',
    ['clone', '--no-tags', '--', OFFICIAL_CONTENT_REPO, repoRoot],
    { stdio: 'inherit', windowsHide: true }
  );

  if (res.status !== 0 || !fs.existsSync(path.join(repoRoot, 'dishes'))) {
    // 清理半成品，避免下次启动被"非空目录"挡住
    fs.rmSync(repoRoot, { recursive: true, force: true });
    throw new Error(
      `内容下载失败（git clone 退出码 ${res.status}）。` +
        '请检查网络，或设置 CONTENT_DIR 指向本地已有的 HowToCook 目录'
    );
  }
  console.log('[content] 内容下载完成');
  return { action: 'cloned' };
}
