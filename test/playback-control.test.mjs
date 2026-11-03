import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-playback-'));
process.env.DSH_SEE_NO_WINDOW = '1';
const { createRunner } = await import('../src/runner.js');

function playbackRunner() {
  const captures = [];
  const runner = createRunner({ ffmpegPath: process.execPath, graceSec: 60, openCaptureWindow: async () => ({ ok: false }),
    spawnCapture(options) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let finish; const done = new Promise((resolve) => { finish = resolve; });
      const capture = { options, done, pause() {}, resume() {}, stop() { finish({ reason: 'stopped', frames: 0, ms: 0 }); return done; },
        frame(t) { return options.onFrame({ t, buf: Buffer.alloc(options.width * options.height * 3, 30) }); } };
      captures.push(capture);
      if (captures.length > 1) queueMicrotask(() => capture.frame(options.baseSec));
      return capture;
    } });
  return { runner, captures };
}

test('播放控制：pause 停解码，resume 从已交付位置继续，seek 预览不提前推进位置', { timeout: 3000 }, async () => {
  const { runner, captures } = playbackRunner();
  try {
    await runner.start({ src: { kind: 'file', path: 'fixture.mp4' }, opts: { oneShot: true } });
    captures[0].frame(0); captures[0].frame(1 / 12);
    const first = runner.peek();
    runner.acknowledge(first);
    assert.equal((await runner.pause()).playback.state, 'paused');
    assert.equal(runner.status().running, false);
    assert.equal((await runner.seek(25)).ok, true);
    assert.equal(runner.status().playback.positionSec, first.to);
    assert.equal(runner.status().playback.requestedPositionSec, 25);
    assert.equal(captures.at(-1).options.baseSec, 25);
    const preview = await runner.watch({ seconds: 0.01, minFrames: 1 });
    assert.equal(preview.sheet.from, 25);
  } finally { await runner.stop(); }
});
