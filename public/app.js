'use strict';

// ---------------------------------------------------------------- elements

const $ = (id) => document.getElementById(id);

const chatEl = $('chat');
const emptyEl = $('empty');
const projectListEl = $('project-list');
const sessionListEl = $('session-list');
const btnAddProject = $('btn-add-project');
const btnNewSession = $('btn-new-session');
const tbProject = $('tb-project');
const tbCwd = $('tb-cwd');
const modelInput = $('model-input');
const permSelect = $('perm-select');
const attEl = $('attachments');
const dz = $('dropzone');
const inputEl = $('input');
const btnAttach = $('btn-attach');
const btnSend = $('btn-send');
const btnStop = $('btn-stop');
const fileInput = $('file-input');
const hintEl = $('hint');
const statusFoot = $('status-foot');

const dialog = $('project-dialog');
const brPath = $('br-path');
const brList = $('br-list');
const brUp = $('br-up');
const brGo = $('br-go');
const brPick = $('br-pick');
const brCancel = $('br-cancel');

// messages live in their own container so #empty can stay a sibling
const messagesEl = document.createElement('div');
messagesEl.id = 'messages';
chatEl.appendChild(messagesEl);

// ---------------------------------------------------------------- state

const state = {
  config: null,
  projects: [],
  sessions: [],
  projectId: null,
  sessionId: null,
  attachments: [],
  streaming: false,
  abort: null,
};

const PERM_LABELS = {
  acceptEdits: '自动改文件',
  plan: '只读规划',
  default: '默认（只读为主）',
  bypassPermissions: '全自动（慎用）',
};

const HKEY = 'claude-app-history';
let hist = loadHist();

