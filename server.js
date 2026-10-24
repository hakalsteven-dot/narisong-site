/**
 * 轻量 AI 代理后端（零依赖，Node >= 18）
 *
 * 职责：
 *   1. 托管整个个人站静态文件
 *   2. 把 /api/chat 转发到 OpenRouter，API Key 只留在服务端
 *
 * 环境变量：
 *   OPENROUTER_API_KEY  必填（除非 MOCK_AI=1）
 *   PORT                默认 8788
 *   MOCK_AI=1           不需要 Key，返回内置示例，用于本地联调
 *   RATE_LIMIT_MAX      每 IP 每窗口最多请求数，默认 30
 *   RATE_LIMIT_WINDOW   窗口秒数，默认 600
 *   MAX_BODY_MB         请求体上限，默认 12
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const PORT = Number(process.env.PORT || 8788);
const API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const MOCK = process.env.MOCK_AI === '1' || (!API_KEY && process.env.ALLOW_NO_KEY === '1');
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const RATE_WINDOW = Number(process.env.RATE_LIMIT_WINDOW || 600) * 1000;
const MAX_BODY = Number(process.env.MAX_BODY_MB || 12) * 1024 * 1024;
const MAX_TOKENS_CAP = 4096;

const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';
const SITE_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

/** 只允许这些免费模型，避免误用付费模型产生账单 */
const MODELS = [
  { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL', vision: true, note: '视觉 · 推荐' },
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', vision: true, note: '视觉 · 备选' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B', vision: false, note: '文本 · 推荐' },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning', vision: false, note: '文本 · 快' },
  { id: 'cohere/north-mini-code:free', name: 'North Mini Code', vision: false, note: '代码' },
  { id: 'recursive/flint-v1.0:free', name: 'Flint 1.0', vision: false, note: '通用' },
];
const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

/* ------------------------------ 限流 ------------------------------ */
const hits = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW });
    return { ok: true, left: RATE_MAX - 1 };
  }
  rec.count += 1;
  return { ok: rec.count <= RATE_MAX, left: Math.max(0, RATE_MAX - rec.count), reset: rec.reset };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.reset) hits.delete(ip);
}, 60_000).unref();

/* ------------------------------ 工具 ------------------------------ */
function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* --------------------------- 请求校验 --------------------------- */
function hasImage(messages) {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'),
  );
}

function validate(body) {
  const raw = Array.isArray(body.messages) ? body.messages : null;
  if (!raw || raw.length === 0) throw { status: 400, message: 'messages 不能为空' };
  if (raw.length > 30) throw { status: 400, message: 'messages 条数过多' };

  const messages = raw.map((m, i) => {
    const role = m && m.role;
    if (!['system', 'user', 'assistant'].includes(role)) {
      throw { status: 400, message: `messages[${i}].role 非法` };
    }
    if (typeof m.content === 'string') {
      return { role, content: m.content };
    }
    if (Array.isArray(m.content)) {
      const parts = m.content.map((p) => {
        if (p && p.type === 'text' && typeof p.text === 'string') {
          return { type: 'text', text: p.text };
        }
        if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
          if (!/^data:image\/(png|jpe?g|webp);base64,/.test(p.image_url.url)) {
            throw { status: 400, message: '图片必须是 png/jpeg/webp 的 base64 data URL' };
          }
          return { type: 'image_url', image_url: { url: p.image_url.url } };
        }
        throw { status: 400, message: `messages[${i}] 中存在不支持的 content 分段` };
      });
      return { role, content: parts };
    }
    throw { status: 400, message: `messages[${i}].content 类型非法` };
  });

  const modelId = typeof body.model === 'string' ? body.model : MODELS[0].id;
  const model = MODEL_MAP.get(modelId);
  if (!model) throw { status: 400, message: '该模型不在白名单内' };
  if (hasImage(messages) && !model.vision) {
    throw { status: 400, message: `${model.name} 不支持图片输入，请换视觉模型` };
  }

  const temperature = Number.isFinite(body.temperature)
    ? Math.min(2, Math.max(0, body.temperature))
    : 0.6;
  const maxTokens = Number.isFinite(body.max_tokens)
    ? Math.min(MAX_TOKENS_CAP, Math.max(64, Math.floor(body.max_tokens)))
    : 2048;

  return { model, messages, temperature, maxTokens, task: body.task || 'text', stream: body.stream !== false };
}

