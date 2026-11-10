/**
 * start-meta.test.mjs — `action:"start"` 的 `meta` 必须是**无损 JSON**（issue #60）。
 *
 * 病：`start` 分支把 `runner.start()` 的返回对象原样当 `meta`，里面有 `params`
 * （管道内部参数，含 `audio.levels` 这个**函数**）。宿主序列化时直接报
 * `value is not lossless JSON`，整个工具调用失败 —— 而 `watch` / `peek` 正常，
 * 所以看起来像"只有 start 坏了"。
 *
 * 这条断言用的就是宿主的判据：能不能 `JSON.parse(JSON.stringify())` 之后**逐字段相等**。
 * 有函数被丢掉、有 undefined 被吞掉，都会在这里露出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-startmeta-'));
process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';
process.env.DSH_SEE_NOW_INDICATOR = '0';

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
process.env.DSH_TOOLS_PATH = TOOLS_PATH;

// 绝对路径：工具入口只收本机文件的绝对路径
const FIXTURE = resolve('.tmp', 'start-meta-clip.mp4');

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 5000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12', '-t', '3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

function fakeCtx() {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: { register(t) { registered.push(t); return () => {}; } },
      attachments: { async saveImage() { return { attachmentId: 'repro' }; } },
      logger: { info() {}, warn() {}, error() {} },
      on() { return () => {}; },
      sessionController: { async resolveAgent() { return { error: 'mock-no-agent' }; } },
    },
  };
}

/** 宿主那套判据的等价物：往返一次必须一个字都不差。 */
function assertLossless(value, where = 'meta') {
  const round = JSON.parse(JSON.stringify(value));
  assert.deepEqual(round, value, `${where} 不是无损 JSON（有函数/undefined/NaN 被序列化吞掉了）`);
}

const skip = (!ffmpegOk() && '没有 ffmpeg，跳过')
  || (!existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools，跳过（设 DSH_TOOLS_PATH 可指定）');

test('action:"start" 的 meta 能无损过 JSON（带 params 里的函数就挂）', { skip }, async () => {
  const { apply } = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx);
  try {
    const r = await registered[0].execute({
      action: 'start',
      source: 'file',
      path: makeFixture(),
      realtime: true,
    });

    assert.ok(r && typeof r.text === 'string', 'start 应该返回文本');
    assert.equal(r.meta?.ok, true);
    assert.equal(r.meta?.sourceKind, 'file', '要报清楚这次看的是什么源');
    // 白名单之外的东西（尤其 `params`）不许出现在 meta 里
    assert.equal(r.meta?.params, undefined, 'meta 里不许带管道内部参数');
    assertLossless(r.meta, 'start 的 meta');
    assertLossless(r, '整个工具返回');
  } finally {
    try { registered[0] && await registered[0].execute({ action: 'stop' }); } catch { /* 没在跑 */ }
    dispose();
  }
});
