/**
 * tuning-write.test.mjs — `writeTuning()`：设置面板的保存路径。
 *
 * 面板做的事是"把用户手改的 JSON 换成表单"，所以比读多三条约束，每条都对应
 * 一次会让人丢掉配置的事故：
 *
 *   1. 只动白名单的键 —— 否则面板保存一次，用户手写的段就没了
 *   2. 校验复用 `readTuning` —— 否则同一份规则写两遍，总有一天不一致
 *   3. 只写提交过的键 —— 否则改一个值，文件里多出九个默认值
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { writeTuning, readTuning, tuningPath } from '../src/tuning.js';

const ENV = { DSH_HOME: '/tmp/dsh-home' };
const PATH = tuningPath(ENV);

/** 内存文件系统。`readFile` 抛 ENOENT 的形状要和真 fs 一致，`readRaw` 靠 code 判断。 */
function memFs(initial = null) {
  const files = new Map();
  if (initial !== null) files.set(PATH, initial);
  return {
    files,
    readFile: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFile: (p, data) => { files.set(p, data); },
    mkdir: () => {},
  };
}

const stored = (fs) => JSON.parse(fs.files.get(PATH));
const opts = (fs) => ({ env: ENV, ...fs });

test('文件不存在 → 只写提交的那一个键', () => {
  const fs = memFs();
  const r = writeTuning({ idleStopMin: 10 }, opts(fs));
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { idleStopMin: 10 });
  assert.deepEqual(stored(fs), { idleStopMin: 10 });
  assert.equal(r.path, PATH);
});

test('不认识的顶层字段 → 整份拒写，文件不动', () => {
  const fs = memFs();
  const r = writeTuning({ idleStopMs: 900000 }, opts(fs));
  assert.equal(r.ok, false);
  assert.match(r.rejected[0], /不认识/);
  assert.equal(fs.files.has(PATH), false);
});

test('越界值 → 拒写，原因用的是 readTuning 的原话', () => {
  const fs = memFs();
  const r = writeTuning({ idleStopMin: 9999 }, opts(fs));
  assert.equal(r.ok, false);
  assert.match(r.rejected[0], /0–1440/);
  assert.equal(fs.files.has(PATH), false);
});

test('listen 段越界（liveStep 大于 maxSeg）→ 拒写', () => {
  const fs = memFs();
  const r = writeTuning({ listen: { liveStep: 9 } }, opts(fs));
  assert.equal(r.ok, false);
  assert.match(r.rejected[0], /liveStep/);
  assert.equal(fs.files.has(PATH), false);
});

test('listen 里不认识的字段 → 拒写', () => {
  const fs = memFs();
  const r = writeTuning({ listen: { cursors: true } }, opts(fs));
  assert.equal(r.ok, false);
  assert.match(r.rejected[0], /listen 里不认识/);
});

test('用户手写的键在保存后仍在（合并而不是覆盖）', () => {
  const fs = memFs(JSON.stringify({ idleStopMin: 5, myOwnNote: 'hello' }));
  const r = writeTuning({ idleStopMin: 9 }, opts(fs));
  assert.equal(r.ok, true);
  assert.deepEqual(stored(fs), { idleStopMin: 9, myOwnNote: 'hello' });
});

test('文件里原本有历史错误时，合法提交照样能存', () => {
  // maxAutonomousWakes: 0 是旧错误，读出来会一直警告；面板不该因此永远存不进去
  const fs = memFs(JSON.stringify({ maxAutonomousWakes: 0 }));
  const r = writeTuning({ idleStopMin: 7 }, opts(fs));
  assert.equal(r.ok, true);
  assert.deepEqual(stored(fs), { maxAutonomousWakes: 0, idleStopMin: 7 });
  // 但那条历史警告仍然报给前端
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /maxAutonomousWakes/);
});

test('历史坏值不会让另一个坏值蒙混过关', () => {
  // 先手写一个坏 tierStyle；再提交另一个坏值。旧实现两句警告一模一样，
  // `added` 为空会放行，然后静默把值写成默认值。
  const fs = memFs(JSON.stringify({ tierStyle: 'foo' }));
  const r = writeTuning({ tierStyle: 'bar' }, opts(fs));
  assert.equal(r.ok, false);
  assert.match(r.rejected[0], /tierStyle/);
  assert.equal(stored(fs).tierStyle, 'foo', '拒写时文件不能动');
});

test('listen 是浅合并，不冲掉同段其它键', () => {
  const fs = memFs(JSON.stringify({ listen: { silence: 0.5, pollMs: 200 } }));
  const r = writeTuning({ listen: { silence: 0.7 } }, opts(fs));
  assert.equal(r.ok, true);
  assert.deepEqual(stored(fs).listen, { silence: 0.7, pollMs: 200 });
});

test('写出来的文件能被 readTuning 原样读回', () => {
  const fs = memFs();
  writeTuning({ idleStopMin: 12, listen: { maxSeg: 5 } }, opts(fs));
  const t = readTuning({ env: ENV, readFile: fs.readFile });
  assert.equal(t.idleStopMin, 12);
  assert.equal(t.idleStopMs, 720000);
  assert.equal(t.listen.maxSeg, 5);
  assert.deepEqual(t.warnings, []);
});

test('speechPacing 接受 "guard"', () => {
  const fs = memFs();
  const r = writeTuning({ speechPacing: 'guard' }, opts(fs));
  assert.equal(r.ok, true);
  assert.equal(stored(fs).speechPacing, 'guard');
});

test('非对象提交被拒', () => {
  const fs = memFs();
  for (const bad of [null, [], 'idleStopMin=3']) {
    const r = writeTuning(bad, opts(fs));
    assert.equal(r.ok, false);
    assert.match(r.rejected[0], /必须是 JSON 对象/);
  }
  assert.equal(fs.files.has(PATH), false);
});

test('写盘失败 → 报出是哪一步，不静默', () => {
  const fs = memFs();
  const r = writeTuning({ idleStopMin: 4 }, {
    env: ENV, ...fs,
    writeFile: () => { throw new Error('EACCES') },
  });
  assert.equal(r.ok, false);
  assert.match(r.rejected[0], /失败/);
  assert.match(r.rejected[0], /EACCES/);
});
