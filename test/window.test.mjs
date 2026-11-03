// 悬浮窗的启动逻辑：解释器要带 tkinter、pid 只在真活着时才写
//
// 这一组测试是补踩过的坑：
//   1. PATH 上的 python 是 WorkBuddy managed 的，**没有 tkinter**，spawn 之后立刻退
//   2. 老代码在 waitExit 之前就写了 pid → pid 指向死进程 → windowAlive() 永远 false
//   3. 商店版解释器在 WindowsApps 里是 App Execution Alias，**existsSync 判定不到**
//
// ⚠️ 这里**绝不能真的把窗开起来**（会弹到用户脸上、还会占住真机的 pid 锁），
// 所以每个用例都用 `DSH_SEE_NO_WINDOW=1` 或"一定失败的解释器"把路堵死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// 必须在 import window.js 之前设好 DSH_HOME（chatDir() 读它）
const home = mkdtempSync(join(tmpdir(), 'dsh-see-window-'));
process.env.DSH_HOME = home;
delete process.env.DSH_SEE_WINDOW;
delete process.env.DSH_SEE_PYTHON;
delete process.env.DSH_FLOAT_PYTHON;

const { openWindow, closeWindow, windowAlive, windowStatus, sendWindowState, MACOS, pidPath, resolveScript, hasTkinter } =
  await import('../src/window.js');

test('DSH_SEE_NO_WINDOW=1 时直接拒绝，不 spawn', async () => {
  process.env.DSH_SEE_NO_WINDOW = '1';
  try {
    const st = await openWindow();
    assert.equal(st.ok, false);
    assert.equal(st.reason, 'disabled');
  } finally {
    delete process.env.DSH_SEE_NO_WINDOW;
  }
  assert.equal(existsSync(pidPath()), false, 'disabled 时不能留 pid');
});

test('pid 文件指向不存在的进程时，windowAlive 必须是 false', () => {
  writeFileSync(pidPath(), '2147483646', 'utf8');
  assert.equal(windowAlive(), false);
});

test('pid 文件是垃圾内容时也不能崩', () => {
  writeFileSync(pidPath(), 'not-a-pid', 'utf8');
  assert.equal(windowAlive(), false);
  writeFileSync(pidPath(), '', 'utf8');
  assert.equal(windowAlive(), false);
});

test('closeWindow 会把 pid 文件清掉', () => {
  writeFileSync(pidPath(), '2147483646', 'utf8');
  closeWindow();
  assert.equal(existsSync(pidPath()), false);
});

test('DSH_SEE_WINDOW 指向不存在的文件时，跳过它并继续往下找', () => {
  const missing = join(home, 'nope.py');
  process.env.DSH_SEE_WINDOW = missing;
  try {
    const resolved = resolveScript();
    assert.notEqual(resolved.script, missing, '不存在的路径不能当脚本');
    assert.notEqual(resolved.from, 'DSH_SEE_WINDOW');
  } finally {
    delete process.env.DSH_SEE_WINDOW;
  }
});

test('DSH_SEE_WINDOW 指向真实文件时优先用它', () => {
  const fake = join(home, 'fake-window.py');
  writeFileSync(fake, 'import sys; sys.exit(0)\n', 'utf8');
  process.env.DSH_SEE_WINDOW = fake;
  try {
    const resolved = resolveScript();
    assert.equal(resolved.script, fake);
    assert.equal(resolved.from, 'DSH_SEE_WINDOW');
  } finally {
    delete process.env.DSH_SEE_WINDOW;
    rmSync(fake, { force: true });
  }
});

test('脚本秒退时判定为失败，且绝不留下 pid', async () => {
  const fake = join(home, 'crash-immediately.py');
  writeFileSync(fake, 'import sys; sys.exit(42)\n', 'utf8');
  try {
    const st = await openWindow({ script: fake, settleMs: 300 });
    assert.equal(st.ok, false);
    assert.equal(existsSync(pidPath()), false, '秒退的进程绝对不能写 pid');
  } finally {
    rmSync(fake, { force: true });
  }
});

