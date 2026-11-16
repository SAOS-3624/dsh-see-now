/**
 * loop.test.mjs — 常驻循环的守卫。
 *
 * 这一层修的是**"模型答一句就停了"**这个病：以前 `watch` 返回一张图就结束，
 * 模型回完话自然收工，因为没有任何人告诉它"还有下一张"。
 *
 * 守三件事：
 *   ① 攒够图就**真的叫醒**（走 sessionController，不是自己猜）
 *   ② 用户插话优先于出图
 *   ③ 窗被关掉要停，而且要留下"别再调了"的说明
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-loop-'));
process.env.DSH_HOME = home;
// 循环里会 openWindow —— 测试绝不能真弹窗
process.env.DSH_SEE_NO_WINDOW = '1';

const { startLoop, HANGUP_NOTE } = await import('../src/loop.js');
const { noteInterjected, __resetInterject } = await import('../src/interject.js');
const { appendChat } = await import('../src/chat.js');

/**
 * 假的 ctx：只提供叫醒要用的那两个服务，并记录被叫了几次、带了什么话。
 */
function fakeCtx({ resolveOk = true } = {}) {
  const wakes = [];
  const services = {
    sessionController: {
      async resolveAgent() {
        if (!resolveOk) return { error: 'no-agent' };
        return {
          agent: { followup: (m) => wakes.push(m.content?.[0]?.text ?? '') },
          session: { id: 's1' },
        };
      },
    },
    sessions: { async flush() { return true; } },
  };
  return {
    wakes,
    ctx: { get: (n) => services[n] ?? undefined },
  };
}

/**
 * 假 runner：可控地报"有没有攒够图"。
 *
 * `windowOpened` 默认 **false**：测试里设了 `DSH_SEE_NO_WINDOW=1` 防弹窗，
 * 而它同时让 `windowAlive()` 恒 false —— 若默认 true，循环会一启动就误判成
 * "用户关窗"。只有真正要测关窗的那一条才把它设成 true。
 */
function fakeRunner({ pending = 0, running = true, windowOpened = false, secondsSinceWake = 8 } = {}) {
  const st = { pending, running, windowOpened, secondsSinceWake };
  return {
    st,
    windowWasOpen: () => st.windowOpened,
    status: () => ({ running: st.running, pending: st.pending, secondsSinceWake: st.secondsSinceWake }),
    stop() { st.running = false; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('攒够一张图就叫醒模型，并且告诉它去 peek', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = fakeRunner({ pending: 1 });
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner });

  await sleep(300);
  loop.dispose();

  assert.ok(wakes.length >= 1, `该叫醒，实际 ${wakes.length} 次`);
  assert.match(wakes[0], /peek/, '要告诉它调 peek 拿图，否则它不知道怎么看');
  assert.match(wakes[0], /新画面/, '要说清楚为什么叫它');
});

test('没有新图时**不叫**（叫一次就是模型跑一轮，很贵）', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = fakeRunner({ pending: 0 });
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner });

  await sleep(400);
  loop.dispose();

  assert.equal(wakes.length, 0);
});

test('用户插话优先：即使没有新图也要立刻叫，而且带插话原文', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = fakeRunner({ pending: 0 });
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner });

  // 插话的入口是 **chat.jsonl**（用户就是在悬浮窗里打字），不是外部调 noteInterjected。
  // 常驻模式下 watch 早就返回了，所以循环必须自己盯这个文件。
  appendChat('user', '这个表格最后一列是啥');
  await sleep(2400);            // 一拍 2 秒
  loop.dispose();

  assert.ok(wakes.length >= 1, `插话该叫醒，实际 ${wakes.length} 次`);
  assert.match(wakes[0], /这个表格最后一列是啥/, '要把用户原话带过去');
  assert.match(wakes[0], /先说话|say/, '要说清楚得用 say 回');
});

test('窗被关掉就停，并且留下"别再调了"的说明', async () => {
  __resetInterject();
  const { ctx } = fakeCtx();
  const runner = fakeRunner({ pending: 0, windowOpened: true });
  const stopped = [];
  // DSH_SEE_NO_WINDOW=1 让 windowAlive() 恒为 false → 正好模拟"窗开过、现在没了"
  const loop = startLoop({
    ctx, getSessionId: () => 's1', runner,
    onStop: (reason) => stopped.push(reason),
  });

  await sleep(400);

  assert.equal(loop.stopped(), true, '窗没了就该停');
  assert.deepEqual(stopped, ['window-closed']);
  assert.match(HANGUP_NOTE, /不要再调/);
  assert.match(HANGUP_NOTE, /不看了/);
});

test('窗从来没开起来过时**不误判成关窗**', async () => {
  __resetInterject();
  const { ctx } = fakeCtx();
  // windowOpened=false = 这台机器没有带 tkinter 的 python，窗压根起不来。
  // 此时 windowAlive() 也是 false，但用户并没有"关窗"，不该停。
  const runner = fakeRunner({ pending: 0, windowOpened: false });
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner });

  await sleep(400);
  const stopped = loop.stopped();
  loop.dispose();

  assert.equal(stopped, false, '没开过窗 ≠ 用户关窗');
});