/* ---------------------------- 上游调用 ---------------------------- */
function sseHead(res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
}

function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleChat(req, res) {
  const ip = clientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    return json(res, 429, { error: `请求过于频繁，请稍后再试（上限 ${RATE_MAX} 次 / ${Math.round(RATE_WINDOW / 60000)} 分钟）` });
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch (err) {
    return json(res, err.status || 400, { error: err.message });
  }

  let params;
  try {
    params = validate(body);
  } catch (err) {
    return json(res, err.status || 400, { error: err.message });
  }

  if (MOCK) return mockChat(res, params);
  if (!API_KEY) {
    return json(res, 503, {
      error: '服务端未配置 OPENROUTER_API_KEY。请在 .env 中填写后重启，或设置 MOCK_AI=1 使用演示模式。',
    });
  }

  sseHead(res);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let closed = false;
  req.on('close', () => {
    closed = true;
    controller.abort();
  });

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': SITE_URL,
        'X-Title': 'Narisong Portfolio Demos',
      },
      body: JSON.stringify({
        model: params.model.id,
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
        stream: true,
        // 部分模型默认输出推理过程，隐藏掉，只把正文流式返回给前端
        reasoning: { exclude: true },
      }),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      let msg = `上游返回 ${upstream.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) msg = parsed.error.message;
      } catch {
        if (text) msg = text.slice(0, 300);
      }
      sseSend(res, { type: 'error', message: msg });
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let emitted = 0;

    for await (const chunk of upstream.body) {
      if (closed) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          sseSend(res, { type: 'done' });
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta || {};
          if (typeof delta.content === 'string' && delta.content) {
            emitted += delta.content.length;
            sseSend(res, { type: 'delta', text: delta.content });
          }
          if (choice?.finish_reason) {
            sseSend(res, { type: 'finish', reason: choice.finish_reason });
          }
          if (parsed.error?.message) {
            sseSend(res, { type: 'error', message: parsed.error.message });
          }
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }

    if (emitted === 0) {
      sseSend(res, {
        type: 'error',
        message: '模型没有返回正文内容（可能只输出了推理过程，或该模型暂时不可用），请换一个模型再试。',
      });
    }
    sseSend(res, { type: 'done' });
    res.end();
  } catch (err) {
    const message = err.name === 'AbortError' ? '请求超时或已取消' : err.message || '上游请求失败';
    if (!res.writableEnded) {
      sseSend(res, { type: 'error', message });
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- 演示模式 --------------------------- */
const MOCK_TEXT = {
  code: {
    text: [
      '```html',
      '<div class="min-h-screen bg-neutral-950 flex items-center justify-center p-8 font-sans">',
      '  <div class="max-w-md w-full rounded-3xl bg-neutral-900 p-8 shadow-2xl ring-1 ring-white/10">',
      '    <p class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Demo mode</p>',
      '    <h1 class="mt-4 text-3xl font-semibold text-white">演示模式已连通</h1>',
      '    <p class="mt-3 text-sm leading-relaxed text-neutral-400">',
      '      这是 MOCK_AI=1 时返回的内置示例，用来验证前后端链路是否通畅。',
      '      配置 OPENROUTER_API_KEY 后重启服务，这里就会换成真实模型的结果。',
      '    </p>',
      '    <div class="mt-6 flex gap-3">',
      '      <button class="flex-1 rounded-full bg-white py-3 text-sm font-medium text-black">主要操作</button>',
      '      <button class="rounded-full border border-white/20 px-5 py-3 text-sm text-white">次要</button>',
      '    </div>',
      '  </div>',
      '</div>',
      '```',
    ].join('\n'),
  },
  storyboard: {
    text: JSON.stringify(
      {
        hook: '（演示模式）你以为 AI 产品经理在做加法，其实每天都在做减法。',
        cover: '做减法的人',
        titles: ['做减法才是 AI 产品经理的日常', '为什么功能越多，产品越难用', 'AI 产品经理的第一课'],
        tags: ['#AI产品经理', '#演示模式', '#产品思维', '#MOCK'],
        shots: [
          { no: 1, seconds: 3, visual: '黑底白字，快速推近一句话', caption: '功能越多 ≠ 产品越好', voiceover: '你以为 AI 产品经理在做加法？', keyword: '黑色背景,文字,推镜' },
          { no: 2, seconds: 6, visual: '分屏对比：左边塞满功能的界面，右边极简界面', caption: '取舍决定体验', voiceover: '其实每天都在做减法。', keyword: '分屏对比,极简界面,产品截图' },
          { no: 3, seconds: 7, visual: '白板手写三个待办，划掉两个', caption: '只留一件事', voiceover: '把三件事砍到一件，剩下的那件才做得动。', keyword: '白板,手写,划掉,清单' },
          { no: 4, seconds: 8, visual: '人物正面口播，浅景深', caption: '边界感就是产品力', voiceover: '因为模型能做的很多，用户能接住的很少。', keyword: '口播,正面,浅景深' },
          { no: 5, seconds: 6, visual: '结尾定格，出现提问文字', caption: '你会砍掉哪个功能？', voiceover: '如果只能留一个功能，你会留哪个？评论区聊聊。', keyword: '结尾定格,提问卡片,文字' },
        ],
        publishCopy: '做 AI 产品最难的不是接模型，是决定不做什么。\n你现在负责的产品，如果只能留一个功能，你留哪个？',
        note: '（演示模式）以上为内置示例数据，配置 API Key 后会由模型实时生成。',
      },
      null,
      2,
    ),
  },
  text: {
    text: '## 演示模式\n\n这是 MOCK_AI=1 返回的内置示例。配置 `OPENROUTER_API_KEY` 后即可调用真实模型。',
  },
};

