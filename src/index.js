/**
 * index.js — 插件入口。只做三件事：注册工具、路由 action、把图交成附件。
 *
 * **唯一的取图方式是 `watch`**：它阻塞到「攒够一张」或超时，然后把图作为**工具返回值**
 * 交给宿主。不要用 `sessionController.prompt` 往会话里推 —— 那样模型看到图又去调工具、
 * 自己唤醒自己，停不下来（0.0.1 就是死在这儿）。
 */

import { createRunner, SCENE_OPTS, PACES, DEFAULT_PACE, SIZES } from './runner.js';
import { resolveFfmpeg } from './binaries.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { sendWindowState } from './window.js';
import { wakeWithRetry } from './timer.js';
import { seeNowToolSpec, TOOL_TIMEOUT_MS, DEFAULT_BLOCK_SEC } from './tool-spec.js';
import { interjectNote, replyReminder, clearInterjected, noteInterjected, pendingInterjected } from './interject.js';
import { appendSpoken, lastSaidNote } from './chat.js';
import { ensureConfiguredVoice, detachAdapters, attachedAdapters, configuredVoiceAdapter, lastVoiceError } from './voice.js';
import { speechSubscribers } from './speech.js';
import { startLoop, HANGUP_NOTE } from './loop.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const name = 'dsh-see-now';

/**
 * `watch` 最多阻塞多久。
 *
 * **必须比宿主的 timeoutMs 早收工**：工具自己挂得比宿主的死线还久，到点就不是
 * "返回一张图"，而是整条调用被 abort（`signal` 一起 abort，模型看到的是超时错误）。
 * 留 40 秒给建图/交附件/模型想一想。
 */
const MAX_BLOCK_SEC = Math.max(30, Math.floor(TOOL_TIMEOUT_MS / 1000) - 40);

// 三个都在 inject 里声明：cordis 的属性访问只沿 fiber 父链找**已注册**的服务，
// 不声明时 `ctx.attachments` 是 undefined，而且 `?.` 挡不住（get 陷阱直接 throw）。
export const inject = ['tools', 'attachments', 'sessionController'];

/** 可选服务：优先 `ctx.get()`，老宿主退回属性访问且包 try。 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 没声明 inject 时 get 陷阱会 throw */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

/**
 * 把返回值洗成**无损 JSON**。宿主会校验 `JSON.parse(JSON.stringify(v))` 与原值等价，
 * 只要对象里有 `undefined`（哪怕只是某个可选字段没赋值）就判
 * `tool returned invalid output: value is not lossless JSON`，整条调用作废。
 */
function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toLosslessJson(v);
  return out;
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch { /* 落到环境变量 —— 本地开发/测试时用 */ }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(override).href);
    if (mod?.defineTool) return mod.defineTool;
  }
  return (tool) => tool;
}

/** 一张图 → 模型看得懂的清单。数字都是「这张图里第几格」，不是抽象指标。 */
function sheetText(sheet, { waited = 0, partial = false, userText = null, say = null, looping = false, first = false } = {}) {
  const { frames, from, to, why } = sheet;
  const span = frames.length === 1
    ? `${from.toFixed(1)}s`
    : `${from.toFixed(1)}–${to.toFixed(1)}s（跨 ${(to - from).toFixed(1)}s）`;
  const head = `已就绪：1 张图，装了 ${frames.length} 个画面，时间段 ${span}。`
    + (partial ? '（提前截断）' : '')
    + (waited > 0 ? ` 等了 ${waited.toFixed(1)}s。` : '');
  const lines = frames.map((f, i) => {
    const cell = sheet.cells?.[i];
    const size = cell ? `${cell.pw}×${cell.ph}` : '—';
    const k = cell ? Math.max(1, Math.round(sheet.w / Math.max(1, cell.pw))) : null;
    const tierText = k && k !== f.tier ? `${f.tier}档→1/${k}` : `${f.tier} 档`;
    return `  ${i + 1}. ${f.t.toFixed(1)}s · ${size} · ${f.via} · ${tierText}`;
  });
  const whyText = first ? '刚打开，先给你此刻' : why === 'user' ? '用户插话截断的'
    : why === 'timeout' ? '等满了先给你'
      : why === 'time' ? '攒到这个点先给你'
        : why === 'full' ? '这张装满了'
          : why === 'first' ? '刚打开，先给你此刻'
            : why === 'oneshot' ? '换了清晰度，先给你此刻'
              : '流结束';
  const ask = userText
    ? `\n${interjectNote(userText, { at: Date.now() })}`
    : '';
  const loopNote = looping
    ? '\n**已经进入常驻模式**：下一张攒够我会再叫你，不用你现在就调下一次。'
      + '你现在只要做一件事 —— 值得说就用 `say` 说一句，不值得说就别出声。'
      + '用户关掉悬浮窗我就停。'
    : '';
  return `${head}\n${lines.join('\n')}${ask}${lastSaidNote()}${loopNote}\n（${whyText}；想看下一段就再调一次 \`see_now({action:"watch"})\`。）${replyReminder({ answered: Boolean(say) })}`;
}

