# 英语单词记忆 (English Vocab PWA)

一个部署在 **Cloudflare** 上的英语单词记忆 PWA（渐进式 Web 应用）。打开网页即可使用，可安装到 iPhone 主屏。学习**进度保存在 Cloudflare D1 云数据库**中，换设备 / 清空浏览器数据都不会丢（需联网读写进度）。

> **部署说明见 [`DEPLOY_CLOUDFLARE.md`](./DEPLOY_CLOUDFLARE.md)**——里面是你需要在 Cloudflare 上操作的完整步骤（建 D1、建表、建 Pages、绑定、部署）。

---

## 项目简介

- **核心算法**：SM-2 间隔重复算法（基于艾宾浩斯遗忘曲线），自动安排每个单词的复习时间，记得越牢复习间隔越长。
- **词库规模**：内置约 **7500 个单词**，以开源的 ECDICT 英汉词典打底，并按 **COCA 真实词频排名**收录最常用的词；其中保留了最初人工精校的 441 个种子单词与一组 `programming` 编程主题词。
- **按词频学习**：新词的学习顺序按**真实词频从高到低**排列（最常用的词先学），让你优先掌握高频高价值词汇。
- **词频分层词汇量测试**：词汇量估算改用 **8 个词频段**（1-1000、1001-2000…7001-8000，每段假定 1000 词）分层抽样，比旧的按考试标签估算更科学。
- **卡片内容**：中英双语卡片，包含音标、TTS 发音（朗读）、例句、词根词缀等记忆辅助信息。
- **云端进度**：学习进度（复习状态 + 设置）通过 Cloudflare Pages Functions 读写 **Cloudflare D1** 数据库；词库本身是静态资源放在 CDN。
- **数据备份**：支持 JSON 导出 / 导入，方便备份进度或迁移。
- **无打包构建**：前端是原生 ES 模块 + Service Worker；后端是 `/functions/api/*` 的 Pages Functions，**无需打包器**，仓库可原样部署到 Cloudflare Pages。

> **说明**：ECDICT 词频底库已完成；每个单词的**例句与词根词缀**正在按词频从高到低**逐步用 AI 补全**（高频词优先），目前高频部分的例句/词根仍在陆续完善中。

---

## 本地预览

> ⚠️ 迁移到 Cloudflare 后，本地预览**需要带 API**（D1）。旧的 `start.command` / `python3 -m http.server` 只能跑静态页面，**不会运行 `/api/*`**，进度无法读写。请用 Cloudflare 的 wrangler：

```bash
# 1) 给本地 D1 建表（只需一次）
wrangler d1 execute vocab --local --file=./schema.sql

# 2) 启动本地 Pages（自动识别 /functions 并注入本地 D1）
wrangler pages dev .
```

打开命令行提示的地址（通常 `http://localhost:8788`）。详见 [`DEPLOY_CLOUDFLARE.md`](./DEPLOY_CLOUDFLARE.md) 的「本地开发」一节。

---

## 部署到 Cloudflare

本项目部署到 **Cloudflare Pages（静态站点 + Functions）+ Cloudflare D1（数据库）**。

完整、可照着做的步骤（建 D1、建表、建 Pages 项目、绑定数据库、部署、验证）见独立文档：

👉 **[`DEPLOY_CLOUDFLARE.md`](./DEPLOY_CLOUDFLARE.md)**

最快路径（命令行）概览：

```bash
wrangler login
wrangler d1 create vocab                                  # 复制输出的 database_id 填进 wrangler.toml
wrangler d1 execute vocab --remote --file=./schema.sql    # 建表
wrangler pages project create english-learn --production-branch main
wrangler pages deploy . --project-name english-learn      # 部署，得到 https://english-learn.pages.dev
```

> 之后到 Dashboard → 该 Pages 项目 → Settings → Functions → D1 database bindings 确认绑定名为 **`DB`** 指向 **`vocab`**（Production / Preview 各一条）。

### 关于路径

本应用**全部使用相对路径**（`js/config.js` 通过 `import.meta.url` 动态推算 `BASE_PATH`），在 `*.pages.dev` 根目录、自定义域名根目录、任意子路径下都能正常工作，API 端点 `/api/*` 与站点同源、无需 CORS。

---

## 添加到 iPhone 主屏 (装成 App)

让应用像原生 App 一样从主屏图标启动、全屏运行、离线可用：

1. 用 **Safari**（必须是 Safari，Chrome 等第三方浏览器在 iOS 上不支持添加 PWA）打开你的 Pages 地址：
   `https://<user>.github.io/<repo>/`
2. 点击底部的**分享按钮**（方框向上箭头）。
3. 在菜单中选择**「添加到主屏幕」**。
4. 确认名称后点「添加」，主屏上会出现应用图标。
5. 从**主屏图标**打开，即为独立全屏 App 体验。

> **联网说明**：应用外壳与词库由 Service Worker 缓存，秒开；但**学习/保存进度需要联网**（进度走 Cloudflare D1，已选「纯在线」模式）。`/api/*` 不会被 Service Worker 缓存，进度始终从服务器读最新。

---

## 数据与备份

