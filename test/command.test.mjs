/**
 * command.test.mjs — `/seenow` 斜杠命令（魔改 #1）的契约。
 *
 * 病的现场：用户想"看一眼屏幕"先打 `/`，菜单里没有它 —— 这个插件以前
 * **只注册了工具，没有命令**。命令是宿主侧的直达通道：不进模型、不花一轮，
 * 开了窗、起了采集、把循环绑到发命令的会话，然后 steer 一句话告诉模型"眼睛开了"。
 *
 * 这里只测命令对象本身（`createSeenowCommand`）和注册器的降级行为，
 * 不碰真的窗口/采集 —— 那些由 `index.js` 注入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { createSeenowCommand, registerSeenowCommand, shutDownAll, COMMAND_NAME, COMMAND_USAGE, START_NOTE } =
  await import('../src/command.js');

/** 全套假依赖：记录每个入口被调了几次、带了什么参数。 */
function fakeDeps({ windowOk = true } = {}) {
  const log = [];
  const calls = {
    openWindow: [], setWindowHidden: [], startCapture: 0, stopCapture: 0,
    ensureLoop: [], stopLoop: [], closeWindow: 0, steer: [], followup: [],
  };
  const deps = {
    log: (m) => log.push(m),
    openWindow: async (o) => { calls.openWindow.push(o); return { ok: windowOk, reason: windowOk ? undefined : 'no-python' }; },
    closeWindow: () => { calls.closeWindow += 1; },
    setWindowHidden: (h) => { calls.setWindowHidden.push(h); },
    startCapture: async () => { calls.startCapture += 1; return { ok: true, source: { kind: 'screen' } }; },
    stopCapture: () => { calls.stopCapture += 1; },
    ensureLoop: (owner) => { calls.ensureLoop.push(owner); return { stopped: () => false, state: () => ({ wakes: 0, session: owner }) }; },
    getLoop: () => null,
    stopLoop: (reason) => { calls.stopLoop.push(reason); },
    getCaller: () => 'session-A',
    statusText: () => '看屏幕：没在跑\n窗口：没开过\n循环：没起',
  };
  const agent = {
    session: { header: { id: 'session-A' } },
    steer: (m) => calls.steer.push(m.content?.[0]?.text ?? ''),
    followup: (m) => calls.followup.push(m.content?.[0]?.text ?? ''),
  };
  return { deps, calls, log, agent };
}

test('命令名合法（宿主只认 /^[a-z][a-z0-9_-]*$/）', () => {
  assert.equal(COMMAND_NAME, 'seenow');
  assert.match(COMMAND_NAME, /^[a-z][a-z0-9_-]*$/);
});

test('/seenow：开窗 → 起采集 → 循环绑到**发命令的会话** → steer 告诉模型', async () => {
  const { deps, calls, agent } = fakeDeps();
  const cmd = createSeenowCommand(deps);
  const r = await cmd.handler({ agent, rawInput: '' });

  assert.equal(r.kind, 'success');
  assert.equal(calls.openWindow.length, 1, '要开窗');
  assert.deepEqual(calls.setWindowHidden, [false], '开窗要顺带把"藏起来"的配置解开');
  assert.equal(calls.startCapture, 1, '要起采集');
  assert.deepEqual(calls.ensureLoop, ['session-A'], '循环必须绑到发命令的这个会话（不是"最后说过话的"）');
  assert.equal(calls.steer.length, 1, '必须 steer 告诉模型 —— followup 会排到下一轮');
  assert.equal(calls.steer[0], START_NOTE);
  assert.equal(calls.followup.length, 0);
  assert.match(r.text, /已打开/);
});

test('/seenow off：停循环 → 停采集 → 关窗 → 告诉模型别再看', async () => {
  const { deps, calls, agent } = fakeDeps();
  const cmd = createSeenowCommand(deps);
  const r = await cmd.handler({ agent, rawInput: 'off' });
  assert.equal(r.kind, 'success');
  assert.equal(calls.stopLoop.length, 1);
  assert.equal(calls.stopCapture, 1);
  assert.equal(calls.closeWindow, 1);
  assert.equal(calls.steer.length, 1);
  assert.match(r.text, /已关闭/);
});

