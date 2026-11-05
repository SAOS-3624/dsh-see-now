import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-playback-'));
process.env.DSH_SEE_NO_WINDOW = '1';
const { sourceArgs } = await import('../src/capture.js');
const { createRunner } = await import('../src/runner.js');
test('文件源参数支持非负起点并拒绝非法值', () => {
  assert.deepEqual(sourceArgs({ kind:'file', path:'a.mp4', seek:8 }), ['-ss','8','-i','a.mp4']);
  assert.throws(() => sourceArgs({ kind:'file', path:'a.mp4', seek:-1 }), RangeError);
});
test('非文件源拒绝播放控制', async () => {
  const runner = createRunner();
  assert.equal((await runner.pause()).reason, 'not-file');
  runner.stop();
});