/**
 * 提交成宿主附件，并组装工具返回值。
 */
async function attachAndReturn(ctx, sheet, extra = {}, signal = null) {
  const svc = serviceOf(ctx, 'attachments');
  if (!svc?.saveImage) {
    return { text: '拿到图了，但宿主没有 attachments 服务，交不上去。', meta: { ok: false, ...extra } };
  }
  let ref;
  try {
    ref = await svc.saveImage.call(svc, {
      data: sheet.png,
      mediaType: 'image/png',
      name: `see-now-${Date.now()}.png`,
    });
  } catch (e) {
    return { text: `画面附件保存失败，当前文件图保留待重试：${e?.message ?? e}`, meta: { ok: false, reason: 'attachment-failed' } };
  }
  if (signal?.aborted && signal.reason !== 'control') {
    return { text: '取图调用已取消，当前文件图片保留待重试。', meta: { ok: false, reason: 'cancelled' } };
  }
  const { say: said, ...meta } = extra;
  return {
    images: [ref],
    text: sheetText(sheet, extra),
    meta: {
      ...meta,
      said: said ? String(said).slice(0, 200) : null,
      frames: sheet.frames.length,
      from: +sheet.from.toFixed(2),
      to: +sheet.to.toFixed(2),
      fill: +sheet.fill.toFixed(3),
      why: sheet.why,
      bytes: sheet.png.length,
    },
  };
}

function parseSource(args, previous = null) {
  const kind = String(args.source ?? previous?.kind ?? 'screen').toLowerCase();
  if (!['screen', 'file', 'camera', 'obs'].includes(kind)) throw new RangeError(`未知 source：${kind}`);
  const source = previous?.kind === kind ? { ...previous } : { kind };
  delete source.engine;
  for (const key of ['path', 'device', 'region', 'mouse', 'realtime']) {
    if (args[key] !== undefined) source[key] = args[key];
  }
  if (kind === 'file') {
    if (!source.path || /^[a-z]+:\/\//i.test(String(source.path))) {
      throw new RangeError('视频文件需要本地 path；网页链接先下载为本地媒体。');
    }
    source.path = resolve(String(source.path));
  }
  return source;
}

/** 当前声音状态（status 用）。 */
function voiceState() {
  const configured = configuredVoiceAdapter();
  let speakers = 0;
  try { speakers = speechSubscribers(); } catch { /* 总线还没建起来 */ }
  return {
    configured: configured ?? null,
    adapters: attachedAdapters(),
    speakers,
    reason: speakers > 0 ? null : (lastVoiceError() ?? null),
  };
}

