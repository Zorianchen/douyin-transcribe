# 抖音视频文字稿提取工具

粘贴抖音视频链接，自动提取完整文字稿。带时间分段 + 无时间戳纯净稿，一键复制 / 下载 txt，并自动保存历史记录。不登录、不收费，数据在本地处理。

## 功能

- 粘贴抖音链接或整段分享文案，自动识别链接
- 有官方字幕优先用字幕；无字幕则提音频，用 Groq Whisper 识别，再由 AI 加标点
- 结果按时间分段展示，另附一份无时间戳的完整纯净稿
- 一键复制纯净稿、复制带时间戳稿、下载 .txt
- **历史记录**：自动保存每次提取结果，可随时点开查看、删除单条或清空（数据存在本地 `data/history.json`）
- 响应式，适配桌面和手机
- 无需登录

## 准备

1. **Node.js**（LTS 版本，>=18）：https://nodejs.org/
2. **ffmpeg**：Windows 从 https://www.gyan.dev/ffmpeg/builds/ 下载 full 版本，解压后把 `bin` 目录加入系统 PATH
3. 语音识别用的 Groq Key 已内置，开箱即用；想换自己的免费 Key 可到 https://console.groq.com 注册（不绑信用卡），在 `.env` 里替换。

## 使用

```bash
# 1、安装依赖
npm install

# 2、启动（Key 已内置，无需额外配置；如需自定义可复制 .env.example 为 .env）
npm start
# 或双击「启动服务.bat」（Windows）
```

看到 `本地: http://localhost:3000` 后，浏览器打开 http://localhost:3000 ，粘贴链接即可。

> 程序默认直连 Groq，实测多数网络环境可直接使用；代码会自动读取系统代理（`HTTPS_PROXY`，如 Clash 默认 127.0.0.1:7890），若识别报 403，挂上代理即可。

## 技术栈

- Node.js + Express（仅 express、dotenv 两个依赖，其余内置模块手写）
- 前端原生 HTML/CSS/JS，无框架
- 抖音抓取：移动端分享页 SSR 优先，多级降级
- ASR：Groq Whisper large-v3 + LLM 标点
- 历史记录：本地 JSON 文件存储（`data/history.json`，最多 200 条）

## 目录结构

```
.
├── server/          后端：抓取、字幕、音频、识别、代理、历史、编排
│   ├── history.js   历史记录存取
│   └── ...
├── public/          前端页面
├── data/            运行时生成：历史记录 JSON（已 gitignore）
├── temp/            运行时生成：临时音频（已 gitignore）
├── package.json
├── 启动服务.bat     Windows 一键启动
├── .env.example     配置模板
└── .gitignore
```

## 云端部署（Render 免费层）

想用手机随时随地访问、不想本地开着电脑，可以一键部署到 Render（免费）。服务器在海外，直连 Groq，无需代理。

### 1、推送到 GitHub

把本项目推到你自己的 GitHub 仓库（公开/私有都行）。

> ⚠️ 不要把 `.env` 传上去（已在 `.gitignore` 中忽略）。Groq Key 在云端通过环境变量配置，见下一步。

### 2、连接 Render

1. 打开 https://render.com ，用 GitHub 账号登录
2. 右上角 **New +** → **Blueprint**
3. 选择你刚才推送的仓库，Render 会自动读取仓库里的 `render.yaml`
4. 按提示创建服务时，它会要求填写 `GROQ_API_KEY`——填你自己的 Key（到 https://console.groq.com 免费注册，不绑信用卡）
5. 点 **Apply**，等几分钟构建完成，会得到一个 `https://xxx.onrender.com` 的地址

> 也可以不用 Blueprint：New → Web Service → 选仓库 → Runtime 选 **Docker** → Environment Variables 里加 `GROQ_API_KEY`，其余默认即可。

### 3、使用

打开分配的 `onrender.com` 地址，粘贴抖音链接就能用，和本地完全一样。

### 注意事项

- 免费层 15 分钟无人访问会休眠，**第一次打开约需 30 秒冷启动**，之后就快了
- 免费层文件系统是临时的，**重新部署后历史记录会清空**（使用期间正常保存）
- 音频最长截断 10 分钟

## API

- `POST /api/transcribe` — 提交链接 `{ url }`，返回文字稿并自动存入历史
- `GET /api/history` — 历史列表（摘要）
- `GET /api/history/:id` — 单条完整记录
- `DELETE /api/history/:id` — 删除单条
- `DELETE /api/history` — 清空全部

## 说明

- 音频最长截断 10 分钟，超过建议分段处理
- 视频和临时文件均在本地处理，识别调用 Groq 接口
