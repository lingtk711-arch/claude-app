'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(APP_DIR, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const HOST = '127.0.0.1';
const START_PORT = Number(process.env.PORT) || 8787;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';
const PERMISSION_MODES = ['acceptEdits', 'plan', 'default', 'bypassPermissions'];
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/** sessionId -> child process, so we can stop a running turn */
const running = new Map();

// ---------------------------------------------------------------- utilities

function resolveClaudeBin() {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return 'claude.exe';
}

function ensureData() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_FILE)) fs.writeFileSync(PROJECTS_FILE, '[]');
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]');
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function sanitizeName(name) {
  const base = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return base.slice(-120) || 'file';
}

function nameFromMime(mime) {
  const ext = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  }[mime];
  return 'pasted' + (ext || '');
}

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    return sendError(res, 403, '禁止访问');
  }
  fs.readFile(full, (err, data) => {
    if (err) return sendError(res, 404, '文件不存在');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- API: config

function handleConfig(req, res) {
  let baseUrlHost = '';
  try {
    baseUrlHost = new URL(process.env.ANTHROPIC_BASE_URL || '').host;
  } catch {}
  sendJSON(res, 200, {
    model: DEFAULT_MODEL,
    permissionMode: DEFAULT_PERMISSION_MODE,
    permissionModes: PERMISSION_MODES,
    configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    baseUrlHost,
    claudeBin: resolveClaudeBin(),
  });
}

// ---------------------------------------------------------------- API: projects

function handleProjectsList(req, res) {
  sendJSON(res, 200, readJSON(PROJECTS_FILE, []));
}

async function handleProjectCreate(req, res) {
  const body = await readJSONBody(req);
  const projectPath = String(body.path || '').trim();
  if (!projectPath) return sendError(res, 400, '请填写文件夹路径');
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return sendError(res, 400, '文件夹不存在：' + projectPath);
  }
  const abs = path.resolve(projectPath);
  const projects = readJSON(PROJECTS_FILE, []);
  if (projects.some((p) => path.resolve(p.path) === abs)) {
    return sendError(res, 409, '该项目已存在');
  }
  const project = {
    id: crypto.randomUUID(),
    name: String(body.name || '').trim() || path.basename(abs) || abs,
    path: abs,
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  writeJSON(PROJECTS_FILE, projects);
  sendJSON(res, 200, project);
}

function handleProjectDelete(req, res, id) {
  const projects = readJSON(PROJECTS_FILE, []);
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return sendError(res, 404, '项目不存在');
  writeJSON(PROJECTS_FILE, next);
  const sessions = readJSON(SESSIONS_FILE, []).filter((s) => s.projectId !== id);
  writeJSON(SESSIONS_FILE, sessions);
  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------- API: sessions

function handleSessionsList(req, res, query) {
  const projectId = query.get('projectId');
  const all = readJSON(SESSIONS_FILE, []);
  const list = projectId ? all.filter((s) => s.projectId === projectId) : all;
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  sendJSON(res, 200, list);
}

async function handleSessionCreate(req, res) {
  const body = await readJSONBody(req);
  const projectId = body.projectId;
  const projects = readJSON(PROJECTS_FILE, []);
  const project = projects.find((p) => p.id === projectId);
  if (!project) return sendError(res, 404, '项目不存在');
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    projectId,
    claudeSessionId: crypto.randomUUID(),
    title: '新会话',
    firstTurnDone: false,
    createdAt: now,
    updatedAt: now,
  };
  const sessions = readJSON(SESSIONS_FILE, []);
  sessions.push(session);
  writeJSON(SESSIONS_FILE, sessions);
  sendJSON(res, 200, session);
}

async function handleSessionUpdate(req, res, id) {
  const body = await readJSONBody(req);
  const sessions = readJSON(SESSIONS_FILE, []);
  const session = sessions.find((s) => s.id === id);
  if (!session) return sendError(res, 404, '会话不存在');
  if (typeof body.title === 'string' && body.title.trim()) session.title = body.title.trim();
  session.updatedAt = new Date().toISOString();
  writeJSON(SESSIONS_FILE, sessions);
  sendJSON(res, 200, session);
}

function handleSessionDelete(req, res, id) {
  const sessions = readJSON(SESSIONS_FILE, []);
  const next = sessions.filter((s) => s.id !== id);
  if (next.length === sessions.length) return sendError(res, 404, '会话不存在');
  writeJSON(SESSIONS_FILE, next);
  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------- API: upload

async function handleUpload(req, res) {
  const body = await readJSONBody(req);
  const dataUrl = String(body.dataUrl || '');
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (!m) return sendError(res, 400, '附件数据格式错误');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) return sendError(res, 413, '附件过大（上限 40MB）');
  const displayName = String(body.name || nameFromMime(mime));
  const fileName = `${Date.now()}-${sanitizeName(displayName)}`;
  const full = path.join(UPLOADS_DIR, fileName);
  await fsp.writeFile(full, buf);
  sendJSON(res, 200, {
    name: displayName,
    path: full,
    size: buf.length,
    mime,
  });
}

// ---------------------------------------------------------------- API: browse

async function handleBrowse(req, res, query) {
  let target = String(query.get('path') || '').trim() || os.homedir();
  try {
    target = path.resolve(target);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) return sendError(res, 400, '不是文件夹');
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    sendJSON(res, 200, {
      path: target,
      parent: parent === target ? null : parent,
      dirs,
    });
  } catch (err) {
    sendError(res, 400, '无法读取目录：' + err.message);
  }
}

// ---------------------------------------------------------------- API: chat

function buildPrompt(message, attachments) {
  const text = String(message || '').trim();
  if (!attachments || !attachments.length) return text || '(空消息)';
  const lines = attachments.map((a) => `- ${a.path}`).join('\n');
  return `以下是我附上的文件，请先用 Read 工具查看它们，再回答我的问题：\n${lines}\n\n${text}`;
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch {
    return sendError(res, 400, '请求体解析失败');
  }
  const { sessionId, message, attachments = [], model, permissionMode } = body;

  const sessions = readJSON(SESSIONS_FILE, []);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return sendError(res, 404, '会话不存在');

  const project = readJSON(PROJECTS_FILE, []).find((p) => p.id === session.projectId);
  if (!project) return sendError(res, 404, '项目不存在');

  let cwd = project.path;
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a dir');
  } catch {
    return sendError(res, 400, '项目文件夹不存在：' + cwd);
  }

  if (running.has(sessionId)) {
    return sendError(res, 409, '该会话正在生成中，请先停止');
  }

  const mode = PERMISSION_MODES.includes(permissionMode) ? permissionMode : DEFAULT_PERMISSION_MODE;
  const useModel = String(model || DEFAULT_MODEL);

  const args = [
    '-p',
    buildPrompt(message, attachments),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    useModel,
    '--permission-mode',
    mode,
    '--add-dir',
    UPLOADS_DIR,
  ];
  if (session.firstTurnDone && session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
  } else {
    args.push('--session-id', session.claudeSessionId);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const child = spawn(resolveClaudeBin(), args, {
    cwd,
    env: { ...process.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(sessionId, child);

  sse(res, { type: 'start', sessionId, model: useModel, permissionMode: mode, cwd });

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        sse(res, { type: 'claude', payload: JSON.parse(line) });
      } catch {
        sse(res, { type: 'raw', text: line });
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    const clean = String(text)
      .split('\n')
      .filter((l) => l && !/no stdin data received/i.test(l) && !/redirect stdin explicitly/i.test(l))
      .join('\n')
      .trim();
    if (clean) sse(res, { type: 'stderr', text: clean });
  });

  child.on('error', (err) => {
    sse(res, { type: 'error', message: '无法启动 claude：' + err.message });
  });

  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    if (buf.trim()) {
      try {
        sse(res, { type: 'claude', payload: JSON.parse(buf.trim()) });
      } catch {
        sse(res, { type: 'raw', text: buf.trim() });
      }
    }
    sse(res, { type: 'exit', code: code == null ? 0 : code });
    running.delete(sessionId);
    try {
      res.end();
    } catch {}
  };

  child.on('close', (code) => finish(code));

  req.on('close', () => {
    running.delete(sessionId);
    try {
      child.kill();
    } catch {}
    finished = true;
  });

  // mark session as started + title from first message
  const fresh = readJSON(SESSIONS_FILE, []);
  const s = fresh.find((x) => x.id === sessionId);
  if (s) {
    if (!s.firstTurnDone) {
      s.firstTurnDone = true;
      const t = String(message || '').trim().replace(/\s+/g, ' ');
      if (t && (!s.title || s.title === '新会话')) s.title = t.slice(0, 40);
    }
    s.updatedAt = new Date().toISOString();
    writeJSON(SESSIONS_FILE, fresh);
  }
}

function handleChatStop(req, res) {
  let killed = false;
  for (const [sid, child] of running.entries()) {
    try {
      child.kill();
      killed = true;
      running.delete(sid);
    } catch {}
  }
  sendJSON(res, 200, { ok: true, killed });
}

// ---------------------------------------------------------------- router

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  try {
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/config' && method === 'GET') return handleConfig(req, res);

      if (pathname === '/api/projects' && method === 'GET') return handleProjectsList(req, res);
      if (pathname === '/api/projects' && method === 'POST') return await handleProjectCreate(req, res);
      const projMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
      if (projMatch && method === 'DELETE') return handleProjectDelete(req, res, projMatch[1]);

      if (pathname === '/api/sessions' && method === 'GET') return handleSessionsList(req, res, url.searchParams);
      if (pathname === '/api/sessions' && method === 'POST') return await handleSessionCreate(req, res);
      const sesMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (sesMatch && method === 'PATCH') return await handleSessionUpdate(req, res, sesMatch[1]);
      if (sesMatch && method === 'DELETE') return handleSessionDelete(req, res, sesMatch[1]);

      if (pathname === '/api/upload' && method === 'POST') return await handleUpload(req, res);
      if (pathname === '/api/browse' && method === 'GET') return await handleBrowse(req, res, url.searchParams);
      if (pathname === '/api/chat' && method === 'POST') return await handleChat(req, res);
      if (pathname === '/api/chat/stop' && method === 'POST') return handleChatStop(req, res);

      return sendError(res, 404, '未知接口');
    }

    if (method === 'GET') return serveStatic(req, res, pathname);
    return sendError(res, 405, '方法不被允许');
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, err.message || '服务器错误');
    else {
      try {
        res.end();
      } catch {}
    }
  }
}

// ---------------------------------------------------------------- start

function openBrowser(url) {
  if (process.env.OPEN_BROWSER === '0') return;
  try {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {}
}

function main() {
  ensureData();
  const server = http.createServer(handleRequest);
  let port = START_PORT;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < START_PORT + 30) {
      port += 1;
      server.listen(port, HOST);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });

  server.on('listening', () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  Claude App 已启动 →  ' + url);
    console.log('  （保持此窗口开着；关掉窗口即停止服务）');
    console.log('  模型: ' + DEFAULT_MODEL + '   权限: ' + DEFAULT_PERMISSION_MODE);
    console.log('');
    openBrowser(url);
  });

  server.listen(port, HOST);
}

main();
