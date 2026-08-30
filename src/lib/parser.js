import path from 'node:path';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

export function renderMarkdown(text) {
  return md.render(text || '');
}

export function renderInlineMarkdown(text) {
  return md.renderInline(text || '');
}

/* ------------------------------------------------------------------ */
/* 常量与正则                                                            */
/* ------------------------------------------------------------------ */

const H1_RE = /^#\s+(.+?)\s*$/;
const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const DIFFICULTY_RE = /^预估烹饪难度[:：]\s*(★+)\s*$/;
const CALORIES_RE = /^预估卡路里[:：]\s*(\d+(?:\.\d+)?)\s*(大卡|千卡|卡|kcal)?\s*$/;
const FOOTER_RE = /^如果您遵循本指南/;
const LIST_ITEM_RE = /^[-*]\s+(.*)$/;
const ORDERED_ITEM_RE = /^(\d+)[.、]\s+(.*)$/;

// 原料图片引用：![alt](./x.jpg) 与 ![alt](./x.jpg "title")
const MD_IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const EXTERNAL_RE = /^(https?:)?\/\//i;

const TIME_RE = /(\d+(?:\.\d+)?(?:\s*[-~—到至]\s*\d+(?:\.\d+)?)?)\s*(个小时|小时|分钟|秒钟)/;

// 「计算」段的数量语法
const QTY_NUM = '\\d+(?:\\.\\d+)?(?:\\s*[-~—到至]\\s*\\d+(?:\\.\\d+)?)?';
const QTY_CN = '[一两二三四五六七八九十百半若干]+';
const UNIT_LIST =
  'g|kg|mg|ml|mL|L|克|千克|公斤|毫克|毫升|升|斤|两|卡|大卡|个|只|条|根|片|瓣|张|滴|块|杯|罐|瓶|袋|把|勺|匙|撮|粒|颗|枚|份|度|%';
const QTY_RE = new RegExp(`^(.+?)\\s+((?:(?:${QTY_NUM}|${QTY_CN})\\s*(?:${UNIT_LIST})?))$`);
const QTY_EQ_RE = /^(.+?)\s*[=＝]\s*(.+)$/;
const QTY_SENTENCE_RE = /^(.+?)的用量为\s*(.+?)。?$/;

// 工具启发式关键词（“必备原料和工具”段落同时混含两者）
const TOOL_RE =
  /锅|炉|烤箱|微波炉|电饭煲|电饭锅|空气炸锅|高压锅|筷|剪刀|砧板|案板|模具|秤|打蛋器|搅拌器|料理机|榨汁机|破壁机|刷子|夹子|锡纸|油纸|烘焙纸|吸油纸|厨房纸|保鲜膜|保鲜袋|吸管|容器|器皿|温度计|计时器|漏勺|汤勺|量杯|量勺|牙签|竹签|签子|压泥器|削皮器|开罐器|刨子|碗|盘[子]?|勺|铲|刀/;

// 烹饪方式标签（标题 + 步骤文本启发式）
const METHOD_KEYWORDS = [
  '蒸', '炒', '煮', '炸', '烤', '焖', '炖', '煎', '凉拌', '烧', '卤', '腌', '烙', '烩', '涮', '灼', '熬', '冻',
];

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

export function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function basenameWithoutExt(relPosixPath) {
  const base = relPosixPath.split('/').pop() || relPosixPath;
  return base.replace(/\.md$/i, '');
}

function isExternalUrl(target) {
  return EXTERNAL_RE.test(target) || /^(data:|mailto:)/i.test(target);
}

/**
 * 收集一段文本中的图片引用。
 * 返回 [{ alt, target, external }]，target 为文档中的原始写法。
 */
function collectImageRefs(text, altFallback) {
  const out = [];
  const seen = new Set();
  const push = (target, alt) => {
    const key = target + '\u0000' + alt;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ alt: alt || altFallback || '', target, external: isExternalUrl(target) });
  };
  for (const m of text.matchAll(MD_IMG_RE)) push(m[2], m[1]);
  for (const m of text.matchAll(HTML_IMG_RE)) push(m[1], 'img');
  return out;
}