export async function apply(ctx) {
  try {
    return await registerAll(ctx);
  } catch (e) {
    try { ctx?.logger?.error?.(`[dsh-see-now] failed to load: ${e?.stack ?? e}`); } catch { /* ignore */ }
    if (process.env.DSH_SEE_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const disposers = [];
  const log = (m) => { try { ctx?.logger?.info?.(`[dsh-see-now] ${m}`); } catch { /* ignore */ } };

  const ffmpeg = resolveFfmpeg();
  log(`ffmpeg: ${ffmpeg.path}（${ffmpeg.source}）`);
  const runner = createRunner({
    ffmpegPath: ffmpeg.path,
    log,
  });
  disposers.push(() => runner.stop());

  ensureConfiguredVoice({ log })
    .then((r) => { if (!r.ok && r.reason !== 'not-configured') log(`声音没挂上：${r.reason}`); })
    .catch(() => { /* ignore */ });
  disposers.push(() => { detachAdapters().catch(() => {}); });

  let lastSessionId = null;
  let eventSessionId = null;
  let activeRead = null;
  let controlQueue = Promise.resolve();
  let disposed = false;

  let sceneMode = false;
  let paceMode = DEFAULT_PACE;
  let loopScene = null;
  let pendingModeNote = '';

  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session) => {
        const id = session?.header?.id ?? session?.id;
        // 会话事件也要更新 lastSessionId：循环归属在 watch 开始前锁定，
        // 那时只能从事件里拿到 id（上游同款做法）。
        if (id) { eventSessionId = id; lastSessionId = id; }
      });
      if (typeof off === 'function') disposers.push(off);
    } catch (e) {
      log(`session/event 钩子失败：${e?.message ?? e}`);
    }
  }

  let loop = null;
  const stopLoop = (reason = '手动') => {
    if (!loop) return;
    const wasStopped = loop.stopped();
    loop.dispose();
    loop = null;
    if (!wasStopped) log(`循环停了（${reason}）`);
  };
  disposers.push(stopLoop);

  const ensureLoop = (sessionId = null) => {
    const sid = sessionId ?? lastSessionId ?? eventSessionId;
    if (!sid) {
      log('没拿到会话 id，常驻循环暂缓启动（等下一次有会话再起）');
      return null;
    }
    const key = sceneMode ? 'scene' : paceMode;
    if (loop && !loop.stopped() && loopScene === key) return loop;
    stopLoop(loop ? '重建（模式变了）' : '起新循环');
    loopScene = key;
    loop = startLoop({
      ctx,
      sessionId: sid,
      getSessionId: () => lastSessionId ?? eventSessionId,
      runner,
      log,
      scene: sceneMode,
      wakeMinGapSec: sceneMode ? 4 : PACES[paceMode].wakeGapSec,
      onStop: (reason) => {
        if (reason === 'window-closed') {
          try { runner.note(HANGUP_NOTE); } catch { /* ignore */ }
          try { runner.hangUp(); } catch { /* ignore */ }
          return;
        }
        try { runner.stop(); } catch { /* ignore */ }
      },
    });
    log(`常驻循环已启动（会话 ${sid ?? '未知'}）`);
    return loop;
  };

  const withPendingNote = (value) => {
    let note = null;
    try { note = runner.takeNote(); } catch { note = null; }
    if (!note || !value || typeof value !== 'object') return value;
    const text = typeof value.text === 'string' ? value.text : '';
    return { ...value, text: text ? `${note}\n\n${text}` : note };
  };

  const publishState = (state = runner.status()) => sendWindowState({
    ...state, source: state.source ?? state.lastSource, pace: paceMode,
  });
  const controlActions = new Set(['start', 'stop', 'pause', 'resume', 'seek', 'configure']);

  async function perform(args, run) {
    const action = String(args.action ?? 'watch').toLowerCase();
    if (run.windowCommand && (runner.isHungUp() || !runner.status().window.alive || (run.sessionId && lastSessionId && run.sessionId !== lastSessionId))) {
      return { text: '窗口或所属会话已变化，旧操作已取消。', meta: { ok: false, reason: 'window-closed' } };
    }
    const reads = action === 'watch' || action === 'peek';
    const caller = run.agent?.session?.header?.id ?? run.sessionId;
    if (action !== 'status' && action !== 'devices') {
      const explicitStart = action === 'start' || (action === 'watch' && args.source !== undefined);
      if (caller && lastSessionId && caller !== lastSessionId && !explicitStart) {
        return { text: '当前采集属于另一会话；在本会话显式指定来源可开始新的采集。', meta: { ok: false, reason: 'owner-conflict' } };
      }
      if (explicitStart && caller && lastSessionId && caller !== lastSessionId) {
        stopLoop('会话切换');
        await runner.stop({ reason: 'owner-changed' });
      }
      if (!lastSessionId || explicitStart) lastSessionId = caller ?? lastSessionId ?? eventSessionId;
    }
    let read;
    if (reads) {
      if (activeRead) return { text: '已有取图操作正在等待。', meta: { ok: false, reason: 'busy' } };
      const controller = new AbortController();
      let finish;
      read = { controller, done: new Promise((resolveDone) => { finish = resolveDone; }), finish };
      activeRead = read;
      run = { ...run, externalSignal: run.signal, signal: run.signal ? AbortSignal.any([run.signal, controller.signal]) : controller.signal };
    }
    try {
      const out = await toolObj.route(args, run);
      const noted = pendingModeNote && out && typeof out.text === 'string'
        ? { ...out, text: `${pendingModeNote}\n\n${out.text}` } : out;
      pendingModeNote = '';
      return toLosslessJson(withPendingNote(noted));
    } catch (error) {
      const reason = run.signal?.aborted ? 'cancelled' : (error instanceof RangeError ? 'invalid-argument' : 'operation-failed');
      return { text: `操作结束（${reason}）：${error.message}`, meta: { ok: false, reason, error: error.message } };
    } finally {
      if (activeRead === read) activeRead = null;
      read?.finish();
      publishState();
    }
  }

  const toolObj = {
    ...seeNowToolSpec(),
    async execute(args = {}, run = {}) {
      if (disposed) return { text: '插件已卸载。', meta: { ok: false, reason: 'disposed' } };
      const action = String(args.action ?? 'watch').toLowerCase();
      const caller = run.agent?.session?.header?.id ?? run.sessionId;
      const explicitStart = action === 'start' || (action === 'watch' && args.source !== undefined);
      if (!['status', 'devices'].includes(action) && caller && lastSessionId && caller !== lastSessionId && (!explicitStart || run.windowCommand)) {
        return { text: '当前采集属于另一会话；在本会话显式指定来源可开始新的采集。', meta: { ok: false, reason: 'owner-conflict' } };
      }
      if (controlActions.has(action) || (explicitStart && caller && lastSessionId && caller !== lastSessionId)) {
        activeRead?.controller.abort('control');
        const next = controlQueue.then(async () => {
          const reading = activeRead;
          reading?.controller.abort('control');
          await reading?.done;
          return perform(args, run);
        });
        controlQueue = next.then(() => {}, () => {});
        return next;
      }
      if (action === 'watch' || action === 'peek') await controlQueue;
      return perform(args, run);
    },

    async route(args = {}, run = {}) {
      const action = String(args.action ?? 'watch').toLowerCase();

      await ensureConfiguredVoice({ log }).catch(() => { /* ignore */ });

      const said = args.say ? String(args.say).trim().slice(0, 800) : null;
      if (said) {
        try { appendSpoken('assistant', said); } catch { /* ignore */ }
        clearInterjected();
      }

      let modeNote = '';
      if (typeof args.scene === 'boolean' && args.scene !== sceneMode) {
        sceneMode = args.scene;
        try { runner.stop(); } catch { /* ignore */ }
        stopLoop('换模式');
        loopScene = null;
        modeNote = sceneMode
          ? '已切到**逐帧模式**：每换一次场景给你一张满幅图（一张图 = 一个画面）。'
            + '只在演示/逐场景播报时用；说完话接着调 watch，换场景时我会叫你。'
          : '已切回**常规模式**：一张图装几帧、攒够才发。';
        log(modeNote.replace(/\*\*/g, ''));
        pendingModeNote = modeNote;
      }

      const wantPace = args.pace ? String(args.pace).toLowerCase() : null;
      if (wantPace && PACES[wantPace] && wantPace !== paceMode) {
        paceMode = wantPace;
        try { runner.stop(); } catch { /* ignore */ }
        stopLoop('换节奏');
        loopScene = null;
        const t = {
          calm: '已切到**省电节奏**：20 分以上才算换画面，最多 30 秒叫你一次。',
          normal: '已切回**默认节奏**：12 分算换画面，最多 15 秒叫一次。',
          dense: '已切到**灵敏节奏**：7 分就算换画面，最多 8 秒叫一次（费钱，只在演示/逐帧时用）。',
          action: '已切到**动作节奏**：80 分以上才算换画面，出帧按"攒够 30 秒运动量"算，'
            + '最多 20 秒叫一次，每张图最多 8 帧（全屏游戏/高速画面用，信息量比 normal 少）。',
        }[wantPace];
        pendingModeNote = [t, pendingModeNote].filter(Boolean).join('\n\n');
        log(t.replace(/\*\*/g, ''));
      }

      if (action === 'pause' || action === 'resume' || action === 'seek' || action === 'configure') {
        const result = action === 'seek' ? await runner.seek(args.position)
          : action === 'configure' ? await runner.configure({ quality: args.quality })
          : await runner[action]();
        if (result.sheet) {
          const saved = await attachAndReturn(ctx, result.sheet, {}, run?.externalSignal ?? run?.signal);
          if (saved.images?.length) runner.acknowledge(result.sheet);
          return { ...saved, text: `已跳转到 ${result.playback.requestedPositionSec ?? result.playback.positionSec}s，预览已附上。`, meta: { ...saved.meta, ...result } };
        }
        if (action === 'seek' && !run?.windowCommand) {
          const sheet = runner.peek({ allowPaused: true });
          if (sheet) {
            const value = await attachAndReturn(ctx, sheet, {}, run?.externalSignal ?? run?.signal);
            if (value.images?.length) runner.acknowledge(sheet);
            return { ...value, text: `已跳转到 ${result.playback.requestedPositionSec ?? result.playback.positionSec}s，预览已附上。`, meta: { ...value.meta, ...result } };
          }
        }
        return { text: result.ok ? `文件操作完成：${action}` : `文件操作未完成：${result.reason}`, meta: result };
      }

      if (action === 'watch') {
        // 归属在**开始等待前**锁定：等待期间的任何 session/event 都不能改掉它，
        // 否则唤醒会投到别的会话（issue #1）。
        const ownerAtStart = lastSessionId ?? eventSessionId;
        const hasSource = ['source', 'path', 'device', 'region', 'mouse', 'realtime'].some((key) => args[key] !== undefined);
        const src = hasSource ? parseSource(args, runner.status().lastSource) : null;
        const seconds = Math.min(
          Number(args.seconds) > 0 ? Number(args.seconds) : DEFAULT_BLOCK_SEC,
          MAX_BLOCK_SEC,
        );
        const minFrames = Number(args.minFrames) > 0 ? Number(args.minFrames) : 1;
        const r = await runner.watch({
          seconds,
          minFrames,
          src,
          quality: args.quality ? String(args.quality).toLowerCase() : null,
          opts: {
            ...(sceneMode ? SCENE_OPTS : {}),
            ...(sceneMode ? {} : (PACES[paceMode].pipeline ?? {})),
            cutAbs: (sceneMode ? PACES.dense : PACES[paceMode]).cutAbs,
          },
          signal: run?.signal ?? null,
        });
        if (!r.ok) {
          if (r.reason === 'paused') return { text: '视频已暂停；继续请调用 resume。', meta: { ...r, playback: runner.status().playback } };
          if (r.reason === 'min-frames') return { text: `队首图片只有 ${r.availableFrames ?? 0} 帧，暂未达到 minFrames；已保留原图，可降低 minFrames 后领取。`, meta: r };
          if (r.reason === 'hung-up') {
            return {
              text: '用户已经关掉了悬浮窗，这一轮看屏幕结束了。\n'
                + '**不要再调 `see_now`**。等用户明确说要看（或者重新打开窗口）再开始。',
              meta: { ok: false, reason: 'hung-up' },
            };
          }
          if (r.reason === 'file-ended') {
            return {
              text: `这个文件已经放完了（${r.path ?? ''}）。\n`
                + '**不会自动重播**。要再看一遍就显式传 `source:"file"` + `path`，'
                + '要接着看屏幕就传 `source:"screen"`。',
              meta: { ok: false, reason: 'file-ended', path: r.path ?? null },
            };
          }
          if (r.reason === 'cancelled') {
            return {
              text: '这一轮被取消了（用户按了停止，或者调用超时），等待已经结束。\n'
                + '他想接着看时说一声，再调 `see_now({action:"watch"})`。',
              meta: { ok: false, reason: 'cancelled', waited: +r.waited.toFixed(1) },
            };
          }
          if (r.userText) {
            return {
              text: `用户刚说话：「${r.userText}」——但这一刻还没收到画面（刚开或刚发完）。\n`
                + '先回答他，需要看图就再调一次 `see_now`。',
              meta: { ok: false, reason: r.reason, userText: r.userText, waited: +r.waited.toFixed(1) },
            };
          }
          return {
            text: r.reason === 'no-change'
              ? `看了 ${r.waited.toFixed(0)} 秒，画面基本没变（不够 ${minFrames} 帧就不发）。`
                + '\n再等一会儿，或者直接问用户想让你看什么。'
              : `没看成（${r.reason}）${r.error ? `：${r.error}` : ''}。`,
            meta: { ok: false, reason: r.reason, waited: +r.waited.toFixed(1) },
          };
        }
        const lp = ensureLoop(ownerAtStart);
        const result = await attachAndReturn(ctx, r.sheet, {
          waited: r.waited, partial: r.partial === true, quality: r.quality, first: r.first === true,
          userText: r.userText ?? null, playback: r.playback, say: said, window: runner.status().window,
          looping: Boolean(lp) && !lp.stopped(), loopWakes: lp ? lp.state().wakes : 0,
        }, run?.externalSignal);
        if (result.images?.length) runner.acknowledge(r.sheet);
        return result;
      }

      if (action === 'peek') {
        if (runner.status().playback?.state === 'paused') {
          return { text: '视频已暂停；继续播放请调用 resume。', meta: { ok: false, reason: 'paused', playback: runner.status().playback } };
        }
        const s = runner.peek();
        const st = runner.status();
        const lp = (s || st.running || st.pending) ? ensureLoop() : null;
        if (!s) {
          return {
            text: '手上还没有画面（刚开或刚发完，下一张还在攒）。\n'
              + `循环${!lp || lp.stopped() ? '没在跑' : '在跑'} —— 攒够我会叫你；要看此刻可以调 \`see_now({action:"watch"})\`。`,
            meta: { ok: false, reason: 'no-sheet', loop: lp?.state() ?? null },
          };
        }
        const result = await attachAndReturn(ctx, s, { looping: Boolean(lp) && !lp.stopped() }, run?.externalSignal);
        if (result.images?.length) runner.acknowledge(s);
        return result;
      }

      if (action === 'start') {
        const hasSource = ['source', 'path', 'device', 'region', 'mouse', 'realtime'].some((key) => args[key] !== undefined);
        const src = hasSource ? parseSource(args, runner.status().lastSource) : { kind: 'screen' };
        const r = await runner.start({ src, quality: args.quality ? String(args.quality).toLowerCase() : null });
        return {
          text: r.already ? '已经在看了。'
            : `开始看 ${r.source.kind}（引擎 ${r.engine}）${r.warning ? `。⚠️ ${r.warning}` : '。'}`,
          meta: r,
        };
      }

      if (action === 'stop') {
        stopLoop('手动 stop');
        await runner.stop({ closeWindow: args.closeWindow === true });
        return { text: args.closeWindow ? '采集、唤醒和本插件窗口已停止。' : '停了。窗口还开着，想再看得重新调 watch。', meta: { ok: true } };
      }

      if (action === 'status') {
        const s = runner.status();
        const voice = voiceState();
        const lp = loop?.state() ?? null;
        return {
          text: (s.running
            ? `在看 ${s.source?.kind} @${s.size?.[0]}×${s.size?.[1]}（${s.quality}，${s.since}s，收到 ${s.frames} 帧，留帧 ${s.stats?.kept ?? 0}，出图 ${s.stats?.sheets ?? 0}）`
              + `${s.lastError ? `\n⚠ ${s.lastError}` : ''}`
            : `没在采集（${s.idleSec}s 前停的）${s.lastError ? `\n⚠ ${s.lastError}` : ''}`)
            + `\n循环：${lp && !lp.stopped
              ? `在跑（叫醒 ${lp.wakes} 次${lp.wakeFailures ? `，失败 ${lp.wakeFailures} 次` : ''}`
                + `${lp.lastWakeAt ? `，上一次 ${Math.round((Date.now() - lp.lastWakeAt) / 1000)}s 前${lp.lastWakeOk === false ? '（失败）' : ''}` : ''}`
                + `，会话 ${lp.session ?? '未知'}）`
              : lp?.reason ? `已停（${lp.reason}）` : '没起（还没调过 watch）'}`
            + `\n队列：${s.pending ? `有 ${s.pending} 张没取走（出图序号 ${s.sheets}）` : '空'}`
            + `\n模式：${sceneMode ? '逐帧（一张图 = 一个场景，铺满）' : '常规（多帧拼一张）'}`
            + ` · 节奏：${sceneMode ? 'dense（跟逐帧走）' : paceMode}`
            + `（切点门槛 ${(sceneMode ? PACES.dense : PACES[paceMode]).cutAbs}，`
            + `最多 ${sceneMode ? 4 : PACES[paceMode].wakeGapSec} 秒叫一次）`
            + `\n声音：${voice.speakers > 0
              ? `已接上 ${voice.adapters.join(', ') || '适配器'}（${voice.speakers} 个会出声的订阅者）`
              : voice.configured
                ? `配了 ${voice.configured} 但没挂上（${voice.reason ?? '原因未知'}）`
                : '没配 —— 写 ~/.dsh/voice.json 的 {"adapter":"…"} 才有声音'}`,
          meta: { ...s, voice, loop: lp },
        };
      }

      return { text: `未知 action: ${action}（可用 watch / peek / start / stop / status）`, meta: { action } };
    },
  };

  runner.setWindowHandlers({
    onStatus: publishState,
    async onCommand(command) {
      if (disposed) return;
      const { command: action, ...args } = command;
      const owner = lastSessionId;
      const result = await toolObj.execute({ ...args, action: action === 'watch' ? 'start' : action }, {
        sessionId: owner, windowCommand: true,
      });
      if (result.meta?.ok === false) {
        publishState({ ...runner.status(), lastError: result.meta.error ?? result.text });
        return;
      }
      if (['watch', 'resume', 'seek'].includes(action) && owner && owner === lastSessionId && !runner.isHungUp() && runner.status().window.alive) {
        await wakeWithRetry({ ctx, sessionId: owner, text: '用户在 See Now 窗口调整了视频。请调用 see_now({action:"watch"}) 领取新位置的画面，并按用户要求继续。', log });
      }
    },
  });

  disposers.push(ctx.tools.register(defineTool(toolObj)));

  return () => {
    disposed = true;
    activeRead?.controller.abort('control');
    for (const d of disposers.reverse()) {
      try { d?.(); } catch { /* ignore */ }
    }
  };
}