/**
 * issue #76：`see_now({action:"stop"})` 以前只停循环和采集、把窗留在屏幕上 ——
 * 循环没了就等于 `chat.jsonl` 没人消费，窗里打的字回车有反应、永远没有回音。
 * 现在 stop 与 `/seenow off` 共用「彻底收工」三件套。
 */
test('收工三件套：顺序是 停循环 → 停采集 → 关窗（#76）', () => {
  const order = [];
  const r = shutDownAll({
    stopLoop: (reason) => order.push('loop:' + reason),
    stopCapture: () => order.push('capture'),
    closeWindow: () => order.push('window'),
  }, '手动 stop');
  assert.deepEqual(order, ['loop:手动 stop', 'capture', 'window'],
    '循环必须先停：先关窗会被判成"用户关窗"，落一条挂断、以后 watch 全被硬闸拦');
  assert.equal(r.windowClosed, true);
});

test('收工三件套：哪一步没在跑/抛错，后面两步照走', () => {
  const order = [];
  const r = shutDownAll({
    stopLoop: () => { throw new Error('没在跑'); },
    // stopCapture 干脆不给
    closeWindow: () => order.push('window'),
  });
  assert.deepEqual(order, ['window']);
  assert.equal(r.windowClosed, true);
  assert.equal(shutDownAll({}).windowClosed, false, '什么都没给也不能抛');
});

test('/seenow status：给三行短状态（不是工具那十几行）', async () => {
  const { deps, agent } = fakeDeps();
  const cmd = createSeenowCommand(deps);
  const r = cmd.handler({ agent, rawInput: 'status' });
  assert.equal(r.kind, 'success');
  assert.match(r.text, /看屏幕/);
  assert.match(r.text, /循环/);
});

test('/seenow show / hide 走窗口可见性', async () => {
  const { deps, calls, agent } = fakeDeps();
  const cmd = createSeenowCommand(deps);
  assert.equal(cmd.handler({ agent, rawInput: 'show' }).kind, 'success');
  assert.equal(cmd.handler({ agent, rawInput: 'hide' }).kind, 'success');
  assert.deepEqual(calls.setWindowHidden, [false, true]);
});

test('/seenow 乱参数：报用法，不抛', () => {
  const { deps, agent } = fakeDeps();
  const cmd = createSeenowCommand(deps);
  const r = cmd.handler({ agent, rawInput: 'dance' });
  assert.equal(r.kind, 'error');
  assert.equal(r.text, COMMAND_USAGE);
});

test('/seenow 开窗失败：返回 error，不假装成功', async () => {
  const { deps, calls, agent } = fakeDeps({ windowOk: false });
  const cmd = createSeenowCommand(deps);
  const r = await cmd.handler({ agent, rawInput: '' });
  assert.equal(r.kind, 'error');
  assert.match(r.text, /没开起来/);
  assert.equal(calls.startCapture, 0, '窗都没开，别起采集');
});

test('注册器：宿主没有 commands 服务时返回 null（不拖垮整个插件）', () => {
  const bare = { get: () => undefined };
  assert.equal(registerSeenowCommand(bare, {}), null);
  assert.equal(registerSeenowCommand({}, {}), null);
});

test('注册器：有 commands 服务就注册，并返回可 dispose 的函数', () => {
  const registered = [];
  const ctx = { get: (n) => (n === 'commands' ? { register: (d) => { registered.push(d); return () => { registered[0].disposed = true; }; } } : undefined) };
  const dispose = registerSeenowCommand(ctx, fakeDeps().deps);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'seenow');
  assert.equal(typeof registered[0].handler, 'function');
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(registered[0].disposed, true);
});