/* ------------------------------------------------------------------ */
/* 原料 / 数量解析                                                      */
/* ------------------------------------------------------------------ */

/** 「必备原料和工具」列表项：- 名称（可选）（备注） */
export function parseRequirementItem(line) {
  const m = line.match(LIST_ITEM_RE);
  const raw = (m ? m[1] : line).trim();
  let text = raw;
  const optional = /[（(]\s*可选/.test(text);
  let note = null;
  // 剥离尾部括注（可选）/（说明文字），保留为 note
  const pm = text.match(/[（(]([^）)]{2,})[）)]\s*$/);
  if (pm && (/可选/.test(pm[1]) || pm[1].length >= 4)) {
    note = pm[1];
    text = text.slice(0, pm.index).trim();
  }
  const name = text.replace(/[（(]\s*可选[^）)]*[）)]/g, '').trim();
  return { name, optional, note, raw };
}

/**
 * 「计算」列表项：- 名称 数量（备注） / - 名称 = 数量 / - 名称的用量为 X / - 名称：数量。
 * 公式型数量（「1.5 个 * 份数，向上取整」「4ml * 鸡蛋/个」）会被规范化：
 * quantity 保留每份基准值（如「1.5 个」），per_serving=true，乘数说明进 quantity_note——
 * 这类数量语义即「每份数量」，可直接参与购物清单聚合与份数缩放。
 */
export function parseQuantityItem(line) {
  const m = line.match(LIST_ITEM_RE);
  const raw = (m ? m[1] : line).trim();
  let t = raw;
  let note = null;
  const pm = t.match(/[（(]([^）)]+)[）)]\s*$/);
  if (pm) {
    note = pm[1];
    t = t.slice(0, pm.index).trim();
  }

  let name;
  let quantity;
  const eq = t.match(QTY_EQ_RE);
  if (eq) {
    name = eq[1].trim();
    quantity = eq[2].trim().replace(/。$/, '');
  } else {
    const sentence = t.match(QTY_SENTENCE_RE);
    if (sentence) {
      name = sentence[1].trim();
      quantity = sentence[2].trim();
    } else {
      const qm = t.match(QTY_RE);
      if (qm) {
        name = qm[1].trim();
        quantity = qm[2].replace(/\s+/g, ' ').trim();
      } else {
        // 冒号分隔兜底：'名称：数量'（部分菜谱用冒号而非空格/等号）
        const cm = t.match(/^([^：:]+)[：:]\s*(.+)$/);
        if (cm) {
          name = cm[1].trim();
          quantity = cm[2].trim().replace(/。$/, '');
        } else {
          name = t.replace(/。$/, '');
          quantity = null;
        }
      }
    }
  }

  // 公式型数量规范化：'* 份数' 类即每份数量语义
  let per_serving = false;
  let quantity_note = null;
  if (quantity) {
    const fm = quantity.match(/^(.*?)\s*\*\s*(.+)$/);
    if (fm && fm[1].trim()) {
      quantity = fm[1].trim();
      quantity_note = fm[2].trim() || null;
      per_serving = true; // '* 份数'、'* 鸡蛋/个' 等均为每份基准语义
    }
  }
  return { name, quantity, per_serving, quantity_note, note, raw };
}

const normalizeName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

/**
 * 合并「必备原料和工具」与「计算」两段：
 * 前者给名称与可选标记，后者补数量与备注；仅在计算段出现的数量项也保留。
 */
export function mergeIngredients(requirementItems, quantityItems) {
  const byName = new Map();
  const result = [];
  for (const req of requirementItems) {
    const entry = {
      name: req.name,
      optional: req.optional,
      quantity: null,
      per_serving: false,
      quantity_note: null,
      note: req.note,
      raw: req.raw,
    };
    result.push(entry);
    byName.set(normalizeName(req.name), entry);
  }
  for (const q of quantityItems) {
    const key = normalizeName(q.name);
    const existing = byName.get(key);
    if (existing) {
      existing.quantity = q.quantity;
      existing.per_serving = !!q.per_serving;
      existing.quantity_note = q.quantity_note;
      if (!existing.note && q.note) existing.note = q.note;
    } else {
      const entry = {
        name: q.name,
        optional: false,
        quantity: q.quantity,
        per_serving: !!q.per_serving,
        quantity_note: q.quantity_note,
        note: q.note,
        raw: q.raw,
      };
      result.push(entry);
      byName.set(key, entry);
    }
  }
  return result;
}

