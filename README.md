# 那日松 · 个人站 + AI 演示

单页个人站（`index.html`）加三个可交互 AI demo（`demos/`），共用一个小型 Node 后端转发模型请求。
同仓库还有一个原生 macOS 应用：`macos/` 目录下的 **Verbatim 语音输入**（Swift，独立构建，不依赖本站后端）。

后端是**零依赖**的，只用 Node 标准库，不需要 `npm install`。

```
.
├── index.html                 个人站（单文件，含 canvas 圆窗视觉）
├── server.js                  静态托管 + /api/chat 代理（零依赖）
├── package.json
├── .env.example
├── Dockerfile
├── demos/
│   ├── index.html             演示索引
│   ├── screenshot-to-code.html   截图 → HTML/Tailwind
│   ├── short-video.html          主题 → 短视频分镜表
│   ├── patterns.html             Prompt 模式库
│   └── verbatim-voice.html      macOS 应用简介页（链接到源码仓库）
└── macos/                     原生 macOS 应用：Verbatim 语音输入
    ├── Sources/VerbatimCore/  纯逻辑（可单测）
    ├── Sources/Verbatim/      应用层
    ├── Tests/                 可移植断言 + XCTest
    ├── scripts/               build-app.sh / test.sh
    └── README.md              构建与设计说明
```

---

## 本地运行

需要 Node >= 18。

### 1）先看效果（不花钱、不需要 Key）

```bash
MOCK_AI=1 node server.js
```

打开 http://localhost:8788 。状态灯显示「演示模式」，返回的是内置示例数据，用来验证前后端链路。

### 2）接真实模型

1. 去 [openrouter.ai](https://openrouter.ai/keys) 申请一个 API Key（本项目的模型列表全部是 `:free` 免费模型）
2. 复制 `.env.example` 为 `.env`，填入 `OPENROUTER_API_KEY`
3. 启动：

```bash
node --env-file=.env server.js
```

或者直接把变量给进程：

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxx node server.js
```

端口默认 8788，可用 `PORT` 覆盖。

---

## 模型白名单

只允许这些免费模型，避免误用付费模型产生账单：

| 模型 | 用途 |
| --- | --- |
| `nvidia/nemotron-3.5-super-vl:free` | 视觉，截图转代码默认 |
| `google/gemma-4-31b-it:free` | 视觉备选 |
| `nvidia/nemotron-3-super-120b-a12b:free` | 文本，分镜默认 |
| `nvidia/nemotron-3.5-lightning:free` | 文本，速度优先 |
| `cohere/north-mini-code:free` | 代码 |
| `recursive/flint-v1.0:free` | 通用 |

要增删模型，改 `server.js` 里的 `MODELS` 数组即可。
免费模型有速率限制，官方也说明可能排队；报 429 时换一个模型或稍等再试。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | 空 | 必填（除非走演示模式） |
| `PORT` | 8788 | 监听端口 |
| `PUBLIC_URL` | 自动 | 作为 OpenRouter 的 `HTTP-Referer` 上报 |
| `RATE_LIMIT_MAX` | 30 | 每 IP 每窗口最大请求数 |
| `RATE_LIMIT_WINDOW` | 600 | 限流窗口（秒） |
| `MAX_BODY_MB` | 12 | 请求体上限（图片 base64 较大） |
| `MOCK_AI=1` | — | 演示模式，不调用模型 |
| `ALLOW_NO_KEY` | 0 | 为 1 且无 Key 时自动进演示模式 |

---

## 部署

需要一个**能常驻 Node 进程**的平台。纯静态托管（GitHub Pages、Vercel 纯静态、Netlify 静态）跑不了 `server.js`，因为 Key 不能放在前端。

### Docker / 任意 VPS

```bash
docker build -t narisong-site .
docker run -d -p 8788:8788 -e OPENROUTER_API_KEY=sk-or-v1-xxxx --name narisong narisong-site
```

再挂一个反向代理（Nginx / Caddy）指向 `127.0.0.1:8788` 即可，建议开 HTTPS。
Nginx 场景下 `server.js` 已经发了 `X-Accel-Buffering: no`，流式输出不会被缓冲。

### Render / Railway / Zeabur / Fly.io

- Build：无需构建（没有依赖）
- Start：`node server.js`
- 环境变量：填 `OPENROUTER_API_KEY`
- 健康检查路径：`/api/health`

### 注意

- 免费实例休眠后再访问，第一次请求会慢几秒。
- 如果用国内服务器，OpenRouter 的连通性需要自己验证。

---

## 安全设计

- Key 只存在服务端，前端从不接触
- 模型白名单 + `max_tokens` 上限（4096），防止被刷成高额账单
- 每 IP 限流（默认 30 次 / 10 分钟）
- 请求体上限 12MB，防大图打爆内存
- 只接受 png/jpeg/webp 的 base64 data URL
- 静态文件做了路径穿越防护，`.env` / `.git` 一律 403
- 无 CORS 头，只允许同源调用
- 生成的 HTML 在 `sandbox="allow-scripts"` 的 iframe 里预览，拿不到父页面

---

## 改内容

### 个人站文案

打开 `index.html`，搜 `const SECTIONS`（约第 368 行）。四个章节：关于 / 作品集 / 文章 / 联系。

作品集里 `items` 每项：`cat` 分类（要和 `filters` 里同名才会归到那一类）、`title`、`sub`、`meta`、`link`。
`link` 留空的条目渲染成不可点的纯文本行，适合没有公开链接的企业项目。

目前 9 条：`demos/` 里的四个 `vibe coding` 条目可点；两个 `AI 产品` 是企业项目（只有结论口径，无外链）；
`Bravl 训练计划`、`phone-agent` 是自有项目；`Coze Agent 评测` 是实习经历。

`文章` 章节的 `items` 现在是空数组，页面显示 `empty` 里的空状态文案；有稿子按注释里的格式补进去即可。

其中 `Verbatim 语音输入` 不是一个网页 demo，点击进入的是简介页，源码在独立的 macOS 项目里：
仓库地址写在 `demos/verbatim-voice.html` 顶部的 `REPO_URL` 常量，换仓库只改这一行（**仓库目前还没公开，链接是 404**）。

### 给 demo 换成真实作品画面

任意章节可加一行 `media`，圆窗里就会显示真实图片/视频：

```js
media: { type: 'image', src: 'assets/work.jpg' }
media: { type: 'video', src: 'assets/aigc.mp4' }
```

### 加新的 Prompt 模式

直接改 `demos/patterns.html` 里的 `BUILTIN` 数组；或者在页面上「编辑模板骨架 → 保存为新模式」，存到浏览器本地，再用「导出」拿 JSON。

---

## 已知限制

- 免费模型质量不稳定，输出偶尔不合 JSON；`short-video.html` 有容错解析，仍失败时可展开「查看模型原始输出」排查。
- 截图转代码的**预览**依赖 `cdn.tailwindcss.com` 注入 Tailwind（只在沙箱 iframe 内），断网时预览会失去样式，但导出的代码不受影响。
- 图片会先压到 1280px 宽再上传，细节极多的界面可能还原度下降。
- 限流是单进程内存实现，多实例部署时需要换成 Redis 之类的共享存储。
