# 英语单词记忆 (English Vocab PWA)

一个**本地、离线**的英语单词记忆 PWA（渐进式 Web 应用）。打开网页即可使用，安装到 iPhone 主屏后可完全离线运行，所有数据保存在你自己的设备上。

---

## 项目简介

- **核心算法**：SM-2 间隔重复算法（基于艾宾浩斯遗忘曲线），自动安排每个单词的复习时间，记得越牢复习间隔越长。
- **词库规模**：内置约 **7500 个单词**，以开源的 ECDICT 英汉词典打底，并按 **COCA 真实词频排名**收录最常用的词；其中保留了最初人工精校的 441 个种子单词与一组 `programming` 编程主题词。
- **按词频学习**：新词的学习顺序按**真实词频从高到低**排列（最常用的词先学），让你优先掌握高频高价值词汇。
- **词频分层词汇量测试**：词汇量估算改用 **8 个词频段**（1-1000、1001-2000…7001-8000，每段假定 1000 词）分层抽样，比旧的按考试标签估算更科学。
- **卡片内容**：中英双语卡片，包含音标、TTS 发音（朗读）、例句、词根词缀等记忆辅助信息。
- **数据备份**：支持 JSON 导出 / 导入，方便备份进度或在设备之间迁移。
- **纯静态、无构建**：原生 ES 模块 + Service Worker + IndexedDB，**无需任何打包器或构建步骤**，仓库可以原样部署。

> **说明**：ECDICT 词频底库已完成；每个单词的**例句与词根词缀**正在按词频从高到低**逐步用 AI 补全**（高频词优先），目前高频部分的例句/词根仍在陆续完善中。

---

## 本地预览

本应用使用 Service Worker，**必须**通过 `http(s)://` 或 `localhost` 访问，**不能**直接用 `file://` 双击打开 HTML（否则 Service Worker 无法注册、离线功能失效）。

### 🚀 一键启动（推荐）

直接 **双击项目根目录里的 `start.command`**（macOS）。它会自动找一个空闲端口、启动本地服务并打开浏览器；要停止就按 `Ctrl+C` 或关闭弹出的终端窗口。

> 终端里也可运行：`./start.command`。首次若提示无法打开，在“系统设置 → 隐私与安全性”里允许一次即可。

### 手动方式

在项目根目录启动一个本地静态服务器即可：

```bash
# 在项目根目录执行（自带 Python3 的 macOS / Linux 直接可用）
python3 -m http.server 8000
```

然后浏览器打开：

```
http://localhost:8000
```

> 其他等价方式：`npx serve`、VS Code 的 Live Server 插件等，任意能提供 http 静态服务的工具都可以。

---

## 部署到 GitHub Pages (手动)

本项目是**纯静态站点，无需构建**，直接把整个文件夹推送到 GitHub 仓库再开启 Pages 即可。

> **重要**：以下命令需要**由你本人执行**。本项目的构建/生成流程**不会**自动 `git init`、自动提交或自动推送，也不会替你创建远程仓库。

### 步骤

1. 在 GitHub 上**新建一个空仓库**（例如命名为 `english-learn`，不要勾选自动生成 README）。

2. 在项目根目录执行（把 `<user>` 和 `<repo>` 换成你的用户名和仓库名）：

   ```bash
   git init
   git add .
   git commit -m "Initial commit: offline vocab PWA prototype"
   git branch -M main
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```

3. 在仓库页面开启 Pages：
   **Settings → Pages → Build and deployment → Source 选 “Deploy from a branch” → Branch 选 `main`，folder 选 `/ (root)` → Save**。

4. 等待 1–2 分钟，Pages 会给出站点地址：

   ```
   https://<user>.github.io/<repo>/
   ```

### 关于子路径 (base path)

GitHub Pages 的项目站点部署在子路径下（如 `https://<user>.github.io/english-learn/`），而不是域名根目录。

本应用**全部使用相对路径**（HTML/manifest/Service Worker 中均为 `./...`，`js/config.js` 还会通过 `import.meta.url` 动态推算 `BASE_PATH`），因此**在任意子路径下都能正常工作**，无需任何额外配置。

- 如果你将来绑定了**自定义域名**并部署在域名根目录，应用同样可以正常运行——相对路径在根目录和子路径下都成立。
- `.nojekyll` 文件用于关闭 GitHub Pages 的 Jekyll 处理，确保所有静态资源（包括以下划线开头的文件名）原样提供，不被改写或忽略。

---

## 添加到 iPhone 主屏 (装成 App)

让应用像原生 App 一样从主屏图标启动、全屏运行、离线可用：

1. 用 **Safari**（必须是 Safari，Chrome 等第三方浏览器在 iOS 上不支持添加 PWA）打开你的 Pages 地址：
   `https://<user>.github.io/<repo>/`
2. 点击底部的**分享按钮**（方框向上箭头）。
3. 在菜单中选择**「添加到主屏幕」**。
4. 确认名称后点「添加」，主屏上会出现应用图标。
5. 从**主屏图标**打开，即为独立全屏 App 体验。

> **离线说明**：首次需要**联网加载一次**，Service Worker 会缓存应用外壳与种子词库；之后即可**完全离线使用**（学习数据保存在设备本地的 IndexedDB 中）。

---

## 数据与备份

- 所有学习进度（单词、复习状态、设置等）都保存在**设备本地的 IndexedDB** 中，不会上传到任何服务器。
- 使用应用内的 **JSON 导出 / 导入**功能即可备份进度，或在不同设备 / 浏览器之间迁移数据。
- **注意**：在 Safari 中**清除网站数据 / 清除历史记录**会**清空本应用的全部进度**。重要数据请先用 JSON 导出做好备份。

---

## 更新 App

本应用通过 Service Worker 离线缓存，更新流程如下：

1. 修改代码后，把新版本推送到 GitHub 仓库（`git add . && git commit && git push`），GitHub Pages 会自动重新发布。
2. 在设备上**重新打开 App**：Service Worker 会在后台拉取新版本。
3. 如果发布了对缓存资源的改动而页面没刷新成新版，**提升缓存版本号**即可强制更新：
   同时修改 `service-worker.js` 里的 `CACHE_NAME` 和 `js/config.js` 里的 `CACHE_NAME`（两者必须保持一致，例如 `vocab-pwa-v1` → `vocab-pwa-v2`），再推送。激活时旧缓存会被自动清理。

---

## 项目结构

```
english-learn/
├── index.html            # 应用外壳 / 挂载点，加载 manifest 与入口脚本（相对路径）
├── manifest.json         # PWA 清单：名称、图标、start_url/scope 均为相对路径
├── service-worker.js     # 离线缓存（cache-first），预缓存应用外壳与种子词库
├── .nojekyll             # 关闭 GitHub Pages 的 Jekyll 处理，资源原样提供
├── README.md             # 本文档
├── css/
│   └── styles.css        # 应用样式
├── js/
│   ├── app.js            # 入口：注册 SW、哈希路由、首次启动播种数据
│   ├── config.js         # 运行时配置：BASE_PATH、每日上限、DB/缓存版本
│   └── db.js             # IndexedDB 封装；importWords() 通用导入钩子
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
4. **统一导入**：完整数据集仍通过现有的预留钩子 **`importWords(words, { source })`**（位于 `js/db.js`）导入 IndexedDB——与首次播种走同一条路径，扩容时无需改动数据写入逻辑。
