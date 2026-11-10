/**
 * caller-owner.test.mjs — **循环的归属取"这一次调用"的会话**（魔改 #2）的回归网。
 *
 * 病（实测）：`lastSessionId` 是"这个进程里最后说过话的会话"，由 `session/event` 钩子
 * 随时改写。多开对话时它天然会被别的会话顶掉，于是"在 A 里打开的悬浮窗，话却投给了 B"。
 * 用户看到的三个症状里，第 2、3 条都是它。
 *
 * 修的规矩：宿主在工具调用里给了 `run.agent`（谁调的），**归属优先取它**；
 * `lastSessionId` 只当兜底。子会话（subagent，`delegationDepth > 0`）不算 ——
 * 它没有能给用户看的窗口，绑过去等于把话投进黑洞。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-caller-'));
process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
process.env.DSH_TOOLS_PATH = TOOLS_PATH;

// 绝对路径：工具入口只收本机文件的绝对路径
const FIXTURE = resolve('.tmp', 'caller-clip.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '8',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

/** 假上下文：注册、事件钩子、叫醒要用的服务（不真叫醒）。 */
function fakeCtx() {
  const registered = [];
  let onSession = null;
  const ctx = {
    tools: { register(t) { registered.push(t); return () => {}; } },
    attachments: { async saveImage() { return { attachmentId: 'repro' }; } },
    logger: { info() {}, warn() {}, error() {} },
    on(name, cb) { if (name === 'session/event') onSession = cb; return () => {}; },
    sessionController: { async resolveAgent() { return { error: 'mock-no-agent' }; } },
  };
  return { ctx, registered, emitSession: (id) => onSession?.({ header: { id } }) };
}

/** 宿主在工具调用里会给的 `run`：`{ agent: { session } }`。 */
function runOf(sessionId, { depth = 0 } = {}) {
  return { agent: { session: { header: { id: sessionId, delegationDepth: depth } } } };
}

const skip = (!ffmpegOk() && '没有 ffmpeg，跳过')
  || (!existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools，跳过（设 DSH_TOOLS_PATH 可指定）');

test('循环绑在**发起调用的会话**上，哪怕等待期间别的会话在说话', { skip }, async () => {
  const { apply } = await import('../src/index.js');
  const { ctx, registered, emitSession } = fakeCtx();
  const dispose = await apply(ctx);
  try {
    emitSession('session-A');

    // 带 `run.agent` 发起 watch（不 await，让它进阻塞等待）。
    // `minFrames: 3` 让它真的等一会儿 —— 否则 B 的事件插不进等待期，测不出竞争。
    const pending = registered[0].execute({
      action: 'watch',
      source: 'file',
      path: makeFixture(),
      realtime: true,
      seconds: 6,
      minFrames: 3,
    }, runOf('session-CALLER'));

    await sleep(800);
    // 等待期间"另一个会话"冒了一条事件 —— 旧实现会因此把归属改成 B
    emitSession('session-B');

    const r = await pending;
    assert.ok(r && typeof r.text === 'string', '这一轮 watch 应该正常返回');

    const st = await registered[0].execute({ action: 'status' });
    const sid = st?.meta?.loop?.session ?? null;
    assert.equal(
      sid, 'session-CALLER',
      `循环应绑在**发起调用的会话**（session-CALLER）上，实际：${sid ?? 'null'}\n`
      + '绑到 session-B 就是"在 A 里开窗、话投给 B"那个病',
    );
  } finally {
    dispose();
  }
});

test('子会话（subagent）不算归属，退回兜底 —— 它没有能给用户看的窗口', { skip }, async () => {
  const { apply } = await import('../src/index.js');
  const { ctx, registered, emitSession } = fakeCtx();
  const dispose = await apply(ctx);
  try {
    emitSession('session-TOP');

    const pending = registered[0].execute({
      action: 'watch',
      source: 'file',
      path: makeFixture(),
      realtime: true,
      seconds: 6,
      minFrames: 3,
    }, runOf('session-SUB', { depth: 2 }));

    const r = await pending;
    assert.ok(r && typeof r.text === 'string');

    const st = await registered[0].execute({ action: 'status' });
    const sid = st?.meta?.loop?.session ?? null;
    assert.equal(sid, 'session-TOP', `子会话不该抢归属，实际：${sid ?? 'null'}`);
  } finally {
    dispose();
  }
});
