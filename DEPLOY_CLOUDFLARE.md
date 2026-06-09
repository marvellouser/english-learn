# 部署到 Cloudflare（完整步骤）

本应用已从「GitHub Pages + 本地缓存」迁移到「**Cloudflare Pages + Cloudflare D1**」：

| 内容 | 存放位置 | 说明 |
|---|---|---|
| 应用代码 + 7500 词词库（静态） | **Cloudflare Pages**（CDN） | `index.html` / `js/` / `css/` / `data/seed-words.json` 等静态资源 |
| 学习进度（复习状态 reviewState） | **Cloudflare D1** | 通过 `/api/review-states` 读写 |
| 设置（每日上限、难度配比、streak…） | **Cloudflare D1** | 通过 `/api/settings` 读写 |
| 后端 API | **Cloudflare Pages Functions**（`/functions/api/*`） | 与站点同源，无需 CORS |

> **数据模型说明**：词库是所有人相同的「静态参考数据」，留在 CDN，不进数据库；只有**你的进度**进 D1。某个单词在 D1 里**没有行**＝它是一张全新卡片（前端在内存里临时合成初始状态），所以**首次部署不会插入 7500 行**，只有真正学过的单词才会写入一行。

本项目当前为**单一共享数据**模式（不分账号、URL 谁打开都是同一份进度）。若日后 URL 公开且想隔离，再加「同步密钥」即可（见文末）。

---

## 0. 前置准备

- 一个 **Cloudflare 账号**（你已注册）。
- 本机已安装 **Node.js**（用于运行 `wrangler` CLI）。检查：`node --version`。
- **Wrangler CLI**（Cloudflare 官方命令行）。无需全局安装，可用 `npx wrangler ...`；也可全局装：

  ```bash
  npm install -g wrangler
  wrangler --version
  ```

- 登录（会打开浏览器授权一次）：

  ```bash
  wrangler login
  ```

> 下面提供两条路线，**任选其一**：
> - **路线 A（推荐）**：纯命令行，最快，一次跑通。
> - **路线 B**：连接 GitHub 仓库 + Dashboard 图形界面，之后 `git push` 自动发布。

---

## 路线 A：Wrangler 命令行（推荐）

### A1. 创建 D1 数据库

在项目根目录执行：

```bash
wrangler d1 create vocab
```

输出里会有一段：

```
[[d1_databases]]
binding = "DB"
database_name = "vocab"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把其中的 **`database_id`** 复制下来。

### A2. 把 database_id 填进 wrangler.toml

打开项目根目录的 `wrangler.toml`，把这一行的占位符替换成上一步的真实 id：

```toml
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"   # ← 改成你的 id
```

### A3. 建表（应用 schema.sql 到云端 D1）

```bash
wrangler d1 execute vocab --remote --file=./schema.sql
```

> `--remote` 表示作用到 Cloudflare 云端的 D1（不是本机）。成功后会创建 `review_state` 和 `settings` 两张表。

### A4. 创建 Pages 项目并部署

```bash
# 第一次：创建 Pages 项目（生产分支名随意，这里用 main）
wrangler pages project create english-learn --production-branch main

# 部署当前目录（. 表示整个仓库根目录作为静态站点；/functions 会被自动识别）
wrangler pages deploy . --project-name english-learn
```

部署完成后命令行会打印站点地址，形如：

```
https://english-learn.pages.dev
```

> `wrangler pages deploy` 会读取 `wrangler.toml` 里的 `[[d1_databases]]` 绑定，所以 Functions 在生产环境就能拿到 `env.DB`。

### A5. 确认 D1 绑定已生效（保险一步）

进入 **Cloudflare Dashboard → Workers & Pages → 你的 `english-learn` 项目 → Settings → Functions → D1 database bindings**，确认有一条：

- **Variable name（绑定名）**：`DB`
- **D1 database**：`vocab`

如果没有，就点 **Add binding** 手动加上（Production 和 Preview 各加一条），然后 **Retry deployment / 重新部署一次**。

✅ 打开 `https://english-learn.pages.dev` 就能用了。以后要更新，重复 `wrangler pages deploy . --project-name english-learn` 即可。

---

## 路线 B：连接 GitHub 仓库 + Dashboard（之后 push 自动发布）

### B1. 先建库 + 建表（仍需命令行做一次）