function loadHist() {
  try {
    return JSON.parse(localStorage.getItem(HKEY)) || {};
  } catch {
    return {};
  }
}
function saveHist() {
  try {
    localStorage.setItem(HKEY, JSON.stringify(hist));
  } catch {}
}

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function md(text) {
  const parts = [];
  let rest = String(text).replace(/```([\w-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    parts.push(code);
    return '\u0000' + (parts.length - 1) + '\u0000';
  });
  rest = esc(rest);
  rest = rest.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  rest = rest.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  rest = rest.replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const code = String(parts[+i]).replace(/\n$/, '');
    return `<pre><code>${esc(code)}</code></pre>`;
  });
  return rest;
}

function hint(text, err) {
  hintEl.textContent = text || '';
  hintEl.classList.toggle('err', Boolean(err));
}
const hintErr = (t) => hint(t, true);

function scrollBottom(force) {
  const near = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 140;
  if (force || near) chatEl.scrollTop = chatEl.scrollHeight;
}

function toggleEmpty() {
  emptyEl.style.display = messagesEl.children.length ? 'none' : 'flex';
}

function saveCurrentHistory() {
  if (state.sessionId) hist[state.sessionId] = messagesEl.innerHTML;
  saveHist();
}

function updateSendState() {
  const hasPayload = inputEl.value.trim().length > 0 || state.attachments.length > 0;
  btnSend.disabled = state.streaming || !state.projectId || !hasPayload;
}

// ---------------------------------------------------------------- markdown-free renderers

function addUserMessage(text, attachments) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (attachments && attachments.length) {
    const al = document.createElement('div');
    al.className = 'attach-list';
    attachments.forEach((a) => {
      const row = document.createElement('div');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '附件';
      const nm = document.createElement('span');
      nm.textContent = a.name;
      row.appendChild(tag);
      row.appendChild(nm);
      al.appendChild(row);
    });
    bubble.appendChild(al);
  }

  if (text) {
    const t = document.createElement('span');
    t.textContent = text;
    bubble.appendChild(t);
  }

  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  toggleEmpty();
  scrollBottom(true);
}

function newAssistantBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing';
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  toggleEmpty();
  return bubble;
}

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const order = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description', 'notebook_path'];
  for (const k of order) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  const first = Object.values(input).find((v) => typeof v === 'string');
  return first || '';
}

function addToolBlock(block) {
  const details = document.createElement('details');
  details.className = 'tool';

  const summary = document.createElement('summary');
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = block.name || 'tool';
  const argEl = document.createElement('span');
  argEl.className = 'tool-arg';
  argEl.textContent = summarizeInput(block.name, block.input);
  summary.appendChild(nameEl);
  summary.appendChild(argEl);

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(block.input ?? {}, null, 2);

  details.appendChild(summary);
  details.appendChild(pre);
  messagesEl.appendChild(details);
  scrollBottom();
}

function addMeta(text, isErr) {
  const d = document.createElement('div');
  d.className = 'meta' + (isErr ? ' err' : '');
  d.textContent = text;
  messagesEl.appendChild(d);
  scrollBottom();
}

function closeTurn(turn) {
  if (!turn.textEl) return;
  turn.textEl.classList.remove('typing');
  const empty = !turn.buf.trim() && !turn.textEl.textContent.trim();
  if (empty) {
    const w = turn.textEl.closest('.msg');
    if (w) w.remove();
  }
  turn.textEl = null;
}

// ---------------------------------------------------------------- streaming

function handleClaude(p, turn) {
  if (!p || typeof p !== 'object') return;

  if (p.type === 'stream_event') {
    const ev = p.event || {};
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
      turn.sawDelta = true;
      turn.buf += ev.delta.text;
      if (!turn.textEl) turn.textEl = newAssistantBubble();
      turn.textEl.innerHTML = md(turn.buf);
      scrollBottom();
    }
    return;
  }

  if (p.type === 'assistant' && p.message && Array.isArray(p.message.content)) {
    for (const block of p.message.content) {
      if (block.type === 'text') {
        const txt = block.text || '';
        if (turn.sawDelta && turn.textEl) {
          turn.textEl.classList.remove('typing');
          turn.textEl.innerHTML = md(txt);
          turn.textEl = null;
          turn.buf = '';
          turn.sawDelta = false;
        } else if (txt.trim()) {
          const b = newAssistantBubble();
          b.classList.remove('typing');
          b.innerHTML = md(txt);
        }
      } else if (block.type === 'tool_use') {
        closeTurn(turn);
        turn.buf = '';
        turn.sawDelta = false;
        addToolBlock(block);
      }
    }
    scrollBottom();
    return;
  }

  if (p.type === 'result') {
    if (p.is_error) {
      addMeta('出错：' + (p.result || p.subtype || '未知错误'), true);
    } else if (typeof p.duration_ms === 'number' && p.duration_ms > 0) {
      addMeta('完成 · ' + (p.duration_ms / 1000).toFixed(1) + 's');
    }
    return;
  }
}

function handleEvent(obj, turn) {
  switch (obj.type) {
    case 'start':
      state.curCwd = obj.cwd;
      tbCwd.textContent = obj.cwd || '';
      return;
    case 'claude':
      return handleClaude(obj.payload, turn);
    case 'stderr': {
      const t = String(obj.text || '').trim();
      if (t) addMeta(t, false);
      return;
    }
    case 'error':
      return addMeta(obj.message, true);
    case 'exit':
      if (obj.code) addMeta('进程退出码 ' + obj.code, true);
      return;
  }
}

function setStreaming(on) {
  state.streaming = on;
  btnStop.classList.toggle('hidden', !on);
  btnSend.classList.toggle('hidden', on);
  updateSendState();
}

async function send() {
  if (state.streaming) return;
  if (!state.projectId) return hintErr('请先在左侧选择或添加一个项目');
  const text = inputEl.value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.sessionId) {
    await createSession();
    if (!state.sessionId) return;
  }

  const atts = state.attachments.slice();
  addUserMessage(text, atts);
  inputEl.value = '';
  state.attachments = [];
  renderChips();
  autoGrow();

  setStreaming(true);
  hint('');

  const turn = { textEl: null, buf: '', sawDelta: false };
  const controller = new AbortController();
  state.abort = controller;

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        sessionId: state.sessionId,
        message: text,
        attachments: atts.map((a) => ({ name: a.name, path: a.path })),
        model: modelInput.value.trim(),
        permissionMode: permSelect.value,
      }),
    });

    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.error || 'HTTP ' + resp.status);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let sbuf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sbuf += dec.decode(value, { stream: true });
      let i;
      while ((i = sbuf.indexOf('\n\n')) >= 0) {
        const block = sbuf.slice(0, i);
        sbuf = sbuf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        handleEvent(obj, turn);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') addMeta('已停止');
    else addMeta('出错：' + err.message, true);
  } finally {
    closeTurn(turn);
    setStreaming(false);
    saveCurrentHistory();
    toggleEmpty();
    scrollBottom();
  }
}

async function stop() {
  if (state.abort) state.abort.abort();
  try {
    await fetch('/api/chat/stop', { method: 'POST' });
  } catch {}
}

// ---------------------------------------------------------------- attachments

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

function renderChips() {
  attEl.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    if (a.preview) {
      const img = document.createElement('img');
      img.src = a.preview;
      chip.appendChild(img);
    }
    const nm = document.createElement('span');
    nm.textContent = a.name;
    chip.appendChild(nm);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = '移除';
    x.onclick = () => {
      state.attachments.splice(i, 1);
      renderChips();
    };
    chip.appendChild(x);
    attEl.appendChild(chip);
  });
  updateSendState();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  if (file.size > 40 * 1024 * 1024) return hintErr('文件过大（上限 40MB）：' + file.name);
  let dataUrl;
  try {
    dataUrl = await fileToDataUrl(file);
  } catch {
    return hintErr('读取文件失败：' + file.name);
  }
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, dataUrl }),
    });
    const d = await r.json();
    if (d.error) return hintErr(d.error);
    const entry = { name: d.name, path: d.path, mime: d.mime };
    if (d.mime && d.mime.startsWith('image/') && dataUrl.length < 3_000_000) entry.preview = dataUrl;
    state.attachments.push(entry);
    renderChips();
    hint('');
  } catch (err) {
    hintErr('上传失败：' + err.message);
  }
}

async function uploadFiles(files) {
  for (const f of files) await uploadFile(f);
}

// ---------------------------------------------------------------- projects / sessions

function renderProjects() {
  projectListEl.innerHTML = '';
  state.projects.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'item' + (p.id === state.projectId ? ' active' : '');
    const main = document.createElement('div');
    main.className = 'item-main';
    const nm = document.createElement('div');
    nm.className = 'item-name';
    nm.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = p.path;
    main.appendChild(nm);
    main.appendChild(sub);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除项目';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteProject(p.id);
    };
    li.appendChild(main);
    li.appendChild(del);
    li.onclick = () => selectProject(p.id);
    projectListEl.appendChild(li);
  });
}

function renderSessions() {
  sessionListEl.innerHTML = '';
  state.sessions.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'item' + (s.id === state.sessionId ? ' active' : '');
    const main = document.createElement('div');
    main.className = 'item-main';
    const nm = document.createElement('div');
    nm.className = 'item-name';
    nm.textContent = s.title || '新会话';
    nm.title = '双击重命名';
    nm.ondblclick = (e) => {
      e.stopPropagation();
      startRenameSession(s, nm);
    };
    main.appendChild(nm);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除会话';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    };
    li.appendChild(main);
    li.appendChild(del);
    li.onclick = () => selectSession(s.id);
    sessionListEl.appendChild(li);
  });
}

async function loadProjects() {
  const r = await fetch('/api/projects');
  state.projects = await r.json();
  renderProjects();
}

async function loadSessions() {
  if (!state.projectId) {
    state.sessions = [];
    return renderSessions();
  }
  const r = await fetch('/api/sessions?projectId=' + encodeURIComponent(state.projectId));
  state.sessions = await r.json();
  renderSessions();
}

async function selectProject(id) {
  state.projectId = id || null;
  localStorage.setItem('claude-app-project', state.projectId || '');
  const p = state.projects.find((x) => x.id === state.projectId);
  tbProject.textContent = p ? p.name : '未选择项目';
  tbCwd.textContent = p ? p.path : '';
  renderProjects();
  btnNewSession.disabled = !p;
  saveCurrentHistory();
  state.sessionId = null;
  messagesEl.innerHTML = '';
  toggleEmpty();
  await loadSessions();
  updateSendState();
}

async function createSession() {
  if (!state.projectId) return hintErr('先选一个项目');
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: state.projectId }),
  });
  const s = await r.json();
  if (s.error) return hintErr(s.error);
  state.sessions.unshift(s);
  renderSessions();
  selectSession(s.id);
}

function selectSession(id) {
  saveCurrentHistory();
  state.sessionId = id || null;
  localStorage.setItem('claude-app-session', state.sessionId || '');
  renderSessions();
  messagesEl.innerHTML = (state.sessionId && hist[state.sessionId]) || '';
  toggleEmpty();
  scrollBottom(true);
  updateSendState();
}

function startRenameSession(s, nmEl) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = s.title || '';
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const title = input.value.trim();
    if (save && title && title !== s.title) {
      try {
        const r = await fetch('/api/sessions/' + s.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        const d = await r.json();
        if (d.error) hintErr(d.error);
        else s.title = d.title;
      } catch (err) {
        hintErr('重命名失败：' + err.message);
      }
    }
    renderSessions();
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  input.onblur = () => finish(true);

  nmEl.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteSession(id) {
  if (!confirm('删除这个会话？（对话记录会从界面移除）')) return;
  await fetch('/api/sessions/' + id, { method: 'DELETE' });
  delete hist[id];
  saveHist();
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.sessionId === id) selectSession(null);
  renderSessions();
}

async function deleteProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!confirm('删除项目「' + (p ? p.name : '') + '」？（不会删除磁盘上的文件夹）')) return;
  await fetch('/api/projects/' + id, { method: 'DELETE' });
  state.projects = state.projects.filter((x) => x.id !== id);
  if (state.projectId === id) {
    await selectProject(null);
    tbProject.textContent = '未选择项目';
    tbCwd.textContent = '';
  }
  renderProjects();
}

// ---------------------------------------------------------------- folder picker

async function browse(target) {
  const url = '/api/browse' + (target ? '?path=' + encodeURIComponent(target) : '');
  let d;
  try {
    const r = await fetch(url);
    d = await r.json();
  } catch (err) {
    return hintErr('浏览失败：' + err.message);
  }
  if (d.error) return hintErr(d.error);
  brPath.value = d.path;
  brUp.disabled = !d.parent;
  brUp.dataset.parent = d.parent || '';
  brList.innerHTML = '';
  if (!d.dirs.length) {
    const li = document.createElement('li');
    li.textContent = '（没有子文件夹）';
    li.style.color = 'var(--muted)';
    li.style.cursor = 'default';
    brList.appendChild(li);
  }
  d.dirs.forEach((dir) => {
    const li = document.createElement('li');
    li.textContent = dir.name;
    li.onclick = () => browse(dir.path);
    brList.appendChild(li);
  });
}

async function pickCurrentFolder() {
  const r = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: brPath.value }),
  });
  const d = await r.json();
  if (d.error) return hintErr(d.error);
  dialog.close();
  await loadProjects();
  await selectProject(d.id);
}

// ---------------------------------------------------------------- events

btnAddProject.onclick = () => {
  dialog.showModal();
  browse(null);
};
brCancel.onclick = () => dialog.close();
brPick.onclick = pickCurrentFolder;
brUp.onclick = () => {
  if (brUp.dataset.parent) browse(brUp.dataset.parent);
};
brGo.onclick = () => {
  if (brPath.value.trim()) browse(brPath.value.trim());
};

btnNewSession.onclick = createSession;
btnSend.onclick = send;
btnStop.onclick = stop;
btnAttach.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  await uploadFiles([...fileInput.files]);
  fileInput.value = '';
};

inputEl.addEventListener('input', () => {
  autoGrow();
  updateSendState();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener('paste', async (e) => {
  const items = [...((e.clipboardData && e.clipboardData.items) || [])];
  const imgs = items.filter((it) => it.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  for (const it of imgs) {
    const f = it.getAsFile();
    if (f) await uploadFile(f);
  }
});

function wireDrop(el) {
  ['dragenter', 'dragover'].forEach((ev) =>
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
    })
  );
  el.addEventListener('drop', (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (files.length) uploadFiles(files);
  });
}
wireDrop(dz);
wireDrop(chatEl);

// ---------------------------------------------------------------- init

async function init() {
  try {
    const r = await fetch('/api/config');
    state.config = await r.json();
  } catch {
    statusFoot.textContent = '无法连接服务器';
    return;
  }

  modelInput.value = state.config.model || '';
  permSelect.innerHTML = '';
  (state.config.permissionModes || []).forEach((m) => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = PERM_LABELS[m] || m;
    if (m === state.config.permissionMode) o.selected = true;
    permSelect.appendChild(o);
  });

  statusFoot.textContent = state.config.configured
    ? '已连接 · ' + (state.config.baseUrlHost || '')
    : '未检测到 API key';

  await loadProjects();

  const pid = localStorage.getItem('claude-app-project');
  if (pid && state.projects.some((p) => p.id === pid)) {
    await selectProject(pid);
    const sid = localStorage.getItem('claude-app-session');
    if (sid && state.sessions.some((s) => s.id === sid)) selectSession(sid);
  }

  toggleEmpty();
  updateSendState();
}

init();