- 学习进度（复习状态、设置）保存在 **Cloudflare D1 云数据库**，通过同源 API `/api/review-states`、`/api/settings` 读写；词库本身是 CDN 上的静态文件。
- 换设备、清空浏览器数据**不会丢进度**（进度在云端，不在本地）。
- 使用应用内的 **JSON 导出 / 导入**功能可备份/迁移进度；也可用 `wrangler d1 export vocab --remote` 直接导出整库（见 [`DEPLOY_CLOUDFLARE.md`](./DEPLOY_CLOUDFLARE.md)）。
- 当前为**单一共享数据**模式：URL 谁打开都是同一份进度。若需多人隔离，见部署文档文末「同步密钥」方案。

---

## 更新 App

1. 修改代码后重新部署：`wrangler pages deploy . --project-name english-learn`（或 `git push`，若已连接 Git 自动发布）。
2. 在设备上**重新打开 App**：Service Worker 会在后台拉取新版本。
3. 若改了缓存资源而页面没刷新成新版，**提升缓存版本号**强制更新：同时修改 `service-worker.js` 与 `js/config.js` 里的 `CACHE_NAME`（两者必须一致，例如 `vocab-pwa-v8` → `vocab-pwa-v9`），再部署。激活时旧缓存会被自动清理。
4. 若改了数据库结构（`schema.sql`），用 `wrangler d1 execute vocab --remote --file=./schema.sql` 应用到云端 D1。

---

## 项目结构

```
english-learn/
├── index.html            # 应用外壳 / 挂载点，加载 manifest 与入口脚本（相对路径）
├── manifest.json         # PWA 清单：名称、图标、start_url/scope 均为相对路径
├── service-worker.js     # 静态资源缓存（cache-first）；/api/* 显式不缓存
├── DEPLOY_CLOUDFLARE.md  # ★ Cloudflare 部署完整步骤（你需要做的操作）
├── wrangler.toml         # Cloudflare Pages + D1 绑定配置（需填入 database_id）
├── schema.sql            # Cloudflare D1 建表脚本（review_state + settings）
├── README.md             # 本文档
├── functions/
│   └── api/
│       ├── review-states.js  # GET/PUT 复习状态（Pages Function -> D1）
│       ├── settings.js       # GET/PUT 设置（Pages Function -> D1）
│       └── reset.js          # POST 一次性清空进度
├── css/
│   └── styles.css        # 应用样式
├── js/
│   ├── app.js            # 入口：注册 SW、哈希路由、首启写入默认设置
│   ├── config.js         # 运行时配置：BASE_PATH、每日上限、缓存版本
│   └── db.js             # 云数据层：静态词库入内存 + 进度走 D1 API
├── data/
│   └── seed-words.json   # 内置约 7500 个单词（ECDICT 词频底库 + 441 个人工精校种子词 + programming 主题词，每词含 freq 词频排名）
├── tools/
│   ├── build_vocab.py        # 可复现的数据管道：读取 ECDICT + 精校种子词，生成 data/seed-words.json
│   ├── affixes.json          # 词根/前缀/后缀知识库（≥60 条，用于规则化标注词根词缀）
│   └── seed-words.original.json # 441 个人工精校种子词的原始来源（管道的唯一可信源，可复跑不被覆盖）
├── icons/
│   ├── icon-192.png      # PWA / 主屏图标 192×192
│   └── icon-512.png      # PWA / 主屏图标 512×512（含 maskable）
└── tests/
    └── srs.test.js       # SM-2 间隔重复算法单元测试
```

> 注：部分模块（如 `js/views/*`、`js/tts.js`、`js/settings.js`、`js/srs.js`、`tests/srs.test.js`）由相关任务陆续补充，文件树以实际仓库为准。

---

## 数据管道与后续路线

词库已通过可复现的数据管道扩展到约 **7500 词**：

1. **ECDICT 开源词库打底（已完成）**：用开源的 ECDICT 英汉词典（约 77 万行）作为基础词表，按 **COCA 真实词频**取最常用的约 7500 个词元（lemma，已剔除屈折变体），并联入编程/CS 主题词与最初的 441 个人工精校种子词。每个单词都带上真实词频排名 `freq`。生成脚本为 `tools/build_vocab.py`，在项目根目录运行：

   ```bash
   python3 tools/build_vocab.py        # 重新生成 data/seed-words.json 并打印统计
   ```

   - 管道**保留**全部 441 个精校种子词的 `id`、例句与词根词缀（学习进度按 `id` 关联，`id` 必须保持稳定）；新词从当前最大 `id` 之后继续 `wNNNN` 编号。
   - 词根词缀采用 `tools/affixes.json` 知识库做**规则化标注**，仅在能可靠匹配前缀/词根时标注，否则留空（不臆造）。
2. **按词频学习（已完成）**：`js/srs.js` 的每日新词队列按真实 `freq` 升序排列（最常用先学），词频缺失时回退到旧的标签分层；`js/vocab-estimate.js` 的词汇量测试改为 **8 个词频段**分层抽样与估算。
3. **AI 生成例句 / 词根词缀（进行中）**：在 ECDICT 底库之上，用 AI 按词频从高到低**逐步补全**每个单词的例句与词根词缀（高频词优先）；新词当前 `examples` 暂为空，随补全逐步填充。
4. **静态加载**：完整词库作为静态文件 `data/seed-words.json` 由 Cloudflare CDN 提供，应用启动时一次性读入内存（不进数据库）。备份恢复仍走 `js/db.js` 的 `importWords()` 钩子；扩容只需重跑 `build_vocab.py` 重新生成该 JSON 并重新部署。