```bash
wrangler login
wrangler d1 create vocab
# 把输出的 database_id 填进 wrangler.toml（同 A2）
wrangler d1 execute vocab --remote --file=./schema.sql
```

> D1 的创建与建表目前必须用 CLI（或 Dashboard 的 D1 控制台手动粘贴 `schema.sql` 内容执行）。

### B2. 推送代码到 GitHub

```bash
git add .
git commit -m "Migrate to Cloudflare Pages + D1"
git push
```

### B3. 在 Dashboard 连接仓库创建 Pages 项目

1. **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**。
2. 选择你的 GitHub 仓库，授权。
3. 构建设置（**关键**，本项目无构建步骤）：
   - **Framework preset**：`None`
   - **Build command**：留空
   - **Build output directory**：`/`（根目录）
4. 点 **Save and Deploy**，等待首次部署完成。

### B4. 绑定 D1 数据库

进入该 Pages 项目 → **Settings → Functions → D1 database bindings → Add binding**：

- **Variable name**：`DB`
- **D1 database**：`vocab`

给 **Production** 和 **Preview** 各加一条。然后到 **Deployments** 里 **Retry deployment**（让绑定对已有部署生效）。

✅ 之后每次 `git push` 到生产分支，Cloudflare 会自动重新部署。

---

## 本地开发 / 预览（带 API）

> ⚠️ 旧的 `start.command` / `python3 -m http.server` 只能跑静态页面，**不会运行 `/api/*`**，所以学习进度无法读写。要在本地完整预览（含 D1），用 wrangler：

```bash
# 1) 给“本地 D1”建表（只需一次；--local 作用于 .wrangler 本地状态）
wrangler d1 execute vocab --local --file=./schema.sql

# 2) 启动本地 Pages（自动识别 /functions，并按 wrangler.toml 注入本地 D1 绑定）
wrangler pages dev .
```

打开命令行提示的地址（通常是 `http://localhost:8788`）。本地 D1 数据存在项目的 `.wrangler/` 目录（已在 `.gitignore` 忽略）。

---

## 验证部署是否成功

部署后，直接用浏览器或 curl 测 API：

```bash
# 应返回 [] 或已有进度数组
curl https://english-learn.pages.dev/api/review-states

# 应返回 {} 或已存设置对象
curl https://english-learn.pages.dev/api/settings
```

- 返回 **JSON（`[]` / `{}`）** → 后端 + D1 绑定正常。
- 返回 **HTML 或 500** → D1 绑定没生效，回到 A5 / B4 检查绑定名是否为 `DB`，并重试部署。

然后打开站点学习几张卡片，刷新页面，进度仍在 → 全链路 OK。也可在 Dashboard → D1 → `vocab` → 用控制台跑 `SELECT * FROM review_state;` 直接看到写入的行。

---

## 数据备份 / 迁移

- 应用「设置」页里的 **JSON 导出 / 导入** 仍然可用：导出会把当前进度（来自 D1）打包成一个 `.json` 文件；导入会把进度写回 D1。
- 直接操作数据库：
  ```bash
  # 导出整库
  wrangler d1 export vocab --remote --output=vocab-backup.sql
  # 任意 SQL 查询
  wrangler d1 execute vocab --remote --command="SELECT COUNT(*) FROM review_state;"
  ```

---

## 添加到 iPhone 主屏（仍然支持）

迁移后仍是 PWA：用 **Safari** 打开 `https://english-learn.pages.dev`（或你的自定义域名）→ 分享 → 「添加到主屏幕」。
区别：现在**进度保存在 Cloudflare**，换设备/清空浏览器数据都不会丢；代价是**学习/保存进度需要联网**（已选「纯在线」模式）。

---

## （可选）将来要做「多人 / 隐私隔离」

当前是单一共享数据。若 URL 公开又想各用各的，可加一个「同步密钥」：

1. 给 `review_state` / `settings` 两表各加一列 `user_key TEXT`，主键改为 `(user_key, id)` / `(user_key, key)`。
2. 前端首次生成一个随机 key 存 `localStorage`，每次请求带 `X-Sync-Key` 头；Functions 用它过滤 / 写入。
3. 设置页展示该 key，换设备填同一个 key 即可共享同一份进度。

需要时再说，我可以帮你加。
