/**
 * runner.js — 常驻采集会话：start / watch / peek / stop。
 *
 * 和 pipeline.js 的分工：pipeline 只管「帧进、图出」，不碰进程；这里管**进程生命周期**
 * 和**取图语义**（阻塞到有图 / 立刻要 / 保持温热）。
 *
 * ## 三条刻意的设计
 *
 * ① **出图由采集侧自己攒、自己截**（pipeline 里做），`watch` 只是"取队列里那一张"。
 *    所以模型思考三秒不是延迟，只是让队列多一张。
 *
 * ② **停采集要留宽限期**。冷启动一次 400ms（屏幕）/ 1.7s（摄像头硬件唤醒），
 *    每次 watch 都停掉的话，连续看就是每次重付这笔钱。所以看完留 `graceSec` 秒，
 *    期间再来 watch 立刻就有帧；超时没人来才自己收工。
 *
 * ③ **取图永远走队列，不新建**。两张图同时在飞的时候，`take()` 给的是最早那张
 *    （时间顺序不能乱），新图挤掉旧图由 pipeline 的 queueDepth 负责。
 */

import { spawnFrames, pickScreenEngine, screenEngineWarning } from './capture.js';
import { resolveFfmpeg } from './binaries.js';
import { probeMedia } from './media.js';
import { createPipeline } from './pipeline.js';
import { chatWatcherShared, enterChatWait } from './chat.js';
import { noteInterjected } from './interject.js';
import { openWindow, closeWindow, windowAlive, windowStatus } from './window.js';

/** 三档清晰度。数字是画布像素，token 约等于 像素÷1650（见调参报告）。 */
export const SIZES = Object.freeze({
  low: [800, 450],        // 218 token/张 · 4 帧时每格 400×225 —— 看视频/场景够
  standard: [1066, 600],  // 388 token/张 · 每格 533×300 —— 屏幕上的中号字能认
  high: [1280, 720],      // 559 token/张 · 每格 640×360 —— 文件名/小字能认
  ultra: [1600, 900],     // 872 token/张 · 单帧时几乎等于原屏 —— 真要读字才用（仍低于 1024 封顶）
});
export const DEFAULT_QUALITY = 'low';

/**
 * 「逐帧 / 逐场景」模式的管线参数。
 *
 * - `maxFrames: 1` —— 留下 1 帧就立刻封箱（`checkFlush` 的 `frames.length >= maxFrames`），
 *   所以一张图永远只有一个画面。
 * - `strategy: 'single'` —— 档位固定压到 1，让这一帧**铺满整张画布**。
 *   不压的话，场景密集时密度档位会升到 2/3，一格只占 1/4、1/9，中间全是灰条。
 *
 * 这两个必须成对出现：只改 maxFrames 会得到"小格子 + 大片留白"，只改 strategy
 * 会得到"一张图里好几幅满幅图，装不下就被切开"。
 */
export const SCENE_OPTS = Object.freeze({ maxFrames: 1, strategy: 'single' });

/**
 * 四档节奏。**只影响"多久算一次画面变了"和"多久叫醒一次"**，不改出图口径。
 *
 * 为什么要有它：`cutAbs` 是全局常量，模型听见"省点钱"也只能嘴上答应 ——
 * 频率完全由插件定。用户实报"回复太密集"，说明缺一个能让这句话生效的旋钮。
 *
 * | 档 | cutAbs | 唤醒间隔 | 适合 |
 * |---|---|---|---|
 * | calm | 20 | 30s | 日常挂着看，只想知道"大场面变了没" |
 * | normal | 12 | 15s | 默认。滚网页/切窗口不会每下都留帧 |
 * | dense | 7 | 8s | 幻灯片、逐帧播报这种"每一刀都要"的 |
 * | action | 80 | 20s | 全屏游戏 / 高速运动。靠 `pipeline` 把积分阈值也一起抬高 |
 */
export const PACES = Object.freeze({
  calm: { cutAbs: 20, wakeGapSec: 30 },
  normal: { cutAbs: 12, wakeGapSec: 15 },
  dense: { cutAbs: 7, wakeGapSec: 8 },
  action: {
    cutAbs: 80,
    wakeGapSec: 20,
    pipeline: {
      integralSeconds: 30,
      maxFrames: 8,
      maxWaitSec: 60,
      silentFloorSec: 40,
      cutSpike: 1.5,
      cutSpikeAbs: 30,
      flushGain: 0.005,
      binCost: 600,
    },
  },
});
export const DEFAULT_PACE = 'normal';

