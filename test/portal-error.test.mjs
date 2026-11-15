/**
 * portal-error.test.mjs — portal 采集失败要分清"没装包"和"这台机器没有图形会话"。
 *
 * 来源是 #68：proot / 容器里 python3-gi、gstreamer、pipewire 全装齐了，仍然被劝
 * "去 sudo apt install"。真实错误是
 *   `gi.repository.GLib.GError: Cannot autolaunch D-Bus without X11 $DISPLAY (0)`
 * —— 那是 gi 抛的未捕获异常，python 退 1，跟"缺依赖"撞在同一个退出码上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PORTAL_HINTS, classify } from '../src/portal-capture.js';

const DBUS_TAIL = 'gi.repository.GLib.GError: Cannot autolaunch D-Bus without X11 $DISPLAY (0)';

test('没有图形会话（D-Bus 起不来）→ no-desktop-session，不是缺依赖', () => {
  assert.equal(classify(1, DBUS_TAIL), 'no-desktop-session');
  // 换几种原文写法也要认
  assert.equal(classify(1, 'Gtk-WARNING: cannot open display :0'), 'no-desktop-session');
  assert.equal(classify(1, 'Unable to init server: Could not connect: Connection refused'),
    'no-desktop-session');
  assert.equal(classify(1, 'error: XDG_RUNTIME_DIR is not set in the environment'),
    'no-desktop-session');
});

test('no-desktop-session 的话术必须说"装包解决不了"', () => {
  const hint = PORTAL_HINTS['no-desktop-session'];
  assert.ok(hint, '必须有这条提示');
  assert.match(hint, /装包解决不了/, '不能让人再去装包');
  assert.match(hint, /source:"file"|see-on-phone/, '要给出能走的路');
});

test('真的缺依赖时仍然是 dependency-missing', () => {
  assert.equal(classify(1, "ModuleNotFoundError: No module named 'gi'"), 'dependency-missing');
  assert.equal(classify(1, 'gst-inspect-1.0: 找不到 pipewiresrc'), 'dependency-missing');
  // 退出码 1 且 stderr 为空：保守归到缺依赖（老行为，不能因为没证据就改口）
  assert.equal(classify(1, ''), 'dependency-missing');
});

test('用户拒绝授权 / 取消仍然是 permission-denied', () => {
  assert.equal(classify(2, ''), 'permission-denied');
  assert.equal(classify(3, '用户点了取消'), 'permission-denied');
});

test('其余情况落到 capture-failed', () => {
  assert.equal(classify(3, 'stream ended'), 'capture-failed');
});
