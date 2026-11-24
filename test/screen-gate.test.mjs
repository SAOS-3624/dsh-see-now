/**
 * screen-gate.test.mjs — 「屏幕读取总开关」（issue #77 第 3 条）。
 *
 * 这一条的性质和别的配置项不一样：它不是一个"改完下次生效"的调参，而是
 * **用户侧的硬闸**。所以测的不是"值存进去了没有"，而是三条：
 *
 * 1. 关掉之后 `watch` / `start` / `peek` 一律被拒，**连显式来源也不行**；
 * 2. 关掉时**顺手停采集**（不 teardown 的"关掉"是假的，采集还在跑）；
 * 3. **模型没有入口能打开它** —— 只有设置页和 `/seenow on`。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunner, guardReason } from '../src/runner.js';
import { readTuning, writeTuning, TUNING_DEFAULTS, WRITABLE_KEYS } from '../src/tuning.js';
import { createSeenowCommand } from '../src/command.js';

// ---------------------------------------------------------------- 纯函数

test('总开关：disabled 压过「显式来源」，也压过挂断与文件放完', () => {
  assert.equal(guardReason({ disabled: true }), 'disabled-by-user');
  // 这条是关键：显式来源能解开挂断，**不能**解开总开关 ——
  // 否则模型换个说法带上 src 就绕过去了，闸等于没有
  assert.equal(guardReason({ disabled: true, explicitSrc: true }), 'disabled-by-user');
  assert.equal(
    guardReason({ disabled: true, hungUp: true, fileEnded: true, explicitSrc: true }),
    'disabled-by-user',
  );
  // 不关时行为逐条不变（别为了新闸改坏老的三个）
  assert.equal(guardReason({}), null);
  assert.equal(guardReason({ explicitSrc: true }), null);
  assert.equal(guardReason({ hungUp: true }), 'hung-up');
});

// ---------------------------------------------------------------- runner

test('runner：默认开；关掉之后 watch / peek / start 全被拒，且不去开窗', async () => {
  const r = createRunner({ graceSec: 0 });
  assert.equal(r.enabled(), true);
  assert.equal(r.status().enabled, true);

  const out = r.setEnabled(false);
  assert.deepEqual({ enabled: out.enabled, wasEnabled: out.wasEnabled }, { enabled: false, wasEnabled: true });
  assert.equal(r.enabled(), false);
  assert.equal(r.status().enabled, false);
  // 关掉要顺手停采集：不停的话"关掉之后不采集"是假的
  assert.equal(r.status().running, false);

  const w = await r.watch({ seconds: 5 });
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'disabled-by-user');
  // 关键副作用检查：没去拉悬浮窗（否则等于"用户说别看，它还弹窗"）
  assert.equal(r.windowWasOpen(), false);

  assert.deepEqual(r.peek(), [], '关掉之后 peek 不能给队列里剩的图 —— 那些图正是他不想给的');

  // 连显式来源也不行（与 hungUp 不同）
  const w2 = await r.watch({ seconds: 5, src: { kind: 'screen' } });
  assert.equal(w2.reason, 'disabled-by-user');

  const s = await r.start({ src: { kind: 'screen' } });
  assert.equal(s.blocked, 'disabled-by-user');

  // 打开之后恢复，且不会残留"关着"的判据
  r.setEnabled(true);
  assert.equal(r.enabled(), true);
  assert.equal(guardReason({ disabled: !r.enabled() }), null);
});

test('runner：本来就是关着的时候启动（配置里 enabled:false）', async () => {
  const r = createRunner({ graceSec: 0, enabled: false });
  assert.equal(r.enabled(), false);
  const w = await r.watch({ seconds: 5 });
  assert.equal(w.reason, 'disabled-by-user');
  // `already` 不能回：回"已经在看了"会让模型以为还能接着看
  const s = await r.start({ src: { kind: 'screen' } });
  assert.equal(s.blocked, 'disabled-by-user');
  assert.equal(s.source, null);
});

// ---------------------------------------------------------------- 配置

test('配置：enabled 默认 true、进白名单、写成字符串要报错而不是静默当开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'see-gate-'));
  const env = { DSH_HOME: dir };
  try {
    assert.equal(TUNING_DEFAULTS.enabled, true);
    assert.ok(WRITABLE_KEYS.includes('enabled'), '面板要能改它，否则设置页那一格写不进去');

    // 没配过 → 开
    assert.equal(readTuning({ env, readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } }).enabled, true);

    // "false" 是字符串真值：必须报出来、并按默认（开）处理
    const bad = readTuning({ env, readFile: () => JSON.stringify({ enabled: 'false' }) });
    assert.equal(bad.enabled, true);
    assert.ok(bad.warnings.some((w) => w.includes('enabled')), '写成字符串必须留下一条警告');

    // 真布尔 false → 关，且没有警告
    const off = readTuning({ env, readFile: () => JSON.stringify({ enabled: false }) });
    assert.equal(off.enabled, false);
    assert.deepEqual(off.warnings, []);

    // 走面板那条路落盘，读回来还是关的
    const w = writeTuning({ enabled: false }, { env });
    assert.equal(w.ok, true);
    assert.equal(w.values.enabled, false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'see-now.json'), 'utf8')).enabled, false);
    assert.equal(readTuning({ env }).enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 命令

test('/seenow off：关闸并落盘；收工交给总开关那条路，不重复 shutDownAll', async () => {
  const calls = [];
  let gate = true;
  const cmd = createSeenowCommand({
    log: () => {},
    setScreenEnabled: (v) => {
      calls.push(['gate', v]);
      gate = v;
      return { enabled: v, wasEnabled: !v };
    },
    openWindow: async () => ({ ok: true }),
    startCapture: async () => ({ started: true }),
    stopLoop: () => calls.push(['stopLoop']),
    stopCapture: () => calls.push(['stopCapture']),
    closeWindow: () => calls.push(['closeWindow']),
    ensureLoop: () => null,
    getLoop: () => null,
    statusText: () => '',
  });

  const off = cmd.handler({ rawInput: 'off' });
  assert.equal(off.kind, 'success');
  assert.equal(gate, false);
  assert.ok(off.text.includes('总开关'), '用户要知道这不只是关窗，是"别再看了"');
  // setScreenEnabled 内部已经做了收工三件套，这里再来一遍就是重复 spawn/kill
  assert.deepEqual(calls.filter((c) => c[0] !== 'gate'), []);

  // `/seenow on` 要能把闸打开（这是用户侧唯一的命令入口）
  const on = await cmd.handler({ rawInput: 'on' });
  assert.equal(on.kind, 'success');
  assert.equal(gate, true);
  // 打开时必须**先开闸再开窗**，否则采集起不来、用户看到"窗开了但什么都没发生"
  assert.deepEqual(calls.at(-1), ['gate', true]);
});

test('/seenow off：没有 setScreenEnabled 的调用方退回老路（shutDownAll 一次）', () => {
  const calls = [];
  const cmd = createSeenowCommand({
    log: () => {},
    stopLoop: () => calls.push('stopLoop'),
    stopCapture: () => calls.push('stopCapture'),
    closeWindow: () => calls.push('closeWindow'),
  });
  const off = cmd.handler({ rawInput: 'off' });
  assert.equal(off.kind, 'success');
  assert.deepEqual(calls, ['stopLoop', 'stopCapture', 'closeWindow'], '老路径必须还是这三步、这个顺序');
  assert.ok(!off.text.includes('总开关'), '没有总开关时不该说"总开关也关了"');
});

// ---------------------------------------------------------------- 设置页那条路

test('设置页 POST /config {enabled:false}：落盘 + 通知索引层（persist:false）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'see-gate-api-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let server = null;
  try {
    const seen = [];
    // 内存里的状态由这里记（真实实现是 runner.enabled()）
    let live = true;
    const { createSettingsApi, ROUTE_PREFIX } = await import('../src/settings-api.mjs');
    const handle = createSettingsApi({
      getEnabled: () => live,
      setEnabled: (next, o) => {
        seen.push({ next, persist: o?.persist });
        live = next;
        return { enabled: next };
      },
    });
    server = http.createServer((req, res) => { handle(req, res, undefined).catch(() => res.end('{}')); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`;

    const res = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { enabled: false } }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.values.enabled, false);

    // **persist:false** —— writeTuning 刚写完，再写一次是重复写盘
    assert.deepEqual(seen, [{ next: false, persist: false }]);
    assert.equal(JSON.parse(readFileSync(join(home, 'see-now.json'), 'utf8')).enabled, false);

    // /status 要报**实况**（内存），不是文件
    live = false;
    writeTuning({ enabled: true }, { env: { DSH_HOME: home } }); // 文件说开，内存说关
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.values.enabled, false, '面板要显示现在，不是文件里那份"下次启动的意图"');
  } finally {
    server?.close();
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
