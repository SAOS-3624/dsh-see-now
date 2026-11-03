import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-playback-'));
process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';

const { createRunner } = await import('../src/runner.js');

function mockPlaybackRunner() {
  const captures = [];
  const runner = createRunner({
    ffmpegPath: process.execPath,
    graceSec: 60,
    openCaptureWindow: async () => ({ ok: false }),
    spawnCapture(options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      const capture = {
        options,
        done,
        pause() {},
        resume() {},
        stop() {
          finish({ reason: 'stopped', frames: 0, ms: 0 });
          return done;
        },
        frame(t) {
          return options.onFrame({ t, buf: Buffer.alloc(options.width * options.height * 3, 30) });
        },
      };
      captures.push(capture);
      if (captures.length > 1) queueMicrotask(() => capture.frame(options.baseSec));
      return capture;
    },
  });
  return { runner, captures };
}

test('单元：pause 停解码，resume 从已交付位置继续，seek 预览不提前推进位置', { timeout: 3000 }, async () => {
  const { runner, captures } = mockPlaybackRunner();
  try {
    await runner.start({ src: { kind: 'file', path: 'fixture.mp4' }, opts: { oneShot: true } });
    captures[0].frame(0);
    captures[0].frame(1 / 12);
    const first = runner.peek();
    assert.ok(first);
    runner.acknowledge(first);

    assert.equal((await runner.pause()).playback.state, 'paused');
    assert.equal(runner.status().running, false);

    assert.equal((await runner.seek(25)).ok, true);
    assert.equal(runner.status().playback.positionSec, first.to);
    assert.equal(runner.status().playback.requestedPositionSec, 25);
    assert.equal(captures.at(-1).options.baseSec, 25);

    const preview = await runner.watch({ seconds: 0.01, minFrames: 1 });
    assert.equal(preview.ok, true);
    assert.equal(preview.sheet.from, 25);
    assert.equal(preview.playback.state, 'paused');
  } finally {
    await runner.stop();
  }
});

function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function make20sFixture(dir) {
  const clip = join(dir, 'test-20s.mp4');
  if (existsSync(clip) && statSync(clip).size > 10_000) return clip;
  execFileSync('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12', '-t', '20',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip,
  ], { stdio: 'ignore' });
  return clip;
}

test('真实 20s 视频端到端：连续 4 次 watch 单调推进，pause -> seek 8 -> resume -> configure high', {
  timeout: 30000,
  skip: !ffmpegAvailable() && '需要系统安装 ffmpeg',
}, async () => {
  const fixture = make20sFixture(home);
  const tools = [];
  const savedImages = [];
  const fakeCtx = {
    tools: { register(t) { tools.push(t); return () => {}; } },
    logger: { warn() {}, error() {}, info() {} },
    attachments: {
      compression: 'png',
      async saveImage(o) {
        savedImages.push(o);
        return { attachmentId: `img-${savedImages.length}`, mediaType: o.mediaType, bytes: o.data.length };
      },
    },
  };

  const { apply } = await import('../src/index.js');
  const dispose = await apply(fakeCtx);
  const tool = tools[0];

  try {
    const times = [];
    // 连续 4 次 watch（scene 模式逐场景出图）：确认每一张都不同且位置单调严格递增
    for (let i = 0; i < 4; i += 1) {
      const res = await (i === 0
        ? tool.execute({ action: 'watch', source: 'file', path: fixture, scene: true, seconds: 5, minFrames: 1 })
        : tool.execute({ action: 'watch', seconds: 5, minFrames: 1 }));
      assert.equal(res.meta?.ok !== false, true, `第 ${i + 1} 次 watch 必须成功：${res.text}`);
      assert.ok(res.images?.length > 0, `第 ${i + 1} 次必须产生图片`);
      const to = res.meta.to;
      assert.ok(Number.isFinite(to), `第 ${i + 1} 次 to 必须有效`);
      if (times.length > 0) {
        assert.ok(to > times.at(-1), `位置必须单调严格递增：${to} > ${times.at(-1)}`);
      }
      times.push(to);
    }
    assert.equal(times.length, 4);

    // pause
    const pauseRes = await tool.execute({ action: 'pause' });
    assert.equal(pauseRes.meta?.playback?.state, 'paused');

    // seek 8
    const seekRes = await tool.execute({ action: 'seek', position: 8 });
    assert.equal(seekRes.meta?.ok, true);
    assert.equal(seekRes.meta?.playback?.requestedPositionSec, 8);
    assert.ok(seekRes.images?.length > 0, 'seek 必须返回预览图');

    // 在 paused 状态下 watch 必须能够拿到预览帧，且不破坏暂停
    const pausedWatch = await tool.execute({ action: 'watch', seconds: 1 });
    assert.equal(pausedWatch.meta?.playback?.state, 'paused');
    assert.ok(pausedWatch.meta?.from >= 8, `seek 8 后预览时间应在 8s 附近，实际: ${pausedWatch.meta?.from}`);

    // resume
    const resumeRes = await tool.execute({ action: 'resume' });
    assert.equal(resumeRes.meta?.playback?.state, 'playing');

    // resume 后的 watch 必须从 8s 之后继续向前推进
    const afterResume = await tool.execute({ action: 'watch', seconds: 5, minFrames: 1 });
    assert.equal(afterResume.meta?.ok !== false, true);
    assert.ok(afterResume.meta?.to > 8, `resume 后位置必须推进超过 8s，实际: ${afterResume.meta?.to}`);

    // configure high：切换清晰度不丢失文件位置
    const configRes = await tool.execute({ action: 'configure', quality: 'high' });
    assert.equal(configRes.meta?.ok, true);
    const afterConfig = await tool.execute({ action: 'watch', seconds: 5, minFrames: 1 });
    assert.equal(afterConfig.meta?.quality, 'high');
    assert.ok(afterConfig.meta?.to > afterResume.meta?.to, '切换清晰度后继续推进');

    // stop
    const stopRes = await tool.execute({ action: 'stop' });
    assert.equal(stopRes.meta?.ok, true);
  } finally {
    await dispose();
  }
});
