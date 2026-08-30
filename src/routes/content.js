import crypto from 'node:crypto';
import { Router } from 'express';
import { HttpError } from '../middleware/error.js';
import { getContentInfo, checkUpdate, applyUpdate } from '../lib/content-updater.js';
import { config } from '../config.js';

const router = Router();

function getStore(req) {
  return req.app.locals.store;
}

/** 弱令牌门：UPDATE_TOKEN 未设置时不校验（本地 / 内网部署）；设置了则必须匹配。 */
function requireUpdateToken(req) {
  if (!config.updateToken) return;
  const provided = req.get('x-update-token') || req.query.token || '';
  const expected = config.updateToken;
  const sameLength = provided.length === expected.length;
  const mismatch = sameLength ? !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected)) : true;
  if (mismatch) {
    throw new HttpError(403, 'INVALID_UPDATE_TOKEN', '缺少或错误的更新令牌：请携带 X-Update-Token 头（或 ?token=）');
  }
}

// GET /api/content —— 当前内容版本信息与更新器状态
router.get('/content', async (req, res, next) => {
  try {
    res.json({ data: await getContentInfo(getStore(req).repoRoot) });
  } catch (err) {
    next(err);
  }
});

// GET /api/content/check —— 联网检查上游是否有新版本
router.get('/content/check', async (req, res, next) => {
  try {
    res.json({ data: await checkUpdate(getStore(req).repoRoot) });
  } catch (err) {
    next(err);
  }
});

// POST /api/content/update[?dry_run=1] —— 拉取上游更新并重建索引
router.post('/content/update', async (req, res, next) => {
  try {
    requireUpdateToken(req);
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    const result = await applyUpdate(getStore(req).repoRoot, {
      rebuild: req.app.locals.rebuild,
      dryRun,
      source: 'manual',
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
