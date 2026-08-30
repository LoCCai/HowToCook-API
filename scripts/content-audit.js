/**
 * 内容数据质量审计：扫描内存索引，输出一份可交给上游
 * （Anduin2017/HowToCook）的 Markdown 报告。
 * 运行：npm run audit        （或 node scripts/content-audit.js）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/lib/scanner.js';
import { SLOT_CATEGORIES } from '../src/lib/discover.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const store = new Store(repoRoot);
await store.rebuild([]);

const recipes = store.listRecipes();
const FORMULA_QTY_RE = /\*\s*份数|份\s*\*/; // 「1.5 个 * 份数」类公式型数量
const CN_QTY_RE = /[一二三四五六七八九十百半若干]/;
const TOOL_HINT = /锅|炉|筷|刀|剪|秤|模具|碗|盘|勺|铲|锡纸|油纸|保鲜|打蛋器|榨汁|料理机/;

const missingDifficulty = [];
const missingCalories = [];
const missingImage = [];
const missingTime = [];
const formulaQty = [];
const cnQty = [];
const emptyIngredients = [];
const likelyMisfiled = [];
const suspiciousNames = [];

for (const r of recipes) {
  if (r.difficulty == null) missingDifficulty.push(r);
  if (r.calories == null) missingCalories.push(r);
  if (!r.cover) missingImage.push(r);
  if (r.timeEstimate == null) missingTime.push(r);
  if (!r.ingredients || r.ingredients.length === 0) emptyIngredients.push(r);

  for (const ing of r.ingredients || []) {
    const q = String(ing.quantity || '');
    if (FORMULA_QTY_RE.test(q)) {
      formulaQty.push({ recipe: r, name: ing.name, quantity: q });
    } else if (q && CN_QTY_RE.test(q) && !/\d/.test(q)) {
      cnQty.push({ recipe: r, name: ing.name, quantity: q });
    }
  }

  // 启发式：荤菜分类下被判定为素食 / 素菜分类下标题明显含肉（先剔除「鸡蛋」避免误伤）
  const titleNoEgg = r.title.replace(/鸡蛋/g, '');
  if (r.category === 'meat_dish' && (r.dietTags || []).includes('vegetarian')) likelyMisfiled.push(r);
  if (r.category === 'vegetable_dish' && /排骨|牛肉|羊肉|鸡块|鸡丁|鸡爪|鸡翅|鸡腿|鸭|鱼|虾|蟹|猪蹄|腊肉|火腿|猪肚|大肠/.test(titleNoEgg)) likelyMisfiled.push(r);
  // 名称含「汤」但不在汤分类（可能是羹类/汤菜，供上游核对）
  if (r.category !== 'soup' && /汤$/.test(r.title)) suspiciousNames.push(r);
}

// 池容量：周计划各槽位可支撑的天数（默认每槽每天 1 道）
const poolCapacity = Object.entries(SLOT_CATEGORIES).map(([slot, categories]) => {
  const count = recipes.filter((r) => categories.includes(r.category)).length;
  return { slot, categories: categories.join('+'), count, days7: count >= 7 ? '✓ 可支撑 7 天不重样' : `✗ 仅 ${count} 道，第 ${Math.ceil(count) + 1} 天起重复` };
});

const fmtList = (arr, n = 8) =>
  arr
    .slice(0, n)
    .map((x) => (typeof x === 'string' ? `- ${x}` : `- [${x.recipe.path}] ${x.name}：${x.quantity}`))
    .join('\n');
const countOrAll = (arr, n = 8) => `${arr.length} 处${arr.length > n ? '（以下仅列前 ' + n + '）' : ''}`;

const report = `# HowToCook 内容数据质量审计报告

> 由 HowToCook-API 的内容审计脚本生成（${new Date().toISOString()}）。
> 扫描范围：${recipes.length} 个菜谱 + ${store.tips.size} 篇技巧。以下问题均不影响阅读，
> 但会影响程序化消费（API 聚合、购物清单、份数缩放等场景）。

## 一、计划池容量（周计划不重样可支撑度）

| 槽位 | 参与分类 | 菜谱数 | 7 天每天 1 道 |
| --- | --- | --- | --- |
${poolCapacity.map((p) => `| ${p.slot} | ${p.categories} | ${p.count} | ${p.days7} |`).join('\n')}

## 二、结构化字段缺失

- 缺「预估烹饪难度」：${missingDifficulty.length} 道
- 缺「预估卡路里」：${missingCalories.length} 道
- 缺时间估计（简介中无「约 X 分钟」等）：${missingTime.length} 道
- 无任何图片：${missingImage.length} 道
- 「必备原料和工具」为空：${emptyIngredients.length} 道${emptyIngredients.length ? '\n' + fmtList(emptyIngredients.map((r) => r.path)) : ''}

${missingDifficulty.length ? `### 缺难度示例\n${fmtList(missingDifficulty.map((r) => r.path))}\n` : ''}
${missingCalories.length > 8 ? `### 缺卡路里示例\n${fmtList(missingCalories.map((r) => r.path))}\n` : ''}

## 三、数量写法（API 已兼容，此处仅作信息性统计）

以下两类写法 API 消费端已做兼容处理（公式型提取每份基准、中文数量词自动转数字），
不影响购物清单聚合与份数缩放；但为可读性与长期一致性，仍建议规范化。

1. **公式型数量**（${countOrAll(formulaQty)}）：如「1.5 个 * 份数，向上取整」，
   语义为每份数量，API 已提取基准值（per_serving=true）。
${formulaQty.length ? fmtList(formulaQty, 6) + '\n' : ''}
2. **中文数量词**（${countOrAll(cnQty)}）：如「两片」「半个」，API 已自动转数字。
${cnQty.length ? fmtList(cnQty, 6) + '\n' : ''}

## 四、疑似分类错位（供人工核对）

${likelyMisfiled.length ? likelyMisfiled.map((r) => `- ${r.path}（荤菜分类但原料未检出肉类，或素菜分类但标题含肉）`).join('\n') : '- 未发现'}
${suspiciousNames.length ? `\n### 标题以「汤」结尾但不在「汤与粥」分类\n${suspiciousNames.map((r) => `- ${r.path}`).join('\n')}\n` : ''}

## 五、建议向上游推进的事项（均为可选的信息性建议，消费端已兼容）

1. **数量写法**：公式型统一为「每份基准值」（保留取整说明在文字里），中文数量词改阿拉伯数字，
   提升人读一致性。
2. **补齐结构化行**：缺难度 / 卡路里 / 时间的菜谱按模板补齐。
3. **分类核对**：第四节列表逐条确认归属。
4. **早餐分类扩容**：当前早餐 ${poolCapacity.find((p) => p.slot === 'breakfast').count} 道，
   周计划每日含早餐时多样性有限，欢迎投稿。
`;

console.log(report);
console.error(`\n[audit] 扫描 ${recipes.length} 个菜谱完成`);
