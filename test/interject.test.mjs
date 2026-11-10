/**
 * interject.test.mjs — **插话**这条路的端到端：用户说话 → 立刻截断 → 那张图 + 那句话一起回来。
 *
 * 用一个临时的 DSH_HOME，不碰真的 `~/.dsh/see-now/chat.jsonl`（那是用户自己的聊天记录）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

const HOME = resolve('.tmp/see-home');
// 绝对路径：工具入口只收本机文件的绝对路径
const FIXTURE = resolve('.tmp', 'interject-clip.mp4');

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12', '-t', '30',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

function fakeCtx() {
  const registered = [];
  const saved = [];
  const ctx = {
    tools: { register(t) { registered.push(t); return () => {}; } },
    logger: { warn() {}, error() {}, info() {} },
    attachments: {
      compression: 'png',
      async saveImage(o) { saved.push(o); return { attachmentId: 'x' }; },
    },
  };
  return { ctx, registered, saved };
}

const skip = (!existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools')
  || (!ffmpegOk() && '没有 ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('stop 之后再 watch 能重新开始（不能"第二次就不行了"）', { skip, timeout: 120_000 }, async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  process.env.DSH_HOME = HOME;
  process.env.DSH_SEE_NO_WINDOW = '1';
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;

  const clip = makeFixture();
  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  const dispose = await mod.apply(ctx);

  try {
    const first = await registered[0].execute({
      action: 'watch', source: 'file', path: clip, realtime: true, seconds: 20,
    });
    assert.equal(first.images?.length, 1);

    await registered[0].execute({ action: 'stop' });

    // `teardown()` 故意留着 pipeline（好把队列里剩下的图发完），只看 `!pipeline`
    // 就会跳过启动、干等一张永远不会来的图 —— 用户看到的就是"第二次看不了了"。
    const again = await registered[0].execute({
      action: 'watch', source: 'file', path: clip, realtime: true, seconds: 20,
    });
    assert.equal(again.meta?.ok, undefined, '不该是失败结果');
    assert.ok(again.images?.length === 1, `stop 之后要能重新出图，实际：${again.text}`);
  } finally {
    dispose();
  }
});

test('status 要看得出「循环 / 队列 / 声音」三件事', { skip }, async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  process.env.DSH_HOME = HOME;
  process.env.DSH_SEE_NO_WINDOW = '1';
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;

  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  const dispose = await mod.apply(ctx);
  try {
    const v = await registered[0].execute({ action: 'status' });
    assert.match(v.text, /循环：/);
    assert.match(v.text, /队列：/);
    assert.match(v.text, /声音：/);
    assert.ok(v.meta && 'loop' in v.meta, 'meta.loop 要能看出循环状态');
  } finally {
    dispose();
  }
});

test('chat.jsonl：增量读，不重复读老消息', async () => {
  const home = resolve('.tmp/see-home-unit');
  rmSync(home, { recursive: true, force: true });
  process.env.DSH_HOME = home;
  const { appendChat, makeChatWatcher, chatFile } = await import('../src/chat.js');

  appendChat('user', '开播之前就有的');
  const poll = makeChatWatcher();
  assert.deepEqual(poll(), [], '第一次只记位置，不该把历史消息当成"刚说的"');

  appendChat('user', '第一句');
  assert.deepEqual(poll().map((e) => e.text), ['第一句']);
  assert.deepEqual(poll(), [], '读过的不该再来一次');

  appendChat('assistant', '它说的');
  appendChat('user', '第二句');
  assert.deepEqual(poll().map((e) => e.text), ['它说的', '第二句']);

  // 半行（写了但没写完）要留到下一次
  writeFileSync(chatFile(), '{"role":"user","text":"半', { flag: 'a' });
  assert.deepEqual(poll(), [], '半行要等');
});

test('插话：阻塞中用户说一句，立刻返回「那张图 + 那句话」', { skip, timeout: 120_000 }, async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  process.env.DSH_HOME = HOME;
  process.env.DSH_SEE_NO_WINDOW = '1';          // 测试里不开窗
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;

  const clip = makeFixture();
  const mod = await import('../src/index.js');
  const { appendChat } = await import('../src/chat.js');
  const { ctx, registered, saved } = fakeCtx();
  const dispose = await mod.apply(ctx);

  try {
    // 第一张是**冷启动**：不等攒满，第一帧到手就给（静止屏幕上攒满要 30~60 秒，
    // 用户说"看看我屏幕"等一分钟，体感就是"它没反应"）。
    const tFirst = Date.now();
    const first = await registered[0].execute({
      action: 'watch', source: 'file', path: clip, realtime: true, seconds: 30,
    });
    assert.ok(Date.now() - tFirst < 4000, `冷启动要秒回，实际 ${Date.now() - tFirst}ms`);
    assert.equal(first.images?.length, 1, '冷启动也要带图');
    assert.match(first.text, /刚打开/, '要说清这是"先给你此刻"，不是攒好的一批');

    // 第二张：管子已经温了，会真的阻塞 —— 插话要能从这段等待里把人叫出来
    const t0 = Date.now();
    const pending = registered[0].execute({
      action: 'watch', source: 'file', path: clip, realtime: true, seconds: 30,
    });

    // 600ms：足够让 watcher prime（第一拍就 prime），又早于"这一张攒好"
    await sleep(600);
    appendChat('user', '这个窗口里是什么？');

    const v = await pending;
    const ms = Date.now() - t0;

    assert.ok(ms < 4000, `插话应该立刻返回，实际等了 ${ms}ms`);
    assert.equal(v.meta.userText, '这个窗口里是什么？');
    assert.ok(v.images?.length === 1, '插话也要带图');
    assert.match(v.text, /用户刚说/);
    assert.match(v.text, /这个窗口里是什么/);
    assert.equal(saved.length, 2);
    assert.equal(saved[1].data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '必须是真 PNG');
  } finally {
    dispose();
  }
});
