# HowToCook API

为 [HowToCook（程序员在家做饭指南）](https://github.com/Anduin2017/HowToCook) 提供的只读内容中间件：模糊搜索、结构化字段（原料 / 步骤 / 作者 / 时间……）、Markdown 与 HTML 全文，以及图片分发。

- 全部接口均为 **GET**，无鉴权、无请求体
- 响应统一为 `{ "data": ..., "meta": ... }`，错误为 `{ "error": { "code", "message" } }`
- 无数据库：启动时全量解析仓库内 Markdown 构建内存索引（约 300ms）

## 快速开始

独立部署（本仓库单独克隆）：

```bash
git clone https://github.com/LoCCai/HowToCook-API.git
cd HowToCook-API
npm install
npm start          # 首次启动自动从官方 HowToCook 仓库下载菜谱内容到 content/
```

已有 HowToCook 本地目录时，设置 `CONTENT_DIR` 直接复用（不触发下载）：

```bash
CONTENT_DIR=/path/to/HowToCook npm start
```

与 HowToCook 主仓库同仓开发时（本目录位于主仓库 `api/` 下），自动探测上一级目录的 `dishes/` 与 `tips/`，无需任何配置：

```bash
npm install
npm start
npm run dev        # 开发模式：监视内容变化自动重建索引
npm run smoke      # 冒烟测试（独立端口 37890）
```

Docker 部署与开机自启动见 [DEPLOY.md](./DEPLOY.md)。

配置见 `.env.example`（复制为 `.env` 生效，环境变量优先）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 监听地址 |
| `CONTENT_DIR` | 自动探测 | HowToCook 内容目录：显式指定 > 上一级目录 > `./content`（缺失时启动自动从官方仓库下载） |
| `ASSET_BASE_URL` | 空 | 资源反代地址，配置后默认图片模式变为 `proxy` |
| `DEFAULT_IMAGE_MODE` | `server`（配了反代则 `proxy`） | 默认图片模式 |
| `WATCH` | `0` | 内容变化自动重建索引 |
| `RATE_LIMIT_MAX` | `0`（不限） | 每窗口每 IP 最大请求数；公网部署建议 120 左右 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口（毫秒） |
| `TRUST_PROXY` | `0` | 部署在反向代理之后时设 1，限流按 X-Forwarded-For 识别真实 IP |
| `CONTENT_AUTO_UPDATE` | `0` | 定时检查上游并自动拉取更新（仅对 git 管理的内容目录生效，即未设 `CONTENT_DIR` 的场景） |
| `CONTENT_UPDATE_INTERVAL_MINUTES` | `1440` | 自动更新检查间隔（分钟，最小 10） |
| `UPDATE_TOKEN` | 空 | `POST /api/content/update` 的令牌；留空 = 不校验（本地/内网），公网部署务必设置 |

## 缓存与限流

- **缓存头**：详情/文档类 `Cache-Control: public, max-age=300`，列表/搜索/统计类 `max-age=60`，探活与随机类 `no-store`，静态图片 `max-age=86400`；响应同时带 Express 默认 ETag 供协商缓存
- **限流**：内存令牌桶，按 IP 限流（`/api/health` 与 `/assets` 豁免），超限返回 429 + `Retry-After` 与 `X-RateLimit-*` 头；默认关闭，公网部署设置 `RATE_LIMIT_MAX` 开启 |

## 接口一览

浏览器打开 `http://127.0.0.1:3000/api` 有自描述索引页；`/api/openapi.json` 提供 OpenAPI 3.1 描述。

| 端点 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查（索引统计） |
| `GET /api/categories` | 分类列表（中文名 + 数量） |
| `GET /api/recipes` | 菜谱列表 / 搜索 / 过滤 / 分页 |
| `GET /api/recipes/random` | 随机推荐（今天吃什么）：`count`、`seed`（相同 seed 结果可复现）、`category`、`difficulty` |
| `GET /api/menu` | 自动配一餐（荤+素+汤组合，HowToCook 经典场景）：`seed` 可复现整桌、`meat/vegetable/soup` 各槽数量（默认 1，上限 3）、`max_difficulty` |
| `GET /api/recipes/by-ingredients` | 按手头原料找菜：`have=鸡蛋,西红柿`（含常见别名如 番茄=西红柿），返回覆盖率与所缺原料；`mode=strict` 只返回原料齐全的 |
| `GET /api/recipes/:id/related` | 相似菜谱推荐（原料重合度 + 同分类加权） |
| `GET /api/recipes/:id` | 完整结构化 JSON（含 markdown + html 全文） |
| `GET /api/recipes/:id/meta` | 元信息（作者 / 编写时间 / 更新时间 / 难度 / 卡路里 / 封面） |
| `GET /api/recipes/:id/ingredients` | 原料与数量 |
| `GET /api/recipes/:id/tools` | 工具清单 |
| `GET /api/recipes/:id/steps` | 烹饪步骤（含 H3 分组） |
| `GET /api/recipes/:id/sections` | 原始 H2 段落（markdown + html） |
| `GET /api/recipes/:id/notes` | 附加内容 |
| `GET /api/recipes/:id/images` | 图片资源清单 |
| `GET /api/recipes/:id/markdown` | 完整 Markdown（图片地址按模式重写） |
| `GET /api/recipes/:id/html` | 正文 HTML 片段（仅正文，无 html/head/body） |
| `GET /api/recipes/:id/raw` | 原始 Markdown 文件 |
| `GET /api/search` | 聚合搜索：菜谱 + 技巧文档一次返回 |
| `GET /api/stats` | 全库统计（分类 / 难度 / 烹饪方式分布、最常用原料 Top 15；原料已归一：葱姜蒜拆分计数、豆瓣酱/生抽等合并规范名） |
| `GET /api/docs` | 交互式 API 文档（Swagger UI，读取 openapi.json） |
| `GET /api/content` | 内容版本信息（当前 commit / 上游地址 / 分支 / 工作区状态 / 最近检查与更新时间） |
| `GET /api/content/check` | 联网检查上游是否有新版本 |
| `POST /api/content/update` | 拉取上游更新并重建索引；`?dry_run=1` 仅检查；`UPDATE_TOKEN` 设置后需带 `X-Update-Token` 头 |
| `GET /api/tips` / `/api/tips/:id`（+ `meta` / `markdown` / `html` / `raw`） | 烹饪技巧文档 |
| `GET /assets/*` | 图片等静态资源分发 |

### 列表 / 搜索参数（`GET /api/recipes`）

| 参数 | 说明 |
| --- | --- |
| `q` | 模糊搜索：标题子串、**拼音全拼**（`hongshaorou`）、**拼音首字母**（`hsr`）、原料、正文 |
| `category` | 分类 id，见 `/api/categories` |
| `difficulty` / `max_difficulty` | 精确难度 / 难度上限(1-5) |
| `ingredient` | 包含某原料（子串匹配） |
| `sort` | `title` / `path` / `difficulty` / `created_at` / `updated_at`，`-` 前缀降序 |
| `page` / `page_size` | 分页，默认 20 条 / 页，最大 100 |
| `fields` | 仅返回指定顶层字段（逗号分隔），如 `fields=title,difficulty` |
| `image_mode` | 覆盖图片模式（见下） |

### ID 与查找

`:id` 可以是：

- 稳定 ID（仓库相对路径的 sha256 前 10 位，如 `e2a148eb6c`），增删其它文件不影响
- 仓库相对路径（URL 编码后），如 `dishes%2Fbreakfast%2F太阳蛋.md`

## 图片分发（重要）

菜谱内图片在仓库中均为同目录相对路径（`./成品.jpg`）。API 提供 `image_mode` 三种模式，任何端点可用 `?image_mode=` 覆盖：

| 模式 | 行为 |
| --- | --- |
| `relative` | 文档保持 `./成品.jpg` 原样；JSON 中另附 `recipe_dir`，由客户端自行拼接 |
| `server` | 重写为 `/assets/dishes/aquatic/小龙虾/成品.jpg`，由本服务分发（含 Content-Type / ETag / Cache-Control） |
| `proxy` | 重写为 `${ASSET_BASE_URL}/dishes/...`，由客户端从你的反代 / CDN 拉取；未配置 `ASSET_BASE_URL` 时请求报 400 |

结构化 JSON 中的每张图片都同时返回 `target`（原始引用）、`file`（仓库相对路径）与 `urls`（三种模式的完整地址），方便客户端按需取用。

## 元数据来源

- **作者 / 编写时间 / 更新时间 / 贡献者**：构建期从 `git log` 提取（首个非机器人提交为作者与编写时间）；无 git 环境回退文件时间戳
- **难度 / 卡路里**：解析正文中的 `预估烹饪难度：★★★★` 与 `预估卡路里：571 大卡`
- **烹饪方式**：标题与步骤的关键词启发式（炒 / 蒸 / 煮 / 烤……）
- **原料数量**：合并「必备原料和工具」与「计算」两段；无法结构化的行保留 `raw` 原文

## 安全

- 全只读 GET；静态资源与路径查找均做 `path.resolve` 后的仓库根边界校验，拒绝 `..` 穿越与非法扩展名
- 服务端不发起任何外部请求（不回源、不抓取），无 SSRF 面
- 响应带 `X-Content-Type-Options: nosniff` 等安全头；默认允许任意来源 CORS（只读公开数据）

## 目录结构

```
api/
  src/
    index.js          启动入口（含 watch）
    app.js            Express 组装
    config.js         环境配置
    lib/
      scanner.js      目录遍历 + git 元数据 + 内存索引
      parser.js       菜谱/文档结构化解析 + markdown-it 渲染
      search.js       子串 + 拼音搜索打分
      images.js       图片 URL 重写（三种模式）
      ids.js          稳定 ID
    routes/           recipes / tips / categories / assets / docs(/api 索引页与 openapi)
    middleware/       错误处理 / 安全头 / CORS
  scripts/smoke.js    冒烟测试
```

## License

Unlicense（与主仓库一致）。内容来自 HowToCook 社区贡献者。
