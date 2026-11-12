/**
 * sheet-crop.test.mjs — 「整行空着的带子要不要发」的回归网。
 *
 * 排布是按档位走的：帧少时下面会空出整条（两帧并排 = 上半幅有图、下半幅灰条）。
 * 灰条**照样按画布面积计费**，所以要裁掉 —— 但裁的必须是画布，不是画面：
 * 格子的 `pw/ph` 一个都不许动，只准改画布尺寸 + 平移 `px/py`。
 *
 * 守的四条：
 *   ① 有整行空着 → 画布变矮，格子像素不变；
 *   ② 已经排满（4 格 2×2）→ **原样返回同一个数组**，不做任何拷贝；
 *   ③ 行内空洞（3 帧右上角）→ bbox 仍是整幅，裁不动（这是几何决定的，不是漏了）；
 *   ④ 上/左有空隙时坐标要整体平移，不能只改高度。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cropToContent } from '../src/sheet.js';

const W = 798;
const H = 450;

const rect = (px, py, pw, ph, t = 2) => ({ px, py, pw, ph, t });

test('两帧并排：下半幅空着 → 画布砍一半，格子像素不变', () => {
  const rects = [rect(0, 0, 399, 225), rect(399, 0, 399, 225)];
  const out = cropToContent(rects, W, H);
  assert.equal(out.cropped, true);
  assert.equal(out.height, 225);
  assert.equal(out.width, W);
  // 格子一个都没动
  assert.deepEqual(
    out.rects.map((r) => [r.px, r.py, r.pw, r.ph]),
    [[0, 0, 399, 225], [399, 0, 399, 225]],
  );
});

test('已经排满 2×2：原样返回同一个数组（不拷贝）', () => {
  const rects = [
    rect(0, 0, 399, 225), rect(399, 0, 399, 225),
    rect(0, 225, 399, 225), rect(399, 225, 399, 225),
  ];
  const out = cropToContent(rects, W, H);
  assert.equal(out.cropped, false);
  assert.equal(out.width, W);
  assert.equal(out.height, H);
  assert.equal(out.rects, rects);          // 同一个引用
});

test('单帧：画布缩到一格大小', () => {
  const out = cropToContent([rect(0, 0, 399, 225)], W, H);
  assert.equal(out.width, 399);
  assert.equal(out.height, 225);
  assert.equal(out.cropped, true);
});

test('三帧（洞在行内右上）：内容框仍整幅 → 裁不动', () => {
  const rects = [
    rect(0, 0, 399, 225),                  // 第一行左半
    rect(0, 225, 399, 225), rect(399, 225, 399, 225),
  ];
  const out = cropToContent(rects, W, H);
  assert.equal(out.cropped, false, '行内空洞不可能靠裁边界消掉');
  assert.equal(out.height, H);
});

test('上边/左边有空隙：坐标整体平移', () => {
  const rects = [rect(10, 40, 200, 100), rect(210, 40, 200, 100)];
  const out = cropToContent(rects, W, H);
  assert.equal(out.width, 400);            // 10..410
  assert.equal(out.height, 100);
  assert.deepEqual(
    out.rects.map((r) => [r.px, r.py]),
    [[0, 0], [200, 0]],
  );
  // 尺寸仍然没动
  assert.deepEqual(out.rects.map((r) => [r.pw, r.ph]), [[200, 100], [200, 100]]);
});

test('空输入 / 非数组：原样返回，不炸', () => {
  const a = cropToContent([], W, H);
  assert.equal(a.cropped, false);
  assert.equal(a.rects.length, 0);
  const b = cropToContent(null, W, H);
  assert.equal(b.width, W);
  assert.equal(b.height, H);
});