function optsSig(o) {
  if (!o || typeof o !== 'object') return '';
  return Object.keys(o).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join(';');
}

/**
 * 「这一条 watch 该不该被硬闸拦下」的**纯函数**（好测，也好读）。
 *
 * 三条规矩：
 * - 用户关过窗（`hungUp`）→ 除非他显式说了要看什么，否则不重开。
 * - 文件放完了（`fileEnded`）→ 同上，文件回放是一次性的，不能自动重播。
 * - 显式传了来源 = 用户明确要求 → 一律放行。
 */
export function guardReason({ hungUp = false, fileEnded = false, explicitSrc = false } = {}) {
  if (explicitSrc) return null;
  if (hungUp) return 'hung-up';
  if (fileEnded) return 'file-ended';
  return null;
}

export function createRunner({
  ffmpegPath = 'ffmpeg', log = () => {}, graceSec = 60,
  spawnCapture = spawnFrames, probe = probeMedia, openCaptureWindow = openWindow,
} = {}) {
  let pipeline = null;
  let running = false;
  let run = null;
  let source = null;
  let startedAt = 0;
  let frames = 0;
  let lastError = null;
  let stoppedAt = 0;
  let graceTimer = null;
  let busy = false;
  let quality = DEFAULT_QUALITY;
  let runOpts = {};
  let generation = 0;
  let disposed = false;
  let phase = 'idle';
  let stopReason = null;
  let deliveredAt = null;
  let decodedAt = null;
  let delivery = null;
  let stopping = Promise.resolve();
  let windowAbort = new AbortController();
  let userPaused = false;
  let durationSec = null;
  let mediaPath = null;
  let positionSec = 0;
  let requestedPositionSec = null;
  let controlBusy = false;
  let windowHandlers = {};
  let previewing = false;
  let lastStatusAt = 0;

  function playback() {
    const file = lastSource?.kind === 'file';
    return {
      state: !file ? 'unavailable' : userPaused ? 'paused' : endedSource && !delivery && !pipeline?.pending ? 'ended'
        : phase === 'stopped' || phase === 'failed' ? 'stopped' : 'playing',
      positionSec: file ? positionSec : 0, requestedPositionSec: file ? requestedPositionSec : null,
      durationSec: file ? durationSec : null,
      canSeek: file && !disposed,
    };
  }

  function emitStatus(force = false) {
    if (!force && Date.now() - lastStatusAt < 1000) return;
    lastStatusAt = Date.now();
    try { windowHandlers.onStatus?.(api.status()); } catch (error) { log(`播放状态更新失败：${error.message}`); }
  }

  const chatPoll = chatWatcherShared();
  let windowState = null;
  let windowPending = null;
  let windowOpened = false;
  let pendingNote = null;
  let hungUp = false;
  let lastSource = null;
  let endedSource = null;

  function teardown(why = 'stopped') {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    generation += 1;
    const previous = run;
    run = null;
    running = false;
    source = null;
    stopReason = why;
    phase = why === 'eof' ? 'ended' : why === 'failed' ? 'failed' : 'stopped';
    stoppedAt = Date.now();
    if (previous) stopping = Promise.resolve(previous.stop()).catch(() => {});
    if (why) log(`收工：${why}`);
    return stopping;
  }

  // 文件图在附件保存成功前保持可重试；屏幕仍按原有策略追踪最新画面。
  function takeSheet() {
    if (delivery) return delivery.sheet;
    const sheet = pipeline?.take();
    if (sheet && lastSource?.kind === 'file') delivery = { sheet, pipeline };
    return sheet ?? null;
  }

  function acknowledge(sheet) {
    if (!delivery || delivery.sheet !== sheet) return;
    if (delivery.pipeline === pipeline) {
      deliveredAt = Math.max(deliveredAt ?? 0, sheet.to);
      positionSec = deliveredAt;
      requestedPositionSec = null;
      delivery = null;
      if (!userPaused && !pipeline?.pending) run?.resume();
      emitStatus(true);
    } else delivery = null;
  }

  /** 停采集，但留一个宽限期 —— 这期间再来 watch 不用重新热启动 */
  function armGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    if (!running) return;
    if (graceSec <= 0) { teardown('grace-expired'); return; }
    const idleLimit = lastSource?.kind === 'file' ? Math.max(graceSec, 900) : graceSec;
    graceTimer = setTimeout(() => teardown('grace-expired'), idleLimit * 1000);
    graceTimer.unref?.();
  }

  /** 续命（常驻循环每拍调一次） */
  function touch() {
    if (!running) return false;
    armGrace();
    return true;
  }

  async function start({
    src = { kind: 'screen' }, opts = {}, quality: q = null, resumeAt = 0,
    paused = false, preview = false, preservePosition = false,
  } = {}) {
    if (disposed) throw new Error('插件已卸载');
    if (running && !preservePosition && src.kind !== 'file') return { already: true, source };
    const beforeWait = generation;
    await stopping;
    if (disposed || beforeWait !== generation) throw new Error('采集启动已取消');
    const current = ++generation;
    phase = 'starting';
    stopReason = null;
    hungUp = false;
    endedSource = null;
    delivery = null;
    if (!preservePosition) {
      deliveredAt = null;
      positionSec = 0;
      requestedPositionSec = null;
    }
    decodedAt = null;
    userPaused = src.kind === 'file' && paused;
    previewing = src.kind === 'file' && preview;
    if (mediaPath !== src.path || src.kind !== 'file') {
      durationSec = null;
      mediaPath = src.kind === 'file' ? src.path : null;
      positionSec = 0;
      requestedPositionSec = null;
    }
    if (!windowAlive()) { windowState = null; windowOpened = false; }
    if (ffmpegPath === 'ffmpeg') {
      try { ffmpegPath = resolveFfmpeg().path; } catch { /* ignore */ }
    }
    let engine = src.engine ?? 'auto';
    if (src.kind === 'screen' && engine === 'auto') engine = await pickScreenEngine({ ffmpegPath, device: src.device });
    if (current !== generation || disposed) throw new Error('采集启动已取消');
    const size = SIZES[q] ?? SIZES[DEFAULT_QUALITY];
    const p = createPipeline({ ...opts, ...(src.kind === 'file' ? { queueDepth: 0 } : {}), width: size[0], height: size[1] });
    runOpts = { ...opts };
    delete runOpts.oneShot;
    const s = { ...src, engine };
    delete s.seek;
    quality = q ?? DEFAULT_QUALITY;
    frames = 0;
    lastError = null;
    running = true;
    source = s;
    lastSource = s;
    pipeline = p;
    startedAt = Date.now();
    try {
      run = spawnCapture({
        source: s.kind === 'file' ? { ...s, seek: resumeAt } : s,
        width: p.constants.width,
        height: p.constants.height,
        fps: p.constants.fps,
        ffmpegPath,
        engine,
        baseSec: resumeAt,
        onFrame: (f) => {
          if (current !== generation) return false;
          frames += 1;
          decodedAt = f.t;
          p.push(f);
          if (s.kind === 'file' && previewing) {
            p.flushNow(null, 'seek', { preserveQueue: true });
            previewing = false;
          }
          emitStatus();
          return s.kind !== 'file' || (!userPaused && !delivery && p.pending === 0);
        },
        onStderr: (s2) => { if (process.env.DSH_SEE_NOW_DEBUG) log(s2.trim()); },
      });
      phase = 'running';
      if (userPaused && !previewing) run.pause();
    } catch (e) {
      lastError = String(e?.message ?? e);
      teardown('failed');
      throw e;
    }
    run.done.then((result) => {
      if (current !== generation || disposed) return;
      if (s.kind === 'file' && result.reason === 'eof') {
        p.finish({ includeLast: true });
        endedSource = s;
        teardown('eof');
        emitStatus(true);
      } else {
        lastError = `采集意外结束（${result.frames} 帧）`;
        teardown('failed');
      }
    }).catch((e) => {
      if (current !== generation || disposed) return;
      lastError = String(e?.message ?? e);
      teardown('failed');
    });
    if (s.kind === 'file') {
      Promise.resolve(probe(s.path, { ffmpegPath })).then((metadata) => {
        if (current !== generation || disposed) return;
        durationSec = metadata?.durationSec ?? null;
        emitStatus(true);
      }).catch(() => {});
    }
    log(`开始看 ${s.kind}${engine && engine !== 'auto' ? `/${engine}` : ''} @${size[0]}×${size[1]}`);
    const warning = s.kind === 'screen' ? screenEngineWarning() : null;
    if (warning) log(`⚠️ ${warning}`);
    emitStatus(true);
    return { started: true, source: s, engine, quality, params: p.constants, warning };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ensureWindow(signal = null) {
    if (disposed || signal?.aborted) return { ok: false, reason: 'cancelled' };
    if (windowState?.ok && windowAlive()) return windowState;
    if (windowPending) return windowPending;
    if (windowAbort.signal.aborted) windowAbort = new AbortController();
    const activeSignal = signal ? AbortSignal.any([signal, windowAbort.signal]) : windowAbort.signal;
    windowPending = openCaptureWindow({ log, signal: activeSignal,
      onCommand: (command) => windowHandlers.onCommand?.(command), onClose(status) {
      windowState = { ok: false, ...status };
      if (disposed || ['stopped', 'cancelled'].includes(status.reason)) return;
      if (status.state === 'closed' && status.reason === 'user') {
        hungUp = true;
        teardown('window-closed');
      } else if (status.state === 'failed') {
        lastError = status.reason;
        teardown('window-failed');
      }
    } }).then((st) => {
      windowState = st;
      if (st.ok) {
        windowOpened = true;
        log(st.already ? '悬浮窗已开着' : `悬浮窗已开（${st.from}）`);
      } else {
        log(`悬浮窗没开起来：${st.reason}`);
      }
      emitStatus(true);
      return st;
    }).finally(() => { windowPending = null; });
    return windowPending;
  }

  async function changePlayback(position, { nextQuality = quality, nextOpts = runOpts, preview = true } = {}) {
    if (disposed || lastSource?.kind !== 'file') return { ok: false, reason: 'not-file', playback: playback() };
    if (!Number.isFinite(position) || position < 0) return { ok: false, reason: 'invalid-position', playback: playback() };
    if (controlBusy) return { ok: false, reason: 'busy', playback: playback() };
    controlBusy = true;
    const paused = userPaused;
    const src = lastSource;
    try {
      const frameSec = 1 / (pipeline?.constants.fps ?? 12);
      const at = durationSec == null ? position : Math.min(position, Math.max(0, durationSec - frameSec));
      requestedPositionSec = at;
      const pendingStop = teardown('reconfigure');
      const expected = generation;
      await pendingStop;
      if (disposed || hungUp || expected !== generation) return { ok: false, reason: 'cancelled', playback: playback() };
      pipeline = null;
      delivery = null;
      await start({ src, opts: nextOpts, quality: nextQuality, resumeAt: at, paused, preview, preservePosition: true });
      const current = generation;
      if (preview) {
        const until = Date.now() + 15_000;
        while (current === generation && !pipeline?.pending && running && Date.now() < until) await sleep(20);
        if (current !== generation) return { ok: false, reason: 'cancelled', playback: playback() };
        if (!pipeline?.pending && lastError) return { ok: false, reason: 'capture-failed', error: lastError, playback: playback() };
        if (!pipeline?.pending && running) return { ok: false, reason: 'preview-timeout', playback: playback() };
      }
      if (paused) await teardown('paused');
      emitStatus(true);
      return { ok: true, playback: playback(), sheet: pipeline?.peek() ?? null };
    } finally { controlBusy = false; }
  }

  const api = {
    start,
    setWindowHandlers(handlers = {}) { windowHandlers = { ...handlers }; emitStatus(true); },
    async pause() {
      if (disposed || lastSource?.kind !== 'file') return { ok: false, reason: 'not-file', playback: playback() };
      if (userPaused) return { ok: true, playback: playback() };
      userPaused = true;
      await teardown('paused');
      emitStatus(true);
      return { ok: true, playback: playback() };
    },
    async resume() {
      if (disposed || lastSource?.kind !== 'file') return { ok: false, reason: 'not-file', playback: playback() };
      if (!userPaused) return { ok: !endedSource, reason: endedSource ? 'file-ended' : undefined, playback: playback() };
      const at = requestedPositionSec ?? (deliveredAt === null ? 0 : deliveredAt + 1 / (pipeline?.constants.fps ?? 12));
      userPaused = false;
      return changePlayback(at, { preview: false });
    },
    seek(position) { return changePlayback(position); },
    configure({ quality: q = null, opts = {} } = {}) {
      const at = requestedPositionSec ?? (deliveredAt === null ? 0 : deliveredAt + 1 / (pipeline?.constants.fps ?? 12));
      return changePlayback(at, { nextQuality: q ?? quality, nextOpts: opts, preview: true });
    },
    async stop({ closeWindow: closeWin = false, reason = null } = {}) {
      if (closeWin) {
        windowOpened = false;
        try { await closeWindow(); } catch (e) { log(`关窗失败：${e?.message ?? e}`); }
      }
      stopReason = reason ?? 'stopped';
      return teardown(reason ?? 'stopped');
    },
    hangUp() {
      hungUp = true;
      return teardown('hangup');
    },
    async restart(options = {}) {
      const prev = source ?? lastSource ?? { kind: 'screen' };
      await teardown('restart');
      return start({ src: prev, quality, opts: runOpts, ...options });
    },
    async dispose() {
      disposed = true;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      windowAbort.abort();
      await teardown('disposed');
    },
    isHungUp() { return hungUp; },
    endedFile() { return endedSource ? { ...endedSource } : null; },
    windowWasOpen() { return windowOpened; },
    peek({ allowPaused = false } = {}) {
      if (userPaused && !allowPaused) return null;
      const s = takeSheet() ?? (lastSource?.kind === 'file' ? null : pipeline?.flushNow());
      if (running) armGrace();
      if (!hungUp && !windowState?.ok && !windowPending) void ensureWindow();
      return s ?? null;
    },
    acknowledge,
    touch,
    note(msg) {
      if (msg) pendingNote = String(msg);
    },
    takeNote() {
      const msg = pendingNote;
      pendingNote = null;
      return msg;
    },
    async watch({
      seconds = 300, minFrames = 1, src = null, quality: q = null, opts = {},
      signal = null, eagerMs = 3000,
    } = {}) {
      if (disposed || signal?.aborted) return { ok: false, reason: 'cancelled', waited: 0 };
      const explicitSrc = Boolean(src && src.kind);
      const filePending = Boolean(delivery || pipeline?.pending);
      const blocked = guardReason({ hungUp, fileEnded: Boolean(endedSource) && !filePending, explicitSrc });
      if (blocked === 'hung-up') return { ok: false, reason: 'hung-up', waited: 0 };
      if (blocked === 'file-ended') {
        return { ok: false, reason: 'file-ended', waited: 0, path: endedSource?.path };
      }
      if (explicitSrc) hungUp = false;
      if (busy) return { ok: false, reason: 'busy', waited: 0 };
      busy = true;
      const t0 = Date.now();
      try {
        const prevSrc = source ?? lastSource;
        const normalized = (s) => s && { kind: s.kind, path: s.path ?? null, device: s.device ?? null,
          region: s.region ?? null, mouse: s.mouse === true, realtime: s.realtime === true };
        const sourceChanged = Boolean(src) && optsSig(normalized(src)) !== optsSig(normalized(prevSrc));
        const switching = Boolean(pipeline) && q && SIZES[q] && q !== quality;
        const modeChanged = Boolean(pipeline) && optsSig(runOpts) !== optsSig(opts);

        const draining = Boolean(endedSource) && filePending && !sourceChanged;
        const replay = Boolean(endedSource) && explicitSrc && !filePending;
        const stopped = Boolean(pipeline) && !running && !draining && !userPaused;
        const pausedPreview = userPaused && requestedPositionSec !== null && filePending;
        if (userPaused && !pausedPreview && !sourceChanged && !switching && !modeChanged) {
          return { ok: false, reason: 'paused', playback: playback(), waited: 0 };
        }
        const cold = !pipeline || stopped;
        if (!draining && (!pipeline || stopped || sourceChanged || switching || modeChanged || replay)) {
          const target = src ?? prevSrc ?? { kind: 'screen' };
          const resumeAt = target.kind === 'file' && !sourceChanged && !replay
            ? (deliveredAt === null ? 0 : deliveredAt + 1 / (pipeline?.constants.fps ?? 12)) : 0;
          if (pipeline) await teardown('reconfigure');
          await start({
            src: target,
            opts: { ...opts, oneShot: switching },
            quality: q ?? quality,
            resumeAt,
            paused: !sourceChanged && !replay && userPaused,
            preview: !sourceChanged && !replay && userPaused,
            preservePosition: !sourceChanged && !replay,
          });
        } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

        const win = await ensureWindow();

        const pollUser = () => {
          const said = (typeof chatPoll === 'function' ? chatPoll() : []).filter((e) => e.role === 'user');
          if (!said.length) return null;
          return said.map((e) => e.text).join(' / ').slice(0, 800);
        };

        const interjectNow = async (text) => {
          noteInterjected(text);
          for (let i = 0; i < 8 && pipeline && !pipeline.hasFrame; i += 1) await sleep(100);
          let now = lastSource?.kind === 'file' ? takeSheet() : pipeline?.flushNow(null, 'user');
          if (!now && lastSource?.kind === 'file' && pipeline?.hasFrame) {
            run?.pause();
            pipeline.finish();
            now = takeSheet();
            if (!now) {
              now = pipeline.flushNow(null, 'user');
              if (now) delivery = { sheet: now, pipeline };
            }
          }
          const waited = (Date.now() - t0) / 1000;
          return now
            ? { ok: true, sheet: now, waited, quality, userText: text }
            : { ok: false, reason: 'user-no-frame', waited, userText: text };
        };

        const deadline = t0 + Math.max(2, seconds) * 1000;
        const leaveChan = enterChatWait();
        try {
          if (cold && minFrames <= 1 && eagerMs > 0) {
            const eagerUntil = Date.now() + eagerMs;
            while (Date.now() < eagerUntil && !signal?.aborted) {
              const said = pollUser();
              if (said) return await interjectNow(said);
              if (pipeline?.hasFrame) {
                const first = pipeline.flushNow(null, 'first');
                if (first) {
                  if (lastSource?.kind === 'file') delivery = { sheet: first, pipeline };
                  return {
                    ok: true, sheet: first, waited: (Date.now() - t0) / 1000,
                    quality, windowOpen: win.ok, first: true,
                  };
                }
              }
              await sleep(60);
            }
          }

          while (Date.now() < deadline) {
            if (signal?.aborted) {
              return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
            }
            const said = pollUser();
            if (said) return await interjectNow(said);
            if (userPaused && !pausedPreview) return { ok: false, reason: 'paused', playback: playback(), waited: (Date.now() - t0) / 1000 };
            const s = takeSheet();
            if (s) {
              if (s.frames.length >= minFrames || endedSource || requestedPositionSec !== null) {
                return { ok: true, sheet: s, waited: (Date.now() - t0) / 1000, quality, windowOpen: win.ok,
                  first: cold, partial: s.frames.length < minFrames, preview: pausedPreview, playback: playback() };
              }
              // 不够 minFrames 时丢弃这一张接着等下一张，不让 delivery 占死队列
              if (delivery?.sheet === s) delivery = null;
            }
            if (userPaused && !pausedPreview) return { ok: false, reason: 'paused', playback: playback(), waited: (Date.now() - t0) / 1000 };
            if (!running && !pipeline?.pending) break;
            await sleep(120);
          }
        } finally {
          leaveChan();
        }

        const queued = delivery?.sheet ?? pipeline?.peek();
        const last = queued ?? takeSheet() ?? pipeline?.flushNow(null, 'timeout');
        if (last && (last.frames.length >= minFrames || endedSource)) {
          if (lastSource?.kind === 'file' && (!delivery || delivery.sheet !== last)) {
            delivery = { sheet: last, pipeline };
          }
          return { ok: true, sheet: last, waited: (Date.now() - t0) / 1000, quality, windowOpen: win.ok,
            partial: true, playback: playback() };
        }
        const waited = (Date.now() - t0) / 1000;
        return {
          ok: false,
          reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
          availableFrames: last?.frames.length ?? 0,
          waited,
          error: lastError,
          windowOpen: win.ok,
        };
      } finally {
        busy = false;
        if (running) armGrace();
      }
    },
    status() {
      return {
        running,
        phase,
        stopReason,
        source,
        lastSource,
        ffmpegPath,
        mediaTime: deliveredAt,
        decodedTime: decodedAt,
        deliveryPending: Boolean(delivery),
        playback: playback(),
        availableFrames: (delivery?.sheet ?? pipeline?.peek())?.frames.length ?? 0,
        window: windowStatus(),
        hungUp,
        endedFile: endedSource?.path ?? null,
        quality,
        size: SIZES[quality],
        frames,
        since: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
        lastError,
        idleSec: stoppedAt ? Math.round((Date.now() - stoppedAt) / 1000) : 0,
        stats: pipeline?.stats ?? null,
        pending: pipeline?.pending ?? 0,
        sheets: pipeline?.stats?.sheets ?? 0,
        secondsSinceWake: pipeline?.secondsSinceWake ?? null,
        windowOpened,
        notePending: Boolean(pendingNote),
      };
    },
  };
  return api;
}
