/**
 * offload-session.test.mjs — **自动省略只动"图交给了的那个会话"**（#52 / #55 剩下的那条路径）。
 *
 * 病：交付后的自动省略在 `setTimeout` 里现取 `lastCallerSessionId`。`watch` 要阻塞
 * 15–40 秒，这期间另一个会话随便调一次 see_now（status / help 都算）就把它改成自己，
 * 于是 A 的图交完了，省略却去重放 B 的日志 —— B 超线时把 B 的老图省掉，A 反而没省。
 * 节流又只有一个全局时间戳：A 刚检查过，30 秒内 B 交的图就不检查了。
 *
 * 修的规矩：交付方把会话 id 透传给省略（watch 用开始等待前锁定的 owner），节流按会话记。
 *
 * 不碰真会话：`resolveAgent` 回的是假会话，`append` 只记账。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-offload-'));
process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';
// 触发线压低：假会话里 5 张图就超线，省到只剩 1 张
writeFileSync(join(home, 'see-now.json'), JSON.stringify({ imageTrigger: 3, imageKeep: 1 }));

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
process.env.DSH_TOOLS_PATH = TOOLS_PATH;

// 绝对路径：`source:"file"` 的 path 按工具说明就该是绝对路径
const FIXTURE = resolve('.tmp', 'offload-session-clip.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '8',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

/** 每条消息一张图的会话日志（和 offload.test.mjs 同一个形状） */
const history = (n) => Array.from({ length: n }, (_, i) => ({
  type: 'user/message',
  seq: i + 1,
  data: { message: { role: 'user', content: [{ type: 'image', attachment: { attachmentId: `img-${i + 1}`, bytes: 1024 } }] } },
  surfaceOp: 'append',
}));

/**
 * 假上下文：两个会话各有 5 张图（都超线）。`append` 记下是哪个会话被写了 `image/offload`。
 * `gate` 给了就让 `saveImage` 卡在那里 —— 用它把"交付前另一个会话插进来"排成确定的顺序。
 */
function fakeCtx({ gate = null } = {}) {
  const registered = [];
  const appended = [];
  let saves = 0;
  const sessionOf = (id) => ({
    snapshotEvents: () => history(5),
    append: (type, data) => { appended.push({ id, type, data }); },
  });
  const ctx = {
    tools: { register(t) { registered.push(t); return () => {}; } },
    attachments: {
      async saveImage() {
        saves += 1;
        if (gate) await gate;
        return { attachmentId: `see-${saves}` };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {}; },
    sessionController: {
      async resolveAgent(id) { return { agent: { session: sessionOf(id) } }; },
    },
  };
  return { ctx, registered, appended, saves: () => saves };
}

/** 宿主在工具调用里会给的 `run`：`{ agent: { session } }`。 */
const runOf = (id) => ({ agent: { session: { header: { id, delegationDepth: 0 } } } });

async function until(pred, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(20);
  }
  return true;
}

const skip = (!ffmpegOk() && '没有 ffmpeg，跳过')
  || (!existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools，跳过（设 DSH_TOOLS_PATH 可指定）');

test('A 的 watch 交付前 B 调了一次 see_now：自动省略仍然只落在 A', { skip, timeout: 60_000 }, async () => {
  const { apply } = await import('../src/index.js');
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctx, registered, appended, saves } = fakeCtx({ gate });
  const dispose = await apply(ctx);
  try {
    const pending = registered[0].execute({
      action: 'watch', source: 'file', path: makeFixture(), seconds: 20,
    }, runOf('session-A'));

    // 图已经拿到、正在交给宿主（卡在 saveImage）—— 这时 B 会话调一次任意动作
    assert.ok(await until(() => saves() > 0, 30_000), 'A 的 watch 应该拿到图');
    await registered[0].execute({ action: 'help' }, runOf('session-B'));
    release();

    const r = await pending;
    assert.ok(Array.isArray(r?.images) && r.images.length > 0, 'A 应该拿到图');

    assert.ok(await until(() => appended.length > 0), '交付后应该触发一次自动省略');
    await sleep(200);
    const ids = appended.map((a) => a.id);
    assert.deepEqual(
      ids, ['session-A'],
      `省略应该只落在交付的会话（session-A）上，实际：${JSON.stringify(ids)}\n`
      + '落到 session-B 就是"A 的图交完了，却去省 B 的历史"',
    );
    assert.equal(appended[0].type, 'image/offload');
  } finally {
    release();
    dispose();
  }
});

test('节流按会话记：A 刚检查过，B 紧接着交付也要检查 B', { skip, timeout: 60_000 }, async () => {
  const { apply } = await import('../src/index.js');
  const { ctx, registered, appended } = fakeCtx();
  const dispose = await apply(ctx);
  try {
    const a = await registered[0].execute({
      action: 'watch', source: 'file', path: makeFixture(), seconds: 20,
    }, runOf('session-A'));
    assert.ok(a?.images?.length > 0, 'A 应该拿到图');
    assert.ok(await until(() => appended.some((x) => x.id === 'session-A')), 'A 交付后应该省略 A');

    const b = await registered[0].execute({
      action: 'watch', source: 'file', path: makeFixture(), seconds: 20,
    }, runOf('session-B'));
    assert.ok(b?.images?.length > 0, 'B 应该拿到图');
    assert.ok(
      await until(() => appended.some((x) => x.id === 'session-B')),
      `B 交付后也应该检查 B（30 秒节流不能被 A 占掉），实际：${JSON.stringify(appended.map((x) => x.id))}`,
    );
    assert.equal(appended.filter((x) => x.id === 'session-A').length, 1, 'A 只省一次');
  } finally {
    dispose();
  }
});
