/**
 * window.js — 拉起那颗悬浮窗（Python + tkinter，无边框/置顶/液态玻璃）。
 *
 * ## 为什么借用 watch 那份脚本，而不是拷一份
 *
 * 那份 `window.py` 有 3000 多行，而且**还在改**（用户刚收尾完一轮视觉）。
 * 拷一份进来 = 从今往后两边各自演化，改好的一边另一边看不见。
 * 所以默认策略是「找到哪份用哪份」，按优先级：
 *
 *   1. `DSH_SEE_WINDOW` 环境变量        —— 显式指定
 *   2. `~/.dsh/see-window.json` 的 script
 *   3. `~/.dsh/watch-window.json` 的 script  —— 用户就在那儿维护
 *   4. profile 里装的 `dsh-watch-together/examples/floating-chat/window.py`
 *   5. 开发仓库里的 `../dsh-watch-together/examples/floating-chat/window.py`
 *
 * 真到要独立发版那天，把 window.py 拷进 `examples/floating-chat/` 并加进第 5 步即可。
 *
 * ## 两个必须分开的东西
 *
 * - **聊天记录**：靠 `DSH_VIDEO_CACHE_DIR` 传给子进程，指到 `~/.dsh/see-now`。
 *   不分开的话，see-now 的消息会和陪看的消息串进同一个窗。
 * - **pid 锁**：`~/.dsh/see-now-window.pid`。不分开的话，陪看的窗开着时我们就不敢开了。
 */

import childProcess, { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatDir, dshHome } from './chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包里自带的那份 —— 由 `scripts/sync-window.mjs` 从上游生成，是最后的兜底 */
export const PACKAGED = join(HERE, '..', 'examples', 'floating-chat', 'window.py');
/** macOS 独立入口，不导入 Windows 窗口。 */
export const MACOS = join(HERE, '..', 'examples', 'floating-chat', 'macos-window.py');
const REL = join('examples', 'floating-chat', 'window.py');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function seeConfig() {
  return readJson(join(dshHome(), 'see-window.json'));
}

export function pidPath() {
  return join(dshHome(), 'see-now-window.pid');
}

/** 心跳文件：窗口每秒 touch 一次，用来区分"进程还在"和"窗口真的在画"。 */
function heartbeatPath() {
  return join(chatDir(), 'window-heartbeat');
}

/** 心跳多久算过期。窗口 1 秒写一次，6 秒足够容忍一次 GC 或短暂卡顿。 */
export const HEARTBEAT_STALE_SEC = 6;

function logPath() {
  return join(dshHome(), 'see-now-window.log');
}

/**
 * 已安装的 `dsh-watch-together` 里那份 window.py（可能有多份）。
 */
function installedCopies(env = process.env) {
  const home = dshHome(env);
  const roots = [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')];
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      roots.push(join(home, 'profiles', name, 'node_modules'));
    }
  } catch { /* 没有 profiles 目录 */ }
  const out = [];
  for (const root of roots) {
    const p = join(root, 'dsh-watch-together', REL);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/**
 * 窗口脚本放哪（按优先级找第一份存在的）。
 */
export function resolveScript({ env = process.env, platform = process.platform } = {}) {
  const explicit = env.DSH_SEE_WINDOW;
  if (explicit && existsSync(explicit)) return { script: explicit, from: 'DSH_SEE_WINDOW' };

  const seen = readJson(join(dshHome(env), 'see-window.json')).script;
  if (seen && existsSync(seen)) return { script: seen, from: '~/.dsh/see-window.json' };

  if (platform === 'darwin' && existsSync(MACOS)) return { script: MACOS, from: 'macOS 独立窗口' };

  const watch = readJson(join(dshHome(env), 'watch-window.json')).script;
  if (watch && existsSync(watch)) return { script: watch, from: '~/.dsh/watch-window.json' };

  const installed = installedCopies(env);
  if (installed.length) return { script: installed[0], from: '已安装的 watch-together' };

  const repo = join(HERE, '..', '..', 'dsh-watch-together', REL);
  if (existsSync(repo)) return { script: repo, from: '开发仓库' };

  if (existsSync(PACKAGED)) return { script: PACKAGED, from: '包内' };
  return { script: null, from: null };
}

const TK_PROBE = 'import tkinter';

export function hasTkinter(python) {
  const r = childProcess.spawnSync(python, ['-c', TK_PROBE], {
    timeout: 8000, windowsHide: true, stdio: 'ignore',
  });
  return r?.status === 0;
}

function storePython() {
  const dir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps');
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!/^PythonSoftwareFoundation\.Python\.\d/.test(name)) continue;
      for (const exe of ['pythonw.exe', 'python.exe']) {
        out.push(join(dir, name, exe));
      }
    }
  } catch { /* 读不了目录就算了 */ }
  return out;
}

