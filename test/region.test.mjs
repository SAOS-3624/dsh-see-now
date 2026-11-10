/**
 * region 模式的几何与参数测试。
 *
 * 两部分：
 *  ① 新逻辑（parseRegion / cellSize / gridPlan / gridRects）逐条断言；
 *  ② **回归**：不传 region 时 `sourceArgs` 的输出必须与改动前逐字一致 ——
 *     这是「screen/obs/camera/file 四个源的现有行为一行不改」的机器证明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRegion, cellSize, gridPlan, gridRects } from '../src/layout.js';
import { sourceArgs } from '../src/capture.js';
import { createPipeline } from '../src/pipeline.js';

test('parseRegion：合法输入', () => {
  assert.deepEqual(parseRegion('400,300,400,800'), { x: 400, y: 300, w: 400, h: 800 });
  assert.deepEqual(parseRegion(' 0, 0, 2560, 1600 '), { x: 0, y: 0, w: 2560, h: 1600 });
  assert.deepEqual(parseRegion('400 300 400 800'), { x: 400, y: 300, w: 400, h: 800 });
  assert.deepEqual(parseRegion('400x300x400x800'), { x: 400, y: 300, w: 400, h: 800 });
});

test('parseRegion：非法输入一律 null（不能静默退化成全屏）', () => {
  assert.equal(parseRegion(''), null);
  assert.equal(parseRegion('400,300,400'), null);
  assert.equal(parseRegion('400,300,400,800,1'), null);
  assert.equal(parseRegion('400,300,0,800'), null);
  assert.equal(parseRegion('400,300,400,-1'), null);
  assert.equal(parseRegion('-1,300,400,800'), null);
  assert.equal(parseRegion('400.5,300,400,800'), null);
  assert.equal(parseRegion('a,b,c,d'), null);
  assert.equal(parseRegion(null), null);
  assert.equal(parseRegion(undefined), null);
  assert.equal(parseRegion({ x: 1 }), null);
});

test('cellSize：长边 = 档位长边，短边按 region 比例', () => {
  assert.deepEqual(cellSize(1600, { w: 400, h: 800 }), [800, 1600]);
  assert.deepEqual(cellSize(800, { w: 400, h: 800 }), [400, 800]);
  assert.deepEqual(cellSize(800, { w: 500, h: 890 }), [449, 800]);
  assert.deepEqual(cellSize(800, { w: 1000, h: 500 }), [800, 400]);
  assert.deepEqual(cellSize(800, { w: 800, h: 800 }), [800, 800]);
  assert.deepEqual(cellSize(1280, { w: 300, h: 900 }), [427, 1280]);
});

test('cellSize：极端比例也不会塌成 0', () => {
  const [w, h] = cellSize(800, { w: 1, h: 1000 });
  assert.ok(w >= 16, `w=${w}`);
  assert.equal(h, 800);
});

test('gridPlan：竖屏 9:16 的排列', () => {
  const a = 400 / 800;
  assert.deepEqual(pick(gridPlan(1, a)), [1, 1]);
  assert.deepEqual(pick(gridPlan(2, a)), [2, 1]);   // 1.125，最佳
  assert.deepEqual(pick(gridPlan(3, a)), [3, 1]);   // 1.688 优于 2x2 的 0.563
  assert.deepEqual(pick(gridPlan(4, a)), [2, 2]);   // 0.563
  assert.deepEqual(pick(gridPlan(6, a)), [3, 2]);   // 0.844（只做对照）
});

test('gridPlan：正方形单格', () => {
  assert.deepEqual(pick(gridPlan(2, 1)), [2, 1]);
  assert.deepEqual(pick(gridPlan(4, 1)), [2, 2]);
  // 3 帧正方格没有「零空格 + 接近 1:1」的排法：3×1 比例 3.0，2×2 比例 1.0 但要空一格。
  // 空格罚分 1.0 之后 2×2（0.333）仍胜 3×1（1.099）—— 宁可空一格也要正方形。
  assert.deepEqual(pick(gridPlan(3, 1)), [2, 2]);
});

test('gridPlan：横向 16:9 单格', () => {
  const a = 16 / 9;
  assert.deepEqual(pick(gridPlan(2, a)), [1, 2]);   // 竖着摞才接近 1:1
  assert.deepEqual(pick(gridPlan(4, a)), [2, 2]);
});

test('gridPlan：ratio 与 holes 自洽', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    for (const a of [0.5, 1, 1.7778]) {
      const g = gridPlan(n, a);
      assert.equal(g.cols * g.rows >= n, true);
      assert.ok(Math.abs(g.ratio - (g.cols * a) / g.rows) < 1e-9);
      assert.equal(g.holes, g.cols * g.rows - n);
    }
  }
});

test('gridRects：2 帧竖屏 → 800×800；4 帧 → 800×1600', () => {
  const r2 = gridRects(2, 400, 800, 0.5);
  assert.equal(r2.width, 800);
  assert.equal(r2.height, 800);
  assert.deepEqual(r2.rects.map((r) => [r.px, r.py]), [[0, 0], [400, 0]]);

  const r4 = gridRects(4, 400, 800, 0.5);
  assert.equal(r4.width, 800);
  assert.equal(r4.height, 1600);
  assert.deepEqual(r4.rects.map((r) => [r.px, r.py]),
    [[0, 0], [400, 0], [0, 800], [400, 800]]);
  assert.deepEqual(r4.rects.map((r) => r.index), [1, 2, 3, 4]);
});

test('gridRects：3 帧横排 1200×800', () => {
  const r = gridRects(3, 400, 800, 0.5);
  assert.equal(r.width, 1200);
  assert.equal(r.height, 800);
  assert.deepEqual(r.rects.map((x) => x.px), [0, 400, 800]);
});

/* ------------------------------------------------------------------ 回归 */

