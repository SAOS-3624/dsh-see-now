/**
 * session-owner.test.mjs — issue #1 第 2 条的回归网。
 *
 * 病：`watch` 是阻塞的（15~40 秒）。等待期间任何会话的 `session/event` 都会
 * 改写 `lastSessionId`，而循环是在 `await runner.watch()` **返回之后**才创建的 ——
 * 于是"在 A 会话发起 watch，循环却绑到 B"。后续唤醒会把话投给另一个窗口。
 *
 * 修的规矩：**owner 在开始等待前锁定**，之后外面怎么变都不影响这一轮。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-owner-'));
process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';

// 注册工具要用宿主的 defineTool；没有就跳过（和 plugin.test.mjs 同一套判定）
const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
process.env.DSH_TOOLS_PATH = TOOLS_PATH;

// 绝对路径：工具入口只收本机文件的绝对路径
const FIXTURE = resolve('.tmp', 'owner-clip.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '8',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

/**
 * 假上下文：只提供注册、事件钩子、叫醒要用的服务。
 * `resolveAgent` 故意返回错误 —— 这个测试不需要真叫醒，也不能真去碰模型。
 */
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

const skip = (!ffmpegOk() && '没有 ffmpeg，跳过')
  || (!existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools，跳过（设 DSH_TOOLS_PATH 可指定）');

test('watch 等待期间别的会话事件不会改掉循环归属', { skip }, async () => {
  const { apply } = await import('../src/index.js');
  const { ctx, registered, emitSession } = fakeCtx();
  const dispose = await apply(ctx);
  try {
    emitSession('session-A');

    // 发起 watch 但**不 await**：让它进入阻塞等待。
    // `minFrames: 3` 是刻意的 —— `minFrames <= 1` 会走冷启动的"第一帧就到手"快路径
    // （1 秒内返回），那样 A→B 的事件根本插不进等待期，测不出归属竞争。
    const pending = registered[0].execute({
      action: 'watch',
      source: 'file',
      path: makeFixture(),
      realtime: true,
      seconds: 6,
      minFrames: 3,
    });

    // 等它真的进到等待里，再让另一个会话的事件插进来
    await sleep(800);
    emitSession('session-B');

    const r = await pending;
    assert.ok(r && typeof r.text === 'string', '这一轮 watch 应该正常返回');

    const st = await registered[0].execute({ action: 'status' });
    const sid = st?.meta?.loop?.session ?? null;
    assert.equal(
      sid, 'session-A',
      `循环应绑在发起 watch 的会话上（session-A），实际：${sid ?? 'null'}\n`
      + '绑到 session-B 就是 issue #1 说的归属竞争 —— 唤醒会投到另一个窗口',
    );
  } finally {
    dispose();
  }
});