async function mockChat(res, params) {
  sseHead(res);
  const canned = (MOCK_TEXT[params.task] || MOCK_TEXT.text).text;
  const step = 24;
  for (let i = 0; i < canned.length; i += step) {
    if (res.writableEnded) return;
    sseSend(res, { type: 'delta', text: canned.slice(i, i + step) });
    await new Promise((r) => setTimeout(r, 18));
  }
  sseSend(res, { type: 'finish', reason: 'stop' });
  sseSend(res, { type: 'done' });
  res.end();
}

/* ---------------------------- 静态文件 ---------------------------- */
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const abs = path.resolve(ROOT, '.' + rel);
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) {
    return json(res, 403, { error: '禁止访问' });
  }
  if (/(^|[/\\])\.(env|git|gitignore)/.test(rel)) {
    return json(res, 403, { error: '禁止访问' });
  }

  try {
    const info = await stat(abs);
    if (info.isDirectory()) return await serveStatic(req, res, pathname.replace(/\/?$/, '/'));
    const data = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    json(res, 404, { error: '未找到' });
  }
}

/* ------------------------------ 路由 ------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      mock: MOCK,
      key: Boolean(API_KEY),
      models: MODELS,
      limits: { maxTokens: MAX_TOKENS_CAP, rateMax: RATE_MAX, rateWindowSec: RATE_WINDOW / 1000 },
    });
  }

  if (url.pathname === '/api/models') {
    return json(res, 200, { models: MODELS });
  }

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') return json(res, 405, { error: '只支持 POST' });
    return handleChat(req, res);
  }

  if (url.pathname.startsWith('/api/')) {
    return json(res, 404, { error: '接口不存在' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: '方法不支持' });
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  const mode = MOCK ? 'MOCK（演示模式，不调用模型）' : API_KEY ? 'LIVE（已连接 OpenRouter）' : '未配置 KEY';
  console.log(`\n  个人站 + AI 代理已启动`);
  console.log(`  地址   http://localhost:${PORT}`);
  console.log(`  模式   ${mode}`);
  console.log(`  模型   ${MODELS.length} 个免费模型（白名单）`);
  console.log(`  限流   ${RATE_MAX} 次 / ${RATE_WINDOW / 60000} 分钟 / IP\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
