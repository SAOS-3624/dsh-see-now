import { test } from 'node:test';
import assert from 'node:assert/strict';

import { idleReason, shouldGoIdle, IDLE_STOP_MS, MAX_AUTONOMOUS_WAKES } from '../src/loop.js';

/**
 * 回归：社区实报「装上后会卡读图循环」。
 *
 * 常驻循环原来**只有"采集停了"一个退出条件** —— 屏幕一直在动（放视频、刷网页）
 * 就会每 15 秒叫醒模型一次，永远不停，用户什么都没问、会话却在一轮一轮读图。
 */

const NOW = 1_700_000_000_000;

test('连续自动唤醒达到上限就收工（窗开着也算）', () => {
  assert.equal(shouldGoIdle({ wakesSinceUser: MAX_AUTONOMOUS_WAKES - 1, now: NOW, lastUserAt: NOW, windowOpen: true }), false);
  assert.equal(shouldGoIdle({ wakesSinceUser: MAX_AUTONOMOUS_WAKES, now: NOW, lastUserAt: NOW, windowOpen: true }), true);
  // 窗开着也照样有上限 —— 防"窗开着但人走了"
  assert.equal(shouldGoIdle({ wakesSinceUser: 99, now: NOW, lastUserAt: NOW, windowOpen: true }), true);
});

test('没开悬浮窗 + 用户长时间不说话 → 收工', () => {
  // 刚聊过：不收
  assert.equal(shouldGoIdle({ wakesSinceUser: 1, now: NOW, lastUserAt: NOW - 1000, windowOpen: false }), false);
  // 超过阈值：收
  assert.equal(shouldGoIdle({ wakesSinceUser: 1, now: NOW, lastUserAt: NOW - IDLE_STOP_MS - 1, windowOpen: false }), true);
});

test('悬浮窗开着时不按"多久没说话"收工（陪看中途不说话是正常的）', () => {
  const long = NOW - IDLE_STOP_MS * 10;
  assert.equal(shouldGoIdle({ wakesSinceUser: 2, now: NOW, lastUserAt: long, windowOpen: true }), false);
  assert.equal(shouldGoIdle({ wakesSinceUser: 2, now: NOW, lastUserAt: long, windowOpen: false }), true);
});

// ---- 收工还是"只听"，取决于窗还在不在（社区实报 2026-11-03）----
import { idleAction } from '../src/loop.js';

test('idle 之后：窗开着只降级成"只听"，窗关掉才真收工', () => {
  assert.equal(idleAction({ idle: false, windowOpen: false }), 'continue');
  assert.equal(idleAction({ idle: false, windowOpen: true }), 'continue');
  assert.equal(idleAction({ idle: true, windowOpen: true }), 'listen',
    '窗还在屏幕上，用户随时会打字 —— 不能把耳朵一起拆掉');
  assert.equal(idleAction({ idle: true, windowOpen: false }), 'stop');
  assert.equal(idleAction({}), 'continue');
});

// ---- #69：`status` 必须说得出「为什么停」，两条线的原因不能糊成一个 ----
test('idleReason: 两条线各自报得出原因，没判到就是 null', () => {
  assert.equal(idleReason({ wakesSinceUser: 1, now: NOW, lastUserAt: NOW, windowOpen: true }), null);

  assert.equal(
    idleReason({ wakesSinceUser: MAX_AUTONOMOUS_WAKES, now: NOW, lastUserAt: NOW, windowOpen: true }),
    'wake-unanswered', '叫了 N 次没人理 —— 和"没开窗久了"是两件事');

  assert.equal(
    idleReason({ wakesSinceUser: 1, now: NOW, lastUserAt: NOW - IDLE_STOP_MS - 1, windowOpen: false }),
    'idle-silent', '没开窗 + 一阵没说话');

  // 两条同时成立时先报叫醒那条（它更"主动"，用户更容易对上号）
  assert.equal(
    idleReason({ wakesSinceUser: 99, now: NOW, lastUserAt: 0, windowOpen: false }),
    'wake-unanswered');
});
