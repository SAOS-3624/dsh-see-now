/**
 * listen-source.test.mjs — `listen.source` / `listen.targetProcess` 的读取与校验（#34）。
 *
 * 这两个键决定"声音从哪条路进来"。写错一个值不能让听声音整条挂掉：
 * 非法值退回默认 + 留 warning，和 `listen` 段其它键一个口径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readTuning, LISTEN_SOURCES, WRITABLE_LISTEN_KEYS } from '../src/tuning.js';

const ENV = { DSH_HOME: '/tmp/dsh-home' };
const readJson = (obj) => () => JSON.stringify(obj);

test('默认 source=auto、targetProcess 为空（老用户行为不变）', () => {
  const t = readTuning({ env: ENV, readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.equal(t.listen.source, 'auto');
  assert.equal(t.listen.targetProcess, '');
  assert.deepEqual(t.warnings, []);
});

test('合法值生效，进程名两端空格要吃掉', () => {
  const t = readTuning({
    env: ENV,
    readFile: readJson({ listen: { source: 'process', targetProcess: '  chrome.exe ' } }),
  });
  assert.equal(t.listen.source, 'process');
  assert.equal(t.listen.targetProcess, 'chrome.exe', '带空格按名字找不到进程，等于静默失败');
  assert.deepEqual(t.warnings, []);
});

test('非法 source 退回 auto，并留下警告', () => {
  const t = readTuning({ env: ENV, readFile: readJson({ listen: { source: 'wasapi' } }) });
  assert.equal(t.listen.source, 'auto');
  assert.ok(t.warnings.some((w) => w.includes('listen.source')), '静默退回等于用户以为改生效了');
});

test('targetProcess 只认字符串；空串合法（= 自动挑）', () => {
  const bad = readTuning({ env: ENV, readFile: readJson({ listen: { targetProcess: 123 } }) });
  assert.equal(bad.listen.targetProcess, '');
  assert.ok(bad.warnings.some((w) => w.includes('targetProcess')));

  const ok = readTuning({ env: ENV, readFile: readJson({ listen: { targetProcess: '' } }) });
  assert.equal(ok.listen.targetProcess, '');
  assert.deepEqual(ok.warnings, []);
});

test('设置面板能写这两个键（否则只能手改文件）', () => {
  assert.ok(WRITABLE_LISTEN_KEYS.includes('source'));
  assert.ok(WRITABLE_LISTEN_KEYS.includes('targetProcess'));
  assert.deepEqual(LISTEN_SOURCES, ['auto', 'device', 'process']);
});