test('拿到 sessionId 才算数：没有它会退化成"叫不醒"', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = fakeRunner({ pending: 1 });
  const loop = startLoop({ ctx, getSessionId: () => null, runner });

  // 叫醒失败会**重试一次**（间隔 800ms），所以这里要等过那一次重试才看得到记账
  await sleep(1300);
  const state = loop.state();
  loop.dispose();

  assert.equal(wakes.length, 0, '没有会话 id 就不该假装叫醒成功');
  assert.ok(state.wakeFailures >= 1, '失败要记账，不能静默');
});

test('采集停了也停循环', async () => {
  __resetInterject();
  const { ctx } = fakeCtx();
  const runner = fakeRunner({ pending: 0, running: false });
  const stopped = [];
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner, onStop: (r) => stopped.push(r) });

  await sleep(300);
  loop.dispose();

  assert.deepEqual(stopped, ['capture-stopped']);
});

test('同一时刻不会叠着叫醒两次（冷却期）', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = fakeRunner({ pending: 1 });
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner });

  await sleep(700);            // 冷却 3 秒，这段时间内只该叫一次
  loop.dispose();

  assert.equal(wakes.length, 1, `冷却期内不该重复叫，实际 ${wakes.length} 次`);
});

// ---------------------------------------------------------------------------
// 以下守"叫醒节奏"。这一段是"它一句话说三次 / 每 3 秒烧一轮模型"的来源。
// ---------------------------------------------------------------------------

/** 带出图序号的 runner（真 runner 的 status 里有 `sheets`，单调递增） */
function seqRunner({ sheets = 0, pending = 0, running = true } = {}) {
  const st = { sheets, pending, running };
  return {
    st,
    touch: () => st.running,
    windowWasOpen: () => false,
    status: () => ({
      running: st.running, pending: st.pending, sheets: st.sheets, secondsSinceWake: 5,
    }),
    stop() { st.running = false; },
  };
}

test('同一张图只叫一次 —— 模型不取，也不能每 3 秒烧一轮', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  // pending 一直是 1（模型没调 peek），出图序号一直是 7
  const runner = seqRunner({ sheets: 7, pending: 1 });
  const loop = startLoop({
    ctx, sessionId: 's1', runner, wakeMinGapSec: 0,
  });

  await sleep(2400);           // 至少两拍
  loop.dispose();

  assert.equal(wakes.length, 1, `同一张图只该叫一次，实际 ${wakes.length} 次`);
});

test('出了新的一张才再叫（按出图序号，不看 pending）', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = seqRunner({ sheets: 7, pending: 1 });
  const loop = startLoop({ ctx, sessionId: 's1', runner, wakeMinGapSec: 0 });

  await sleep(300);
  assert.equal(wakes.length, 1);

  // 真实链路里，模型被叫醒之后会调 `see_now`（peek/say/watch），
  // 那一下会走 index.js 的 loop.noteActivity()。这里显式模拟它 ——
  // 不模拟的话"一次只允许一条在飞"会把第二张按住（那是设计，不是 bug）。
  loop.noteActivity();
  runner.st.sheets = 8;        // 又攒出一张
  await sleep(2300);
  loop.dispose();

  assert.equal(wakes.length, 2, `新的一张该再叫一次，实际 ${wakes.length} 次`);
});

test('关窗停下了，但**不许**往聊天流里写挂断说明', async () => {
  __resetInterject();
  const { ctx } = fakeCtx();
  const runner = fakeRunner({ pending: 0, windowOpened: true });
  const loop = startLoop({ ctx, sessionId: 's1', runner });
  await sleep(300);
  assert.equal(loop.stopped(), true);

  // 窗已经关了，那条流没人看；写了模型也拿不到（实测会连写两条，模型还在说"我在看"）。
  // 正确的路是 runner.note() → 下一次工具结果带走。
  const { readFileSync, existsSync } = await import('node:fs');
  const f = join(home, 'see-now', 'chat.jsonl');
  const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
  assert.ok(!body.includes('挂断'), `聊天流里不该出现挂断说明：${body}`);
});

test('连续叫不醒就停 —— 会话没了还每 8 秒烧一次模型是最贵的失败', async () => {
  __resetInterject();
  const { ctx } = fakeCtx({ resolveOk: false });
  const runner = seqRunner({ sheets: 1, pending: 1 });
  const loop = startLoop({ ctx, sessionId: 's1', runner, wakeMinGapSec: 0 });

  // 每次叫醒内部会重试一次（800ms），两次失败后停
  await sleep(4000);
  const st = loop.state();

  assert.equal(loop.stopped(), true, '叫不醒就该停，不能一直重试');
  assert.equal(st.reason, 'wake-failed');
  assert.ok(st.wakeFailures >= 2, `失败要记账，实际 ${st.wakeFailures}`);
});