export function isToolName(name) {
  return TOOL_RE.test(name);
}

/* ------------------------------------------------------------------ */
/* 菜谱解析                                                            */
/* ------------------------------------------------------------------ */

function parseTimeEstimate(text) {
  const m = text.match(TIME_RE);
  if (!m) return null;
  const rangeOrValue = m[1];
  const unit = m[2] === '个小时' ? '小时' : m[2];
  const nums = rangeOrValue.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (nums.length === 0) return null;
  const avg = nums.length === 2 ? (nums[0] + nums[1]) / 2 : nums[0];
  const minutes = unit === '小时' ? avg * 60 : unit === '秒钟' ? avg / 60 : avg;
  return { text: `${rangeOrValue.replace(/\s+/g, ' ')} ${unit}`.trim(), minutes: Math.round(minutes * 10) / 10 };
}

function detectMethods(title, stepsText) {
  const haystack = `${title}\n${stepsText}`;
  const found = [];
  for (const kw of METHOD_KEYWORDS) {
    if (haystack.includes(kw) && !found.includes(kw)) found.push(kw);
  }
  return found;
}

/**
 * 解析菜谱 markdown 为结构化对象。
 * 格式假设见仓库 dishes/template/示例菜；对缺段的旧菜谱保持容错（字段为空但不抛错）。
 */
