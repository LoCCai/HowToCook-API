import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import { HttpError } from '../middleware/error.js';

/* ------------------------------------------------------------------ */
/* 下载源 URL 校验（检查/拉取更新前必须通过）                                */
/* 仅允许 http/https；拒绝凭据、localhost、环回、私有与保留地址              */
/* ------------------------------------------------------------------ */

const RESERVED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);

export function isReservedIpv4(ip) {
  const value = v4ToInt(ip);
  return RESERVED_V4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (v4ToInt(network) & mask);
  });
}

export function isReservedIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isReservedIpv4(mapped[1]);
  const hextets = lower.split(':').filter((s) => s !== '').map((s) => parseInt(s, 16) || 0);
  const first = hextets[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8
  if (first === 0x2001 && (hextets[1] ?? 0) === 0x0db8) return true; // 文档保留
  return false;
}

/** 校验 remote URL，返回用于 DNS 校验的 host；不合法直接抛 HttpError。 */
export function validateRepoUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'INVALID_REMOTE', `内容仓库地址无效：${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(400, 'INVALID_REMOTE', `内容仓库仅允许 http/https 协议，收到：${url.protocol}（如为 ssh 内网镜像请离线同步）`);
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'INVALID_REMOTE', '内容仓库地址不允许携带用户凭据');
  }
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** 解析 host 并确保全部结果为公网地址。 */
export async function assertPublicHost(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (isReservedIpv4(host)) throw new HttpError(400, 'FORBIDDEN_REMOTE', `内容仓库地址不允许指向私有 / 保留地址：${host}`);
    return;
  }
  if (host.includes(':')) {
    if (isReservedIpv6(host)) throw new HttpError(400, 'FORBIDDEN_REMOTE', `内容仓库地址不允许指向私有 / 保留地址：${host}`);
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new HttpError(400, 'FORBIDDEN_REMOTE', `内容仓库地址不允许指向本地主机：${host}`);
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new HttpError(502, 'UPSTREAM_UNREACHABLE', `内容仓库域名解析失败：${host}（${err.message}）`);
  }
  if (addresses.length === 0) {
    throw new HttpError(502, 'UPSTREAM_UNREACHABLE', `内容仓库域名解析失败：${host}`);
  }
  for (const { address, family } of addresses) {
    const reserved = family === 6 ? isReservedIpv6(address) : isReservedIpv4(address);
    if (reserved) {
      throw new HttpError(400, 'FORBIDDEN_REMOTE', `内容仓库域名 ${host} 解析到私有 / 保留地址 ${address}，已拒绝`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* git 执行与版本管理                                                    */
/* ------------------------------------------------------------------ */

/** 异步执行 git 子命令（不阻塞事件循环），返回 { code, stdout, stderr }。 */
function runGit(repoRoot, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoRoot, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      stderr += '\n执行超时';
      resolve({ code: -1, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** 更新器运行状态（跨请求共享）。 */
const state = {
  updating: false,
  lastCheck: null, // { at, up_to_date, local, remote } | { at, error }
  lastUpdate: null, // { at, from, to, source } | { at, error, source }
};

export function updaterState() {
  return { updating: state.updating, last_check: state.lastCheck, last_update: state.lastUpdate };
}

/** 内容目录的版本信息；非 git 目录返回 tracked:false。 */
export async function getContentInfo(repoRoot) {
  const head = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    return {
      tracked: false,
      reason: '内容目录不是 git 仓库（如 CONTENT_DIR 指定的本地目录），无法进行版本管理与更新',
    };
  }
  const [log, branchRes, urlRes, statusRes] = await Promise.all([
    runGit(repoRoot, ['log', '-1', '--format=%H%x1f%cI']),
    runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(repoRoot, ['remote', 'get-url', 'origin']),
    runGit(repoRoot, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  const [commit, committedAt] = (log.stdout || '').trim().split('\x1f');
  const branch = (branchRes.stdout || '').trim();
  return {
    tracked: true,
    commit: commit || null,
    committed_at: committedAt || null,
    branch: branch === 'HEAD' ? 'HEAD (detached)' : branch,
    remote: (urlRes.code === 0 ? urlRes.stdout : '').trim() || null,
    clean: statusRes.stdout.trim() === '',
    recipes_or_tips_managed: true,
    ...updaterState(),
  };
}

/** 联网检查上游最新提交；任何一步失败抛 HttpError。 */
export async function checkUpdate(repoRoot) {
  const info = await getContentInfo(repoRoot);
  if (!info.tracked) {
    throw new HttpError(400, 'NOT_TRACKED', info.reason);
  }
  const host = validateRepoUrl(info.remote);
  await assertPublicHost(host);
  // detached HEAD 时用 origin HEAD（上游默认分支）对比，同样有效
  const ls = await runGit(repoRoot, ['ls-remote', info.remote, 'HEAD'], { timeoutMs: 45000 });
  if (ls.code !== 0 || !ls.stdout.trim()) {
    throw new HttpError(502, 'UPSTREAM_UNREACHABLE', `无法获取上游最新版本：${(ls.stderr || '').trim().split('\n').pop() || '未知错误'}`);
  }
  const remoteCommit = ls.stdout.trim().split('\t')[0];
  const result = {
    up_to_date: remoteCommit === info.commit,
    local: info.commit,
    local_committed_at: info.committed_at,
    remote: remoteCommit,
    remote_url: info.remote,
    checked_at: new Date().toISOString(),
  };
  state.lastCheck = { at: result.checked_at, up_to_date: result.up_to_date, local: result.local, remote: result.remote };
  return result;
}

/**
 * 拉取上游更新并重建索引。
 * - dryRun=true 时只检查不拉取；
 * - 工作区有已跟踪文件的本地修改时拒绝（409），避免破坏用户目录；
 * - 更新方式：fetch 后 reset --hard 到 origin/<branch>（内容目录为纯消费克隆）。
 */
export async function applyUpdate(repoRoot, { rebuild, dryRun = false, source = 'manual' } = {}) {
  if (state.updating) {
    throw new HttpError(409, 'UPDATE_IN_PROGRESS', '已有更新任务在进行中，请稍后再试');
  }
  state.updating = true;
  try {
    const info = await getContentInfo(repoRoot);
    if (!info.tracked) throw new HttpError(400, 'NOT_TRACKED', info.reason);
    if (!info.clean) {
      throw new HttpError(409, 'DIRTY_WORKTREE', '内容目录存在已跟踪文件的本地修改，为避免破坏数据已停止更新；请先提交或还原');
    }
    const check = await checkUpdate(repoRoot);
    if (check.up_to_date) {
      state.lastUpdate = { at: new Date().toISOString(), from: check.local, to: check.local, source, unchanged: true };
      return { updated: false, dry_run: dryRun, ...check };
    }
    if (dryRun) {
      return { updated: false, dry_run: true, would_update_to: check.remote, ...check };
    }
    const branch = info.branch.startsWith('HEAD') ? 'master' : info.branch;
    const fetchRes = await runGit(repoRoot, ['fetch', '--no-tags', 'origin', branch], { timeoutMs: 120000 });
    if (fetchRes.code !== 0) {
      throw new HttpError(502, 'FETCH_FAILED', `拉取上游失败：${(fetchRes.stderr || '').trim().split('\n').pop() || '未知错误'}`);
    }
    const resetRes = await runGit(repoRoot, ['reset', '--hard', `origin/${branch}`]);
    if (resetRes.code !== 0) {
      throw new HttpError(500, 'RESET_FAILED', `应用更新失败：${(resetRes.stderr || '').trim().split('\n').pop() || '未知错误'}`);
    }
    if (typeof rebuild === 'function') {
      await rebuild();
    }
    const after = ((await runGit(repoRoot, ['rev-parse', 'HEAD'])).stdout || '').trim();
    state.lastUpdate = { at: new Date().toISOString(), from: check.local, to: after, source };
    return { updated: true, before: check.local, after, checked_at: check.checked_at };
  } finally {
    state.updating = false;
  }
}

/** 定时自动更新：每个周期检查一次，有更新则拉取并重建索引。 */
export function startAutoUpdate({ repoRoot, rebuild, intervalMs, log = console }) {
  const timer = setInterval(async () => {
    try {
      const result = await applyUpdate(repoRoot, { rebuild, source: 'auto' });
      if (result.updated) {
        log(`[content-auto] 内容已更新：${result.before.slice(0, 7)} → ${result.after.slice(0, 7)}`);
      } else {
        log('[content-auto] 上游无更新');
      }
    } catch (err) {
      log(`[content-auto] 更新失败: ${err.message}`);
    }
  }, intervalMs);
  return timer;
}