test('循环记住**起循环时的会话**，不被外面的 session/event 顶掉', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = seqRunner({ sheets: 1, pending: 1 });
  let now = 'other-session';          // 别的会话随时在发事件
  const loop = startLoop({ ctx, sessionId: 's1', getSessionId: () => now, runner });

  await sleep(600);
  loop.dispose();

  assert.equal(loop.state().session, 's1', '该投给起循环的那个会话');
  assert.ok(wakes.length >= 1);
});

test('runner 的 note/takeNote：取一次就没了（同一句话不许每轮念一遍）', async () => {
  const { createRunner } = await import('../src/runner.js');
  const r = createRunner({ ffmpegPath: 'ffmpeg' });
  assert.equal(r.takeNote(), null);
  r.note('挂断说明');
  assert.equal(r.takeNote(), '挂断说明');
  assert.equal(r.takeNote(), null, '取过就不该再来一次');
  assert.equal(r.touch(), false, '没在采集时续命不该假装活着');
});

test('节奏：spoken 记下上一句时长；有声音适配器时 due 不算', async () => {
  const speech = await import('../src/speech.js');
  speech.__resetSpeech();
  const fake = fakeCtx();
  const loop = startLoop({
    ctx: fake.ctx, sessionId: 's1', runner: fakeRunner(), wakeMinGapSec: 60,
  });
  try {
    speech.emitSpoken({ text: '这是一句大概十个字的话' });
    const spokenMs = loop.state().lastSpeechMs;
    assert.ok(spokenMs > 1000, `spoken 之后应该记下时长，实际 ${spokenMs}`);

    // 有"会出声"的订阅者 = 装着声音适配器 → due 只是"打算念"，不能当起点
    const off = speech.onSpeech(() => {}, { voice: true });
    speech.emitSpeech({ at: null, text: '短', state: 'due' });
    assert.equal(loop.state().lastSpeechMs, spokenMs, 'due 不该覆盖 spoken 的时长');
    off();

    // 没有声音适配器 → 文字就是用户能感知的全部，due 该算
    speech.emitSpeech({ at: null, text: '这是一句大概十个字的话', state: 'due' });
    assert.ok(loop.state().lastSpeechMs > 1000, '没声音时 due 要算时长');
  } finally {
    loop.dispose();
    speech.__resetSpeech();
  }
});

// ---- #69：用户在主会话说话，也要算「人在」----
//
// 循环原来只盯悬浮窗那条 `chat.jsonl`：用户切到 DSH 主聊天窗跟 agent 聊天，
// 它一个字都看不见，照样按「连续 N 次叫醒没人理」收工 —— 采集停了，人还在看。
// `noteUserSpoke()` 的调用点在 `index.js` 的 `session/event` 钩子（只认
// `source.kind === 'user'`；插件自己的叫醒带的是 `'see-now'`）。

test('用户在会话里说话 → 「连续叫醒没人理」清零，不因为叫够了就收工（#69）', async () => {
  __resetInterject();
  const { ctx, wakes } = fakeCtx();
  const runner = seqRunner({ sheets: 1, pending: 1 });
  // idleStopMs: 0 关掉"多久没说话"那条，只留叫醒上限这一条
  const loop = startLoop({
    ctx, sessionId: 's1', runner, wakeMinGapSec: 0,
    tuning: { maxAutonomousWakes: 1, idleStopMs: 0, wakeBatch: 1 },
  });

  await sleep(300);
  assert.equal(wakes.length, 1, `应该先叫醒一次，实际 ${wakes.length}`);
  loop.noteActivity();

  // 用户在主聊天窗说话了（钩子会把这一下打进来）
  loop.noteUserSpoke();
  runner.st.sheets = 2;        // 又出一张，让它有理由继续
  await sleep(2400);
  loop.dispose();

  assert.equal(loop.stopped(), false, '用户刚说过话，不该判「没人理」收工');
  assert.equal(loop.state().mode, 'active');
});

test('没有 noteUserSpoke 时，叫够 maxAutonomousWakes 就该停（同一条线没被改坏）', async () => {
  __resetInterject();
  const { ctx } = fakeCtx();
  const runner = seqRunner({ sheets: 1, pending: 1 });
  const loop = startLoop({
    ctx, sessionId: 's1', runner, wakeMinGapSec: 0,
    tuning: { maxAutonomousWakes: 1, idleStopMs: 0, wakeBatch: 1 },
  });

  await sleep(300);
  loop.noteActivity();         // 模型接住了，但**用户一句话没说**
  await sleep(2400);
  const st = loop.state();
  loop.dispose();

  // 窗没开（DSH_SEE_NO_WINDOW=1）→ idleAction 给 'stop'
  assert.equal(st.stopped, true, '没人说话就该收工，这条兜底线不能被新逻辑吃掉');
  assert.equal(st.reason, 'idle');
});
