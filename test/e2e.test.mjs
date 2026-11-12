/**
 * e2e.test.mjs — **整条流程**：ffmpeg 采流 → 打分 → 档位 → 排布 → 截断 → PNG → 工具返回。
 *
 * 用 `source:"file"` 喂一段现场生成的合成视频（testsrc2 有持续运动），走的是和线上
 * 完全同一条代码路径，只是把「屏幕」换成「文件」—— 不用真的去抓桌面（那会拍到私事，
 * 而且结果不可复现）。
 *
 * ffmpeg 由 test/ffmpeg.mjs 统一解析（DSH_FFMPEG_PATH / DSH_HOME / PATH）；没有就跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

// 绝对路径：工具入口只收本机文件的绝对路径
const FIXTURE = resolve('.tmp', 'e2e-clip.mp4');

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  // testsrc2 每个区域都在动 → 积分帧会持续触发，能攒出真正的多帧图
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '24',
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
      async saveImage(o) {
        assert.equal(this.compression, 'png', 'saveImage 必须 .call(svc)');
        saved.push(o);
        return { attachmentId: `e2e-${saved.length}`, mediaType: o.mediaType, bytes: o.data.length };
      },
    },
  };
  return { ctx, registered, saved };
}

const skip = (!existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools')
  || (!ffmpegOk() && '没有 ffmpeg');

test('端到端：喂一段视频，工具返回一张真图 + 清单', { skip, timeout: 120_000 }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const clip = makeFixture();
  const mod = await import('../src/index.js');
  const { ctx, registered, saved } = fakeCtx();
  const dispose = await mod.apply(ctx);

  try {
    const v = await registered[0].execute({
      action: 'watch', source: 'file', path: clip, seconds: 30, minFrames: 1,
    });

    assert.ok(v.images?.length === 1, `应该有 1 张图，实际 ${JSON.stringify(v.meta)}`);
    assert.equal(saved.length, 1, '图要经过 attachments.saveImage');
    assert.equal(saved[0].mediaType, 'image/png');

    const png = saved[0].data;
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '必须是合法 PNG');
    assert.ok(png.length > 5000, `图像太小：${png.length}`);

    assert.match(v.text, /个画面/, '清单要说清这张里几个画面');
    assert.ok(v.meta.frames >= 1, '至少要有一帧');
    // 这里**不能卡绝对下限**：fill 由这一轮抓到几帧决定（文件回放吃真实时间，
    // from/to 每次都不一样），同一 fixture 连跑 12 次落在 0.5~0.833，偶发 0.25
    // （只攒到 1 帧、铺在 2×2 画布的一格）。绝对比较归 pack.test.mjs，那边用的是
    // 相对涨幅；这条只守"别出空白图"。
    assert.ok(v.meta.fill > 0.15, `fill 太低：${v.meta.fill}`);
    assert.ok(v.meta.to >= v.meta.from, '时间区间要成立（单帧时首尾相等）');
  } finally {
    dispose();
  }
});

test('端到端：同一段视频连看两次，第二张不会重复第一张', { skip, timeout: 120_000 }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const clip = makeFixture();
  const mod = await import('../src/index.js');
  const { ctx, registered, saved } = fakeCtx();
  const dispose = await mod.apply(ctx);

  try {
    const a = await registered[0].execute({ action: 'watch', source: 'file', path: clip, seconds: 30 });
    const b = await registered[0].execute({ action: 'watch', seconds: 10 });
    assert.ok(a.images?.length === 1 && b.images?.length === 1, '两次都要有图');
    assert.ok(b.meta.from >= a.meta.to - 0.2, `第二张要接着往后：${a.meta.from}–${a.meta.to} / ${b.meta.from}`);
  } finally {
    dispose();
  }
});

test('切清晰度：quality 一换，回来的图分辨率就跟着变', { skip, timeout: 120_000 }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const clip = makeFixture();
  const mod = await import('../src/index.js');
  const { ctx, registered, saved } = fakeCtx();
  const dispose = await mod.apply(ctx);

  const dims = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

  /**
   * 只断言**宽度**和"高度还在合理区间"，不再钉死高度。
   *
   * 为什么：帧少时下面会空出整条，`sheet.js::cropToContent` 会把那条从画布上裁掉
   * （两帧并排 → 画面高度减半）。高度从此**取决于这一轮抓到几帧**，钉死就会变成
   * "改一次排布就红一次"的假失败。清晰度真正改变的是宽度，这条守住就够了。
   */
  const check = (buffer, wantW, strip, name) => {
    const [w, h] = dims(buffer);
    assert.equal(w, wantW, `${name} 的宽度 = ${wantW}`);
    assert.ok(h > strip && h <= strip + wantW, `${name} 的高度要在「画面 + ${strip}px 条」区间内，实际 ${h}`);
  };

  try {
    const lo = await registered[0].execute({
      action: 'watch', source: 'file', path: clip, seconds: 20, quality: 'low',
    });
    assert.ok(lo.images?.length === 1, 'low 要出图');
    check(saved[0].data, 798, 12, 'low = 798 宽 + 12px 音轨条');

    const hi = await registered[0].execute({ action: 'watch', quality: 'high' });
    assert.ok(hi.images?.length === 1, 'high 要出图（换了清晰度要立刻给一帧）');
    check(saved[1].data, 1260, 36, 'high = 1260 宽 + 36px 条');
    assert.equal(hi.meta.quality, 'high');

    const back = await registered[0].execute({ action: 'watch', quality: 'standard' });
    check(saved[2].data, 1050, 30, 'standard = 1050 宽 + 30px 条');
    assert.ok(back.meta.frames >= 1);
  } finally {
    dispose();
  }
});