function pythonCandidates() {
  const cfg = seeConfig();
  const list = [];
  for (const c of [process.env.DSH_SEE_PYTHON, cfg.python, process.env.DSH_FLOAT_PYTHON]) {
    if (c) list.push(c);
  }
  if (process.platform === 'win32') {
    list.push('pythonw.exe', 'python.exe', ...storePython());
  } else {
    list.push('python3', 'python');
    if (process.platform === 'darwin') {
      list.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3');
      try {
        const root = '/Library/Frameworks/Python.framework/Versions';
        for (const version of readdirSync(root).sort().reverse()) {
          const python = join(root, version, 'bin', 'python3');
          if (existsSync(python)) list.push(python);
        }
      } catch { /* 没安装 python.org 的解释器 */ }
    }
  }
  return [...new Set(list.filter(Boolean))];
}

let owned = null;
let opening = null;
let openingController = null;
let lastState = { alive: false, state: 'unknown', reason: null, owned: false, protocol: false };
let pendingWindowState = null;
const MAX_MESSAGE_BYTES = 8192;
const QUALITIES = new Set(['low', 'standard', 'high', 'ultra']);
const PACES = new Set(['calm', 'normal', 'dense']);

/** pid 文件指向的那个进程还在不在。**不看心跳**，见 `windowPidAlive` 的注释。 */
export function windowPidAlive() {
  if (process.env.DSH_SEE_NO_WINDOW === '1') return false;
  if (owned) return !owned.exited;
  let pid = 0;
  try { pid = Number(readFileSync(pidPath(), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
  return true;
}

/**
 * 上次开的那个还活着吗？（**"这窗还能用吗"**，决定要不要重开）
 */
export function windowAlive() {
  if (process.env.DSH_SEE_NO_WINDOW === '1') return false;
  if (owned) {
    if (owned.exited || ['closed', 'failed'].includes(lastState.state)) return false;
    if (owned.protocol) return true;
  }
  if (!windowPidAlive()) return false;
  try {
    const hb = statSync(heartbeatPath());
    if ((Date.now() - hb.mtimeMs) / 1000 > HEARTBEAT_STALE_SEC) return false;
  } catch { /* 没有心跳文件：兼容老窗口，继续信任 pid */ }
  return true;
}

/** 当前窗口状态；legacy 退出不等于用户主动关闭。 */
export function windowStatus() {
  const alive = windowAlive();
  if (!owned && alive) return { ...lastState, alive: true, state: 'legacy', owned: false, protocol: false };
  return { ...lastState, alive, owned: Boolean(owned && !owned.exited) };
}

function update(record, state, reason = null) {
  record.status = { alive: !record.exited, state, reason, owned: true, protocol: record.protocol };
  if (owned !== record) return;
  lastState = record.status;
  for (const notify of [...record.waiters]) notify();
}

function clearPid(record) {
  try {
    if (readFileSync(record.pidFile, 'utf8').trim() === String(record.child.pid)) unlinkSync(record.pidFile);
  } catch { /* 没有锁，或另一个窗口已经接管 */ }
}

function notifyClosed(record) {
  if (record.closeNotified) return;
  record.closeNotified = true;
  clearPid(record);
  const status = { ...record.status, alive: false, owned: false };
  if (owned === record) { owned = null; lastState = status; }
  try { record.onClose?.(status); } catch (error) {
    record.log(`[window] onClose: ${error?.message ?? error}`);
  }
}

function waitChange(record, ms, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      record.waiters.delete(finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    record.waiters.add(finish);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted || record.exited) finish();
  });
}

async function terminate(record, reason, state = 'closed') {
  if (record.stopping) return record.stopping;
  record.stopReason = reason;
  update(record, state, reason);
  record.stopping = (async () => {
    if (!record.exited) {
      try { record.child.kill('SIGTERM'); } catch { /* 已退出 */ }
      await waitChange(record, 700);
      if (!record.exited) {
        try { record.child.kill('SIGKILL'); } catch { /* 已退出 */ }
        await waitChange(record, 300);
      }
    }
    notifyClosed(record);
    record.child.stdout?.destroy();
    record.child.stdin?.destroy();
  })();
  return record.stopping;
}

function probeTk(python, signal) {
  return new Promise((resolve) => {
    childProcess.execFile(python, ['-c', TK_PROBE], {
      timeout: 8000, windowsHide: true, signal,
    }, (error) => resolve(!error));
  });
}

function windowCommand(event) {
  if (event?.version !== 1) return null;
  const { command } = event;
  if (['pause', 'resume', 'stop'].includes(command)) return { version: 1, command };
  if (command === 'seek' && Number.isFinite(event.position) && event.position >= 0) {
    return { version: 1, command, position: event.position };
  }
  if (command === 'watch' && event.source === 'file' && typeof event.path === 'string'
    && event.path.trim() && event.path.length <= 4096 && !event.path.includes('\0')) {
    return { version: 1, command, source: 'file', path: event.path };
  }
  if (command === 'configure' && (event.quality === undefined || QUALITIES.has(event.quality))
    && (event.pace === undefined || PACES.has(event.pace)) && (event.quality || event.pace)) {
    return { version: 1, command, ...(event.quality ? { quality: event.quality } : {}),
      ...(event.pace ? { pace: event.pace } : {}) };
  }
  return null;
}

/** 将真实运行状态发给自建控制窗口；未就绪时只保留最后一份状态。 */
export function sendWindowState(state) {
  pendingWindowState = state;
  if (!owned?.commands || owned.exited || !owned.child.stdin?.writable) return false;
  try {
    const line = JSON.stringify({ version: 1, state }) + '\n';
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES || owned.child.stdin.writableLength > MAX_MESSAGE_BYTES * 2) return false;
    owned.child.stdin.write(line);
    return true;
  } catch (error) {
    owned?.log(`[window] state: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * 开窗（幂等）。
 */
export function openWindow(options = {}) {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' });
  if (opening) return opening;
  const controller = new AbortController();
  openingController = controller;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  opening = launchWindow({ ...options, signal: controller.signal }).finally(() => {
    options.signal?.removeEventListener('abort', abort);
    opening = null;
    openingController = null;
  });
  return opening;
}

async function launchWindow({
  force = false, log = () => {}, settleMs = 700, readyMs = 8000,
  script: forced = null, signal, onClose, onCommand, standalone = false,
} = {}) {
  if (process.env.DSH_SEE_NO_WINDOW === '1') return { ok: false, reason: 'disabled' };
  if (!force && windowAlive()) {
    if (!owned) lastState = { alive: true, state: 'legacy', reason: null, owned: false, protocol: false };
    else {
      if (typeof onClose === 'function') owned.onClose = onClose;
      if (typeof onCommand === 'function') owned.onCommand = onCommand;
    }
    return { ok: true, already: true, ...windowStatus() };
  }
  if (owned) await terminate(owned, 'stopped');

  // 如果 force 为 true，且非 owned，清理旧进程
  if (force) {
    try {
      const old = Number(readFileSync(pidPath(), 'utf8').trim());
      if (Number.isInteger(old) && old > 0 && old !== process.pid) {
        try { process.kill(old); } catch { /* 已经没了 */ }
      }
    } catch { /* 正常首次启动 */ }
  }

  const { script, from } = forced ? { script: forced, from: '调用方指定' } : resolveScript();
  if (!script) return { ok: false, reason: '找不到 window.py（设 DSH_SEE_WINDOW，或写 ~/.dsh/see-window.json）' };
  if (forced && !existsSync(forced)) return { ok: false, reason: `指定的 script 不存在：${forced}`, script, from };

  let protocol = false;
  let commands = false;
  try {
    const text = readFileSync(script, 'utf8');
    protocol = /^DSH_SEE_WINDOW_PROTOCOL = 1$/m.test(text);
    commands = /^DSH_SEE_WINDOW_COMMANDS = 1$/m.test(text);
  } catch { /* spawn 会报告脚本错误 */ }

  const tried = [];
  let hadTkinter = false;
  for (const python of pythonCandidates()) {
    if (signal.aborted) return { ok: false, reason: 'cancelled' };
    const tkinter = await probeTk(python, signal);
    if (signal.aborted) return { ok: false, reason: 'cancelled' };
    if (!tkinter) { tried.push(`${python}（无 tkinter）`); continue; }
    hadTkinter = true;
    let child;
    let logFd = null;
    try {
      mkdirSync(dshHome(), { recursive: true });
      mkdirSync(chatDir(), { recursive: true });
      try { logFd = openSync(logPath(), 'a'); } catch { /* 仍可启动，stderr 丢弃 */ }
      child = childProcess.spawn(python, [script], {
        detached: true,
        stdio: [commands ? 'pipe' : 'ignore', 'pipe', logFd ?? 'ignore'],
        windowsHide: true,
        env: {
          ...process.env,
          DSH_VIDEO_CACHE_DIR: chatDir(),
          DSH_SEE_WINDOW_CONFIG: join(dshHome(), 'see-window.json'),
          DSH_SEE_WINDOW_VISIBLE: '1',
          DSH_SEE_WINDOW_STANDALONE: standalone ? '1' : '0',
        },
      });
    } catch (e) {
      tried.push(`${python}（spawn: ${e?.message ?? e}）`);
      continue;
    } finally {
      if (logFd !== null) try { closeSync(logFd); } catch { /* 已关闭 */ }
    }

    const record = {
      child, protocol, commands, pidFile: pidPath(), exited: false,
      waiters: new Set(), stopReason: null, onClose, onCommand, log,
      status: { alive: true, state: 'starting', reason: null, owned: true, protocol },
    };
    child.stdin?.on('error', (error) => log(`[window] stdin: ${error.message}`));
    owned = record;
    update(record, 'starting');

    let buffer = '';
    let dropping = false;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      for (const part of chunk.toString().split(/(?<=\n)/)) {
        if (dropping) { if (part.endsWith('\n')) dropping = false; continue; }
        buffer += part;
        if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
          buffer = ''; dropping = !part.endsWith('\n'); continue;
        }
        if (!part.endsWith('\n')) continue;
        const line = buffer.trimEnd(); buffer = '';
        if (!protocol || !line.startsWith('DSH_SEE_WINDOW ')) continue;
        try {
          const event = JSON.parse(line.slice(15));
          if (commands && event.version !== 1) continue;
          if (['ready', 'closed', 'failed'].includes(event.state) && !record.stopReason) {
            update(record, event.state, event.reason ?? null);
          }
          const command = commands && windowCommand(event);
          if (command && record.onCommand && !record.stopReason && !record.exited && owned === record && record.status.state === 'ready') {
            const { version: _version, ...action } = command;
            Promise.resolve().then(() => {
              if (owned !== record || record.exited || record.stopReason) return;
              return record.onCommand(action);
            }).catch((error) => {
              log(`[window] command: ${error?.message ?? error}`);
              if (owned === record) {
                sendWindowState({ ...pendingWindowState, lastError: String(error?.message ?? error).slice(0, 400) });
              }
            });
          }
        } catch { /* 外部脚本的普通输出 */ }
      }
    });

    child.once('exit', (code, exitSignal) => {
      record.exited = true;
      if (!record.stopReason && !['closed', 'failed'].includes(record.status.state)) {
        update(record, protocol || record.status.state === 'starting' ? 'failed' : 'unknown',
          protocol ? `exit:${code ?? exitSignal}` : 'legacy-exit');
      }
      for (const notify of [...record.waiters]) notify();
      notifyClosed(record);
    });

    child.once('error', (error) => {
      record.exited = true;
      update(record, 'failed', `spawn:${error.message}`);
      notifyClosed(record);
    });

    child.unref?.();

    const deadline = Date.now() + (protocol ? readyMs : settleMs);
    while (!signal.aborted && !record.exited && lastState.state === 'starting' && Date.now() < deadline) {
      await waitChange(record, Math.max(1, deadline - Date.now()), signal);
    }

    if (signal.aborted) { await terminate(record, 'cancelled'); return { ok: false, reason: 'cancelled' }; }
    if (!protocol && !record.exited) update(record, 'legacy');
    if (!record.exited && ['ready', 'legacy'].includes(lastState.state)) {
      try { writeFileSync(record.pidFile, String(child.pid), 'utf8'); } catch { /* 仍以 child 追踪 */ }
      child.stdout?.unref?.();
      child.stdin?.unref?.();
      if (pendingWindowState) sendWindowState(pendingWindowState);
      return { ok: true, script, from, python, ...windowStatus() };
    }

    const reason = lastState.state === 'starting' ? 'ready-timeout' : lastState.reason ?? lastState.state;
    if (lastState.state === 'closed') {
      await terminate(record, reason);
      return { ok: false, state: 'closed', reason, script };
    }
    await terminate(record, reason, 'failed');
    log(`[window] ${python}: ${reason}，看 ${logPath()}`);
    tried.push(`${python}（${reason}）`);
  }

  const category = hadTkinter ? 'window-failed' : 'dependency/tk';
  const reason = `${hadTkinter ? '窗口启动失败' : '未找到带 tkinter 的解释器'}：${tried.join(' / ') || '没有候选'}`;
  lastState = { alive: false, state: 'failed', reason, owned: false, protocol };
  return { ok: false, state: 'failed', reason, category, attempts: tried, script };
}

function externalWindowMatches(pid, script) {
  const expected = resolve(script);
  let command;
  if (process.platform === 'win32') {
    const query = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.CommandLine }`;
    const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
      { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 16384 });
    if (result.status !== 0) return false;
    command = result.stdout?.trim();
  } else {
    const result = childProcess.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
    if (result.status !== 0) return false;
    command = result.stdout?.trim();
  }
  if (!command) return false;
  const match = command.match(/^(?:"([^"]+)"|(\S+))\s+(.+)$/);
  if (!match) return false;
  const python = (match[1] ?? match[2]).replace(/\\/g, '/').split('/').pop();
  if (!/^python(?:w)?(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(python)) return false;
  const argument = match[3].replace(/^"(.*)"$/, '$1');
  return process.platform === 'win32'
    ? argument.replace(/\\/g, '/').toLowerCase() === expected.replace(/\\/g, '/').toLowerCase()
    : argument === expected;
}

async function closeVerifiedExternal() {
  let pid;
  try { pid = Number(readFileSync(pidPath(), 'utf8').trim()); } catch { return { ok: true, already: true }; }
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (!Number.isInteger(pid) || pid <= 0 || !alive()) {
    try { unlinkSync(pidPath()); } catch { /* 已清理 */ }
    return { ok: true, already: true };
  }
  const { script } = resolveScript();
  if (!script || !externalWindowMatches(pid, script)) return { ok: false, reason: 'external-identity-mismatch' };
  try { process.kill(pid, 'SIGTERM'); } catch (error) {
    return { ok: false, reason: `close:${error.message}` };
  }
  const deadline = Date.now() + 1200;
  while (alive() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  if (alive()) {
    if (!externalWindowMatches(pid, script)) return { ok: false, reason: 'external-identity-changed' };
    try { process.kill(pid, 'SIGKILL'); } catch (error) { return { ok: false, reason: `close:${error.message}` }; }
    const until = Date.now() + 300;
    while (alive() && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
  }
  if (alive()) return { ok: false, reason: 'close-timeout' };
  try { if (readFileSync(pidPath(), 'utf8').trim() === String(pid)) unlinkSync(pidPath()); } catch { /* 已清理 */ }
  return { ok: true };
}

/** 关闭自建 child；只有 CLI 显式请求 verifiedExternal 时才核对并关闭外部窗口。 */
export async function closeWindow({ ownedOnly = true, verifiedExternal = false } = {}) {
  openingController?.abort();
  if (owned) {
    await terminate(owned, 'stopped');
  } else if (verifiedExternal) {
    return closeVerifiedExternal();
  }
  if (!windowPidAlive()) {
    try { unlinkSync(pidPath()); } catch { /* 已清理 */ }
  }
  if (opening) await opening;
  if (!windowPidAlive()) {
    try { unlinkSync(pidPath()); } catch { /* 已清理 */ }
  }
  return { ok: true };
}