test('注入一个不存在的 script 时，不回落到回退链', async () => {
  const st = await openWindow({ script: join(home, 'gone-forever.py'), settleMs: 200 });
  assert.equal(st.ok, false);
  assert.match(st.reason, /不存在/);
  assert.equal(existsSync(pidPath()), false);
});

test('不存在的解释器一定过不了 tkinter 验证', () => {
  assert.equal(hasTkinter(join(home, 'not-python-1.exe')), false);
  assert.equal(hasTkinter(join(home, 'not-python-2.exe')), false);
});

test('协议等待、退出分类和取消只操作本模块 child', async (t) => {
  const script = join(home, 'protocol.py');
  writeFileSync(script, 'DSH_SEE_WINDOW_PROTOCOL = 1\n');
  const children = [];
  const closed = [];
  const onClose = (status) => {
    assert.deepEqual(windowStatus(), status, '先更新状态再通知');
    assert.equal(existsSync(pidPath()), false, '先清理自建 PID 再通知');
    closed.push(status);
  };
  let behavior = 'ready';
  t.mock.method(childProcess, 'execFile', (_exe, _args, _options, callback) => {
    queueMicrotask(() => callback(null));
  });
  t.mock.method(childProcess, 'spawn', (_exe, _args, options) => {
    assert.equal(options.env.DSH_SEE_WINDOW_CONFIG, join(home, 'see-window.json'));
    assert.equal(options.env.DSH_SEE_WINDOW_VISIBLE, '1');
    const child = new EventEmitter();
    child.pid = 2147483600 + children.length;
    child.stdout = new PassThrough();
    child.unref = () => {};
    child.kill = (signal) => {
      child.kills.push(signal);
      queueMicrotask(() => child.emit('exit', null, signal));
    };
    child.kills = [];
    children.push(child);
    if (behavior === 'ready') queueMicrotask(() => child.stdout.write('DSH_SEE_WINDOW {"state":"ready"}\n'));
    return child;
  });
  try {
    const opened = await openWindow({ script, readyMs: 30, onClose });
    assert.equal(opened.state, 'ready');
    assert.equal(opened.owned, true);
    assert.equal(opened.protocol, true);
    const { utimesSync, mkdirSync } = await import('node:fs');
    const { chatDir } = await import('../src/chat.js');
    const beatDir = chatDir();
    mkdirSync(beatDir, { recursive: true });
    const beat = join(beatDir, 'window-heartbeat');
    writeFileSync(beat, '');
    utimesSync(beat, 0, 0);
    assert.equal(windowAlive(), true, 'owned protocol 状态优先于遗留 Windows 心跳');
    rmSync(beat, { force: true });
    const child = children.at(-1);
    child.stdout.write('DSH_SEE_WINDOW {"state":"closed","reason":"user"}\n');
    child.emit('exit', 0, null);
    assert.equal(windowStatus().state, 'closed');
    assert.equal(windowStatus().reason, 'user');
    assert.equal(existsSync(pidPath()), false);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].reason, 'user');
    child.emit('exit', 0, null);
    assert.equal(closed.length, 1, '重复退出只通知一次');
    await openWindow({ script, readyMs: 30, onClose });
    children.at(-1).emit('exit', 2, null);
    assert.equal(windowStatus().state, 'failed');
    assert.equal(closed.length, 2);
    assert.equal(closed[1].state, 'failed');
    await openWindow({ script, readyMs: 30, onClose });
    await closeWindow({ ownedOnly: true });
    assert.equal(closed.length, 3);
    assert.equal(closed[2].reason, 'stopped');
    behavior = 'silent';
    const controller = new AbortController();
    const pending = openWindow({ script, signal: controller.signal, onClose });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal((await pending).reason, 'cancelled');
    assert.deepEqual(children.at(-1).kills, ['SIGTERM']);
    assert.equal(closed.length, 4);
    assert.equal(closed[3].reason, 'cancelled');
    const count = children.length;
    assert.equal((await openWindow({ script, signal: AbortSignal.abort() })).reason, 'cancelled');
    assert.equal(children.length, count);
    const failed = await openWindow({ script, readyMs: 1 });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /ready-timeout/);
    assert.equal(existsSync(pidPath()), false);
    writeFileSync(pidPath(), String(process.pid));
    const reused = await openWindow({ script });
    assert.equal(reused.owned, false);
    assert.equal(reused.state, 'legacy');
    await closeWindow({ ownedOnly: true });
    assert.equal(existsSync(pidPath()), true, '复用 PID 不清理、不发信号');
  } finally {
    rmSync(pidPath(), { force: true });
    await closeWindow();
  }
});

