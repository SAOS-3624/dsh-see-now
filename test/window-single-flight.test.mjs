// 开窗的"同时只开一次"闸（dsh-see-now#75）
//
// 社区实报：每次 `/seenow` 会起两个 window.py，关掉一个另一个也没了。
// 根因是两条路都会调 openWindow()（命令直开 + 循环的 ensureWindow），而 windowAlive()
// 看的是 pid 文件 —— pid 要 spawn 后 700ms 才写，两次调用挤在这段时间里就都会 spawn。
//
// 这里只测"闸"本身，不真开窗：
//   1. 并发两次拿到**同一个结果对象**（说明共享了同一次启动）
//   2. 上一次结束后闸要放开（否则第二次永远拿旧结果，用户关了窗就再也开不出来）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-singleflight-'));
process.env.DSH_HOME = home;
delete process.env.DSH_SEE_WINDOW;
delete process.env.DSH_SEE_PYTHON;
delete process.env.DSH_FLOAT_PYTHON;

const { openWindow, killWindowTree } = await import('../src/window.js');

test('并发两次 openWindow 共享同一次启动的结果', async () => {
  process.env.DSH_SEE_NO_WINDOW = '1';       // 不开真窗，只测闸
  try {
    const [a, b] = await Promise.all([openWindow(), openWindow()]);
    assert.equal(a, b, '两次调用必须是同一个结果对象（同一次启动）');
    assert.equal(a.ok, false);
    assert.equal(a.reason, 'disabled');
  } finally {
    delete process.env.DSH_SEE_NO_WINDOW;
  }
});

test('上一次结束后闸会放开，下一次是新的启动', async () => {
  process.env.DSH_SEE_NO_WINDOW = '1';
  try {
    const a = await openWindow();
    const b = await openWindow();
    assert.notEqual(a, b, '不是缓存：每次都要重新走一遍启动判断');
  } finally {
    delete process.env.DSH_SEE_NO_WINDOW;
  }
});

test('killWindowTree：非法 pid 返回 false，不抛', () => {
  assert.equal(killWindowTree(0), false);
  assert.equal(killWindowTree(-1), false);
  assert.equal(killWindowTree('nope'), false);
});