export function parseRecipe(rawText, relPosixPath) {
  const text = stripHtmlComments(rawText);
  const lines = text.split(/\r?\n/);

  // ---- H1 标题与前言 ----
  let title = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(H1_RE);
    if (m) {
      title = m[1].replace(/的做法$/, '').trim();
      i++;
      break;
    }
  }
  if (!title) title = basenameWithoutExt(relPosixPath);

  const preambleParagraphs = [];
  const preambleImages = [];
  let difficulty = null;
  let difficultyDisplay = null;
  let calories = null;
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) {
      preambleParagraphs.push(paraBuf.join('\n').trim());
      paraBuf = [];
    }
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (H2_RE.test(line)) break;
    const dm = line.match(DIFFICULTY_RE);
    if (dm) {
      difficulty = dm[1].length;
      difficultyDisplay = dm[1];
      continue;
    }
    const cm = line.match(CALORIES_RE);
    if (cm) {
      calories = { value: Number(cm[1]), unit: cm[2] || '大卡' };
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    // 整行仅由图片（Markdown 图片语法或 <img> 标签）构成时，视为前言图片
    const remainder = line
      .replace(MD_IMG_RE, '')
      .replace(HTML_IMG_RE, '')
      .trim();
    const imgs = collectImageRefs(line);
    if (imgs.length && remainder === '') {
      preambleImages.push(...imgs.map((im) => ({ ...im, section: '前言' })));
      continue;
    }
    paraBuf.push(line);
  }
  flushPara();

  // ---- H2 段落切分 ----
  const sections = [];
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(H2_RE);
    if (h2) {
      current = { heading: h2[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue; // 段外的游离行（罕见），忽略
    current.lines.push(line);
  }
  const sectionBy = (name) => sections.find((s) => s.heading.includes(name));
  const sectionText = (s) => (s ? s.lines.join('\n').trim() : '');

  const requirementSection = sectionBy('必备原料');
  const calculationSection = sectionBy('计算');
  const stepsSection = sectionBy('操作');
  const extraSection = sectionBy('附加内容');

  // ---- 原料与工具 ----
  const requirementItems = (requirementSection?.lines || [])
    .filter((l) => LIST_ITEM_RE.test(l.trim()))
    .map((l) => parseRequirementItem(l.trim()));
  const quantityItems = (calculationSection?.lines || [])
    .filter((l) => LIST_ITEM_RE.test(l.trim()))
    .map((l) => parseQuantityItem(l.trim()));
  const ingredients = mergeIngredients(requirementItems, quantityItems);
  const tools = requirementItems
    .filter((it) => isToolName(it.name))
    .map((it) => ({ name: it.name, note: it.note, raw: it.raw }));

  // ---- 步骤（支持 H3 分组） ----
  const steps = [];
  let group = null;
  for (const line of stepsSection?.lines || []) {
    const h3 = line.match(H3_RE);
    if (h3) {
      group = h3[1];
      continue;
    }
    const om = line.trim().match(ORDERED_ITEM_RE);
    if (om) {
      steps.push({
        index: steps.length + 1,
        group,
        text: om[2].trim(),
        html: renderInlineMarkdown(om[2].trim()),
      });
    }
  }
  // 无序列表步骤的兜底（个别菜谱用 “- ” 描述步骤）
  if (steps.length === 0) {
    for (const line of stepsSection?.lines || []) {
      const lm = line.trim().match(LIST_ITEM_RE);
      if (lm) {
        steps.push({
          index: steps.length + 1,
          group,
          text: lm[1].trim(),
          html: renderInlineMarkdown(lm[1].trim()),
        });
      }
    }
  }

  // ---- 附加内容 ----
  const notes = [];
  let feedbackNote = null;
  let noteBuf = [];
  const flushNote = () => {
    if (noteBuf.length) {
      notes.push(noteBuf.join('\n').trim());
      noteBuf = [];
    }
  };
  for (const line of extraSection?.lines || []) {
    if (!line.trim()) {
      flushNote();
      continue;
    }
    if (FOOTER_RE.test(line.trim())) {
      feedbackNote = line.trim();
      continue;
    }
    noteBuf.push(line.trim().replace(/^[-*]\s+/, ''));
  }
  flushNote();

  // ---- 图片清单 ----
  const images = [...preambleImages];
  for (const s of sections) {
    const body = s.lines.join('\n');
    const refs = collectImageRefs(body, s.heading);
    // 去掉步骤 html 已计入的重复（按 target+alt 去重已在 collect 内按段生效，跨段保留）
    images.push(...refs.map((im) => ({ ...im, section: s.heading })));
  }
  const firstLocal = images.find((im) => !im.external);
  const cover = preambleImages.find((im) => !im.external) || firstLocal || null;

  // ---- 其它元信息 ----
  const description = preambleParagraphs.join('\n\n');
  const timeEstimate = parseTimeEstimate(description);
  const methods = detectMethods(title, steps.map((s) => s.text).join('\n'));

  return {
    type: 'recipe',
    title,
    description,
    difficulty,
    difficultyDisplay,
    calories,
    timeEstimate,
    methods,
    ingredients,
    tools,
    steps,
    notes,
    feedbackNote,
    images,
    cover,
    sections: sections.map((s) => ({ heading: s.heading, markdown: sectionText(s) })),
  };
}

/* ------------------------------------------------------------------ */
/* 通用文档解析（tips/）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 通用文档：标题 + 分层段落（保留 H2/H3 层级）。
 */
export function parseDocument(rawText, relPosixPath) {
  const text = stripHtmlComments(rawText);
  const lines = text.split(/\r?\n/);

  let title = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(H1_RE);
    if (m) {
      title = m[1].trim();
      i++;
      break;
    }
  }
  if (!title) title = basenameWithoutExt(relPosixPath);

  const introBuf = [];
  const sections = [];
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(H2_RE);
    const h3 = line.match(H3_RE);
    if (h2) {
      current = { heading: h2[1], level: 2, lines: [] };
      sections.push(current);
      continue;
    }
    if (h3) {
      current = { heading: h3[1], level: 3, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else introBuf.push(line);
  }

  const images = collectImageRefs(introBuf.join('\n')).map((im) => ({ ...im, section: '前言' }));
  for (const s of sections) {
    images.push(...collectImageRefs(s.lines.join('\n'), s.heading).map((im) => ({ ...im, section: s.heading })));
  }

  return {
    type: 'document',
    title,
    description: introBuf.join('\n').trim() || null,
    sections: sections.map((s) => ({
      heading: s.heading,
      level: s.level,
      markdown: s.lines.join('\n').trim(),
    })),
    images,
    cover: images.find((im) => !im.external) || null,
  };
}