test('回归：screen 默认（ddagrab）参数不变', () => {
  assert.deepEqual(
    sourceArgs({ kind: 'screen' }, { engine: 'auto', fps: 12, platform: 'win32' }),
    ['-f', 'lavfi', '-i', 'ddagrab=framerate=12:draw_mouse=0'],
  );
});

test('回归：screen + gdigrab 无 region 参数不变', () => {
  assert.deepEqual(
    sourceArgs({ kind: 'screen' }, { engine: 'gdigrab', fps: 12, platform: 'win32' }),
    ['-f', 'gdigrab', '-framerate', '12', '-draw_mouse', '0', '-i', 'desktop'],
  );
});

test('regression: obs / camera / file 不变', () => {
  // 设备源只带 -rtbufsize：`-thread_queue_size` 会被某些 ffmpeg build 判成输出选项（#17）
  assert.deepEqual(
    sourceArgs({ kind: 'obs' }, { fps: 12, platform: 'win32' }),
    ['-rtbufsize', '256M', '-f', 'dshow', '-i', 'video=OBS Virtual Camera'],
  );
  assert.deepEqual(
    sourceArgs({ kind: 'camera', device: 'HD Webcam' }, { fps: 12, platform: 'win32' }),
    ['-rtbufsize', '256M', '-f', 'dshow', '-i', 'video=HD Webcam'],
  );
  assert.deepEqual(
    sourceArgs({ kind: 'file', path: 'C:\\a.mp4', realtime: true }, { platform: 'win32' }),
    ['-re', '-protocol_whitelist', 'file', '-i', 'C:\\a.mp4'],
  );
});

test('region：显式 gdigrab 时带 offset 与 video_size', () => {
  assert.deepEqual(
    sourceArgs(
      { kind: 'screen', engine: 'gdigrab', region: { x: 400, y: 300, w: 400, h: 800 } },
      { engine: 'auto', fps: 12, platform: 'win32' },
    ),
    ['-f', 'gdigrab', '-framerate', '12', '-draw_mouse', '0',
      '-offset_x', '400', '-offset_y', '300', '-video_size', '400x800',
      '-i', 'desktop'],
  );
});

/* ------------------------------------------------- pipeline 级（region 分支） */

/** 造测试帧：**纯色**，保证连续帧之间的差别大到能过切点/去重闸门 */
const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
function makeFrame(W, H, idx) {
  const [r, g, b] = COLORS[idx % COLORS.length];
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < buf.length; i += 3) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; }
  return buf;
}

test('region 模式：两帧拼成 2×1，画布 = 2*cellW × cellH', () => {
  const W = 40;
  const H = 80;
  const p = createPipeline({
    width: W, height: H, fps: 12,
    region: { x: 0, y: 0, w: W, h: H }, maxFrames: 4, preferFrames: 2,
  });
  // 间隔 1 秒：过了 cutMinGap(0.4s)，换色那一帧会被判成切点，两帧都能留下
  p.push({ t: 0, buf: makeFrame(W, H, 0) });
  p.push({ t: 1, buf: makeFrame(W, H, 1) });
  const r = p.finish();
  assert.equal(r.sheets.length, 1, '两帧应当已经封箱');
  const s = r.sheets[0];
  assert.equal(s.w, W * 2);
  assert.equal(s.h, H);
  assert.equal(s.frames.length, 2);
  assert.deepEqual(s.cells.map((c) => [c.px, c.py]), [[0, 0], [W, 0]]);
});

test('region 模式：flushNow 只按 maxFrames 截断，不调 pack 的 plan()', () => {
  const W = 40;
  const H = 80;
  const p = createPipeline({
    width: W, height: H, fps: 12,
    region: { x: 0, y: 0, w: W, h: H }, maxFrames: 4, preferFrames: 9,
  });
  for (let i = 0; i < 3; i += 1) p.push({ t: i, buf: makeFrame(W, H, i) });
  const s = p.flushNow();
  // **回归锁**：修复前 `flush()` 的 region 分支 `return;` 不返回值，
  // `flushNow()` 会清空 sheets 却交回 null —— 插话时图被丢掉、用户什么都看不到。
  assert.ok(s, 'flushNow 必须返回 sheet（修复前返回 null，等于丢图）');
  assert.equal(s.h, H);
  // 画布宽必须等于「帧数 × 单格宽」：几何和帧数对不上就是丢帧或错位
  assert.equal(s.w, s.frames.length * W);
  assert.ok(s.frames.length >= 2, `至少两帧进图，实际 ${s.frames.length}`);
});

/** [cols, rows] 方便断言 */
function pick(g) {
  return [g.cols, g.rows];
}