test('旧外部脚本保留 legacy 存活判断，退出不标用户挂断', async (t) => {
  const script = join(home, 'legacy.py');
  writeFileSync(script, 'print("legacy")\n');
  const child = new EventEmitter();
  child.pid = 2147483555;
  child.stdout = new PassThrough();
  child.unref = () => {};
  t.mock.method(childProcess, 'execFile', (_exe, _args, _options, callback) => callback(null));
  t.mock.method(childProcess, 'spawn', () => child);
  const st = await openWindow({ script, settleMs: 1 });
  assert.equal(st.state, 'legacy');
  child.emit('exit', 0, null);
  assert.equal(windowStatus().state, 'unknown');
  assert.equal(windowStatus().reason, 'legacy-exit');
});

test('macOS 默认独立入口，显式路径仍优先', () => {
  assert.equal(resolveScript({ platform: 'darwin', env: { DSH_HOME: home } }).script, MACOS);
});

test('控制协议限制版本、长度和动作，并双向传递真实状态', async (t) => {
  const script = join(home, 'controls.py');
  writeFileSync(script, 'DSH_SEE_WINDOW_PROTOCOL = 1\nDSH_SEE_WINDOW_COMMANDS = 1\n');
  const child = new EventEmitter();
  child.pid = 2147483511;
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.unref = () => {};
  child.kill = () => queueMicrotask(() => child.emit('exit', 0, null));
  const states = [];
  child.stdin.on('data', (line) => states.push(JSON.parse(line)));
  const received = [];
  t.mock.method(childProcess, 'execFile', (_exe, _args, _options, callback) => callback(null));
  t.mock.method(childProcess, 'spawn', (_exe, _args, options) => {
    assert.equal(options.stdio[0], 'pipe');
    queueMicrotask(() => child.stdout.write('DSH_SEE_WINDOW {"version":1,"state":"ready"}\n'));
    return child;
  });
  await openWindow({ script, onCommand: async (command) => { received.push(command); } });
  const playback = { state: 'paused', positionSec: 14, durationSec: 60, canSeek: true };
  assert.equal(sendWindowState({ playback, pace: 'calm' }), true);
  assert.deepEqual(states.at(-1), { version: 1, state: { playback, pace: 'calm' } });
  const emit = (event) => child.stdout.write(`DSH_SEE_WINDOW ${JSON.stringify(event)}\n`);
  emit({ version: 2, command: 'pause' });
  emit({ version: 1, command: 'shell', path: '/tmp/x' });
  emit({ version: 1, command: 'seek', position: -1 });
  emit({ version: 1, command: 'configure', quality: 'invalid' });
  emit({ version: 1, command: 'watch', source: 'file', path: 'x'.repeat(9000) });
  emit({ version: 1, command: 'pause', ignored: 'field' });
  emit({ version: 1, command: 'seek', position: 20.5 });
  emit({ version: 1, command: 'watch', source: 'file', path: '/tmp/视频.mp4' });
  emit({ version: 1, command: 'configure', quality: 'high', pace: 'normal' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [
    { command: 'pause' }, { command: 'seek', position: 20.5 },
    { command: 'watch', source: 'file', path: '/tmp/视频.mp4' },
    { command: 'configure', quality: 'high', pace: 'normal' },
  ]);
  await openWindow({ script, onCommand: async () => { throw new Error('控制失败'); } });
  emit({ version: 1, command: 'resume' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1).state.lastError, '控制失败');
  await closeWindow();
});

test('CLI 核对外部 Python 和完整脚本路径，身份不符不发送信号', async (t) => {
  writeFileSync(pidPath(), '2147483401');
  let alive = true;
  let command = 'python3 /tmp/unrelated.py';
  const signals = [];
  t.mock.method(childProcess, 'spawnSync', (_exe, args) => {
    if (process.platform === 'win32') assert.match(args.at(-1), /ProcessId = 2147483401/);
    else assert.deepEqual(args, ['-p', '2147483401', '-o', 'command=']);
    return { status: 0, stdout: command };
  });
  t.mock.method(process, 'kill', (_pid, signal) => {
    if (signal === 0) { if (!alive) throw new Error('ESRCH'); return; }
    signals.push(signal);
    alive = false;
  });
  const mismatch = await closeWindow({ verifiedExternal: true });
  assert.equal(mismatch.reason, 'external-identity-mismatch');
  assert.equal(signals.length, 0);
  assert.equal(existsSync(pidPath()), true);
  const { script: currentScript } = resolveScript();
  command = process.platform === 'win32' ? `"C:\\Python313\\python.exe" "${currentScript}"` : `/opt/homebrew/bin/python3 ${currentScript}`;
  const closed = await closeWindow({ verifiedExternal: true });
  assert.equal(closed.ok, true);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(existsSync(pidPath()), false);
});

test('CLI 独立窗口传 standalone 标志，仍等 ready 再返回', async (t) => {
  const child = new EventEmitter();
  child.pid = 2147483402;
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.unref = () => {};
  child.kill = () => queueMicrotask(() => child.emit('exit', 0, null));
  t.mock.method(childProcess, 'execFile', (_exe, _args, _options, callback) => callback(null));
  t.mock.method(childProcess, 'spawn', (_exe, _args, options) => {
    assert.equal(options.env.DSH_SEE_WINDOW_STANDALONE, '1');
    queueMicrotask(() => child.stdout.write('DSH_SEE_WINDOW {"version":1,"state":"ready"}\n'));
    return child;
  });
  assert.equal((await openWindow({ script: MACOS, standalone: true })).state, 'ready');
  await closeWindow();
});

test('心跳过期时 windowAlive 判死 —— 进程还在也不行', async () => {
  const { chatDir } = await import('../src/chat.js');
  const { mkdirSync, utimesSync } = await import('node:fs');
  mkdirSync(chatDir(), { recursive: true });
  const hb = join(chatDir(), 'window-heartbeat');

  writeFileSync(pidPath(), String(process.pid), 'utf8');
  writeFileSync(hb, '', 'utf8');
  assert.equal(windowAlive(), true, '心跳新鲜时应判活');

  const old = new Date(Date.now() - 30_000);
  utimesSync(hb, old, old);
  assert.equal(windowAlive(), false, '心跳过期必须判死，否则永远不会重开窗');

  rmSync(hb, { force: true });
  rmSync(pidPath(), { force: true });
});

test('没有心跳文件时不误杀（兼容不写心跳的老窗口）', async () => {
  const { chatDir } = await import('../src/chat.js');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(chatDir(), { recursive: true });
  const hb = join(chatDir(), 'window-heartbeat');
  rmSync(hb, { force: true });

  writeFileSync(pidPath(), String(process.pid), 'utf8');
  assert.equal(windowAlive(), true, '没有心跳文件时应继续信任 pid，别把老窗口误杀');
  rmSync(pidPath(), { force: true });
});
