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
import { createPipeline } from './pipeline.js';
import { chatWatcherShared, enterChatWait } from './chat.js';
import { noteInterjected } from './interject.js';
import { openWindow, windowAlive } from './window.js';

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
 * 三档节奏。**只影响"多久算一次画面变了"和"多久叫醒一次"**，不改出图口径。
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
 *
 * 7 是能给的最低值（再低只有"只改亮度"那种肉眼都看不出的变化），
 * 但它对日常屏幕太敏感 —— 光标一停、窗口一换都能过线，所以不做默认。
 *
 * 80 看着离谱，其实是被内容逼的：动作游戏里每帧都有大位移，正常切点淹没在运动里。
 * 这一档同时把积分阈值从 144 抬到 1440（`integralSeconds` 3 → 30），
 * 否则"改画面"的门槛抬了、出帧密度却没降，还是会被叫到贴限速。
 */
export const PACES = Object.freeze({
  calm: { cutAbs: 20, wakeGapSec: 30 },
  normal: { cutAbs: 12, wakeGapSec: 15 },
  dense: { cutAbs: 7, wakeGapSec: 8 },
  /**
   * 全屏动作游戏 / 高速运动画面。
   *
   * 为什么需要单独一档：这类画面**每一帧都在动**，分数基线被抬高，切点门槛 12 等于"全是切点"，
   * 尖峰判据也救不回来（左右邻居同样高）。实测反馈（B 站用户「总在冬眠的熊」，打了一两个小时
   * 全屏动作游戏后自己调出来的值）：cutAbs 80、积分阈值约 1800、每张 6 帧、maxWait 120s，
   * 才从"顶着限速发请求 + 40 帧一张巨糊"变成"舒适"。
   *
   * 这里取比他**略保守**的一组（积分 1440 而不是 1800，每张 8 帧而不是 6），
   * 因为他的 40 帧/张是在 normal 档下被 maxWait 逼出来的，不是他真想要 6 帧。
   * `pipeline` 里的键会原样覆盖 `pipeline.js::DEFAULTS` 的同名项。
   */
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
    },
  },
});
export const DEFAULT_PACE = 'normal';

/** 参数签名：key 排序后拼串，`{a:1,b:2}` 与 `{b:2,a:1}` 视为同一个。 */
function optsSig(o) {
  return Object.keys(o ?? {}).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join('|');
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

export function createRunner({ ffmpegPath = 'ffmpeg', log = () => {}, graceSec = 60, spawnCapture = spawnFrames, openCaptureWindow = openWindow } = {}) {
  let pipeline = null;   // 当前（或刚停的）引擎 —— 停采集后仍留着，好把队列里剩的图发完
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
  /**
   * 建当前管线时用的**调用方参数**（不含 oneShot）。
   *
   * 为什么需要：分辨率换了可以看 `quality`，但"逐帧模式"换的是管线参数
   * （`maxFrames` / `strategy`）—— 那些是建管线时定死的，运行中改不了。
   * 于是 watch 每次比一下签名，变了就重开：`{}` 和 `{maxFrames:1,strategy:'single'}`
   * 是两套完全不同的出图口径，不能在同一根管线上混着跑。
   */
  let runOpts = {};
  // 共享一个 watcher：每做一个新的会重新 prime（只记位置不读旧消息），
  // 那模型思考期间用户说的话就永远看不见了。
  const chatPoll = chatWatcherShared();
  let windowState = null;
  let windowPending = null;
  /**
   * 这一次会话里**窗真的开起来过**没有。
   *
   * 循环靠它区分两件完全不同的事：
   *   - 窗开过、现在没了 → **用户关掉了**，该停下来（那是"我不看了"）
   *   - 窗从来没开起来（没有带 tkinter 的 python）→ 不该当成用户关窗，继续看
   * 没有这个标记的话，第一种情况永远检不出、第二种情况会误判成挂断。
   */
  let windowOpened = false;

  /**
   * 待领的说明（挂断那一条）。
   *
   * **为什么不写进 chat.jsonl**：窗被关掉之后，写进那条流的字没有任何人会看到；
   * 模型也拿不到，于是它继续调 `watch` —— 实测会连写两条挂断说明（相隔 96ms），
   * 模型却在说"我还在看"。
   *
   * 正确的路子和陪看一样：落在这里，下一次工具结果把它带走。
   */
  let pendingNote = null;
  /**
   * 用户"关窗挂断"过没有。
   *
   * 关窗之后再被叫醒一次，`watch` 会**重新把窗开起来**、把采集重启 ——
   * 用户看到的是"关不掉，只能卸载插件"（社区实报）。所以这里是个硬闸：
   * 挂断之后只有**显式指定来源**（用户说了要看什么）才允许重新开始。
   */
  let hungUp = false;
  /** 最近一次的采集源（teardown 会把 `source` 清空，但事后判断还需要它） */
  let lastSource = null;
  /**
   * 已经放完的文件源。**文件回放是一次性的**：放完就结束，不能自动重播。
   *
   * 以前 `watch` 会在 `stopped` 时用 `prevSrc` 自动重启，而文件源重启就是
   * "从头再放一遍"，于是 24 秒解 1955 帧、出一堆图、把模型反复叫醒，
   * 关窗也停不下来（社区实报的那条）。
   */
  let endedSource = null;

  function teardown(why) {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    run?.stop();
    run = null;
    running = false;
    source = null;
    stoppedAt = Date.now();
    if (why) log(`收工：${why}`);
  }

  /** 停采集，但留一个宽限期 —— 这期间再来 watch 不用重新热启动 */
  function armGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    if (graceSec <= 0) { teardown('grace=0'); return; }
    graceTimer = setTimeout(() => teardown(`${graceSec}s 没人来`), graceSec * 1000);
    graceTimer.unref?.();
  }

  /**
   * 续命（常驻循环每拍调一次）。
   *
   * **不加这个，循环会被宽限期饿死**：一次 `watch` 结束后留 60 秒宽限，时间一到采集收工，
   * 而静止屏幕上 60 秒内又不会出新图 —— 循环下一拍看到 `!running && !pending`，
   * 就判定"采集自己停了"并自杀。用户安安静静看文档时，这个"常驻循环"最多活 60 秒。
   *
   * 只续"还在跑"的采集：ffmpeg 真死了不能靠它诈尸。
   */
  function touch() {
    if (!running) return false;
    armGrace();
    return true;
  }

  let userPaused = false, deliveredAt = null, positionSec = 0, requestedPositionSec = null, durationSec = null, delivery = null, controlBusy = false;
  function playback() {
    const file = lastSource?.kind === 'file';
    return { state: !file ? 'unavailable' : userPaused ? 'paused' : endedSource && !delivery && !pipeline?.pending ? 'ended' : running ? 'playing' : 'stopped',
      positionSec: file ? positionSec : 0, requestedPositionSec: file ? requestedPositionSec : null,
      durationSec: file ? durationSec : null, canSeek: Boolean(file) };
  }
  function takeSheet() {
    if (delivery) return delivery.sheet;
    const sheet = pipeline?.take();
    if (sheet && lastSource?.kind === 'file') delivery = { sheet, pipeline };
    return sheet ?? null;
  }
  function acknowledge(sheet) {
    if (!delivery || delivery.sheet !== sheet) return false;
    if (delivery.pipeline === pipeline) {
      deliveredAt = Math.max(deliveredAt ?? 0, sheet.to);
      positionSec = deliveredAt;
      requestedPositionSec = null;
      delivery = null;
      if (!userPaused && !pipeline?.pending) run?.resume();
    } else delivery = null;
    return true;
  }
  async function changePlayback(position, { nextQuality = quality, nextOpts = runOpts, preview = true } = {}) {
    if (lastSource?.kind !== 'file') return { ok: false, reason: 'unavailable', playback: playback() };
    if (!Number.isFinite(position) || position < 0) return { ok: false, reason: 'invalid-position', playback: playback() };
    if (controlBusy) return { ok: false, reason: 'busy', playback: playback() };
    controlBusy = true;
    const paused = userPaused;
    const src = lastSource;
    try {
      const frameSec = 1 / (pipeline?.constants.fps ?? 12);
      const at = durationSec == null ? position : Math.min(position, Math.max(0, durationSec - frameSec));
      requestedPositionSec = at;
      await teardown('reconfigure');
      pipeline = null;
      delivery = null;
      await start({ src: { ...src, startSec: at }, opts: nextOpts, quality: nextQuality, preservePosition: true, paused, preview });
      if (preview) {
        const until = Date.now() + 15_000;
        while (!pipeline?.pending && running && Date.now() < until) await sleep(20);
      }
      if (paused) await teardown('paused');
      return { ok: true, playback: playback(), sheet: pipeline?.peek() ?? null };
    } finally { controlBusy = false; }
  }
  async function pause() {
    if (lastSource?.kind !== 'file') return { ok: false, reason: 'unavailable', playback: playback() };
    if (userPaused) return { ok: true, playback: playback() };
    userPaused = true;
    await teardown('paused');
    return { ok: true, playback: playback() };
  }
  async function resume() {
    if (lastSource?.kind !== 'file') return { ok: false, reason: 'unavailable', playback: playback() };
    if (!userPaused) return { ok: !endedSource, reason: endedSource ? 'file-ended' : undefined, playback: playback() };
    const at = requestedPositionSec ?? (deliveredAt === null ? 0 : deliveredAt + 1 / (pipeline?.constants.fps ?? 12));
    userPaused = false;
    return changePlayback(at, { preview: false });
  }
  async function start({ src = { kind: 'screen' }, opts = {}, quality: q = null, preservePosition = false, paused = false, preview = false } = {}) {
    if (running && !preservePosition && src.kind !== 'file') return { already: true, source };
    // 走到这里就是"明确要开始看"（watch 的自动重启已经在前面被硬闸挡住了）。
    hungUp = false;
    endedSource = null;
    // **窗被用户关掉之后，这里必须复位**：`windowState` 缓存着 `{ok:true}`，
    // `windowOpened` 也还是 true —— 不复位的话下一次 watch 会（a）不再开窗，
    // （b）循环立刻又把"窗没了"判成用户关窗，落第二条挂断说明。
    if (!windowAlive()) { windowState = null; windowOpened = false; }
    let engine = src.engine ?? 'auto';
    if (src.kind === 'screen' && engine === 'auto') engine = await pickScreenEngine({ ffmpegPath });
    const size = SIZES[q] ?? SIZES[DEFAULT_QUALITY];
    // oneShot 由调用方（watch）决定：**只有换清晰度**时置 true（缓冲区刚扔，等攒满等于白等一个窗口）
    const p = createPipeline({ ...opts, ...(src.kind === 'file' ? { queueDepth: 0 } : {}), width: size[0], height: size[1] });
    // 记下"这次建管线用的调用方参数"（不含 oneShot）——watch 靠它发现"模式变了"。
    runOpts = { ...opts };
    delete runOpts.oneShot;
    const s = { ...src, engine };
    quality = q ?? DEFAULT_QUALITY;
    frames = 0;
    lastError = null;
    pipeline = p;
    running = true;
    source = s;
    lastSource = s;
    startedAt = Date.now();
    userPaused = s.kind === 'file' && paused;
    run = spawnCapture({
      source: s,
      width: p.constants.width,
      height: p.constants.height,
      fps: p.constants.fps,
      ffmpegPath,
      engine,
      baseSec: s.kind === 'file' ? Number(s.startSec ?? 0) : 0,
      onFrame: (f) => {
        frames += 1;
        try { p.push(f); } catch (e) { lastError = `push: ${e?.message ?? e}`; }
        if (s.kind === 'file' && preview) { p.flushNow(null, 'seek', { preserveQueue: true }); preview = false; }
        return s.kind !== 'file' || (!userPaused && !delivery && p.pending === 0);
      },
      onStderr: (s2) => { if (process.env.DSH_SEE_NOW_DEBUG) log(s2.trim()); },
    });
    if (userPaused && !preview) run.pause();
    run.done.then((r) => {
      if (pipeline === p) {
        if (r.reason === 'eof') {
          p.finish({ includeLast: true });
          endedSource = s;
          teardown('eof');
          return;
        }
        lastError ??= `ffmpeg 退出（${r.frames} 帧 / ${Math.round(r.ms / 1000)}s）`;
        teardown('ffmpeg-exit');
      }
    }).catch((e) => {
      lastError = `ffmpeg: ${e?.message ?? e}`;
      if (pipeline === p) teardown('ffmpeg-error');
    });
    log(`开始看 ${s.kind}${engine && engine !== 'auto' ? `/${engine}` : ''} @${size[0]}×${size[1]}`);
    // macOS 没给屏幕录制权限时，采集本身是"成功"的，只是画面全黑 ——
    // 探针已经试出来了，这里把它带回去，让模型（和用户）知道该去系统设置，而不是以为插件坏了。
    const warning = s.kind === 'screen' ? screenEngineWarning() : null;
    if (warning) log(`⚠️ ${warning}`);
    return { started: true, source: s, engine, quality, params: p.constants, warning, playback: playback() };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 把悬浮窗支起来（幂等）。**只在真要阻塞的时候调** —— 没在等就没必要弹窗。
   * 开不起来不算失败：模型照样能 watch，只是用户只能等下一轮。
   *
   * 注意是 await：要真跑一次 `import tkinter` 验解释器、再等 700ms 看它有没有退出，
   * 不然会拿到一个"成功"但其实早就退了的窗（pid 指向死进程）。
   */
  async function ensureWindow() {
    if (windowState?.ok) return windowState;
    if (windowPending) return windowPending;
    windowPending = openCaptureWindow({ log }).then((st) => {
      windowState = st;
      if (st.ok) {
        windowOpened = true;
        log(st.already ? '悬浮窗已开着' : `悬浮窗已开（${st.from}）`);
      } else {
        log(`悬浮窗没开起来：${st.reason}`);
      }
      return st;
    }).finally(() => { windowPending = null; });
    return windowPending;
  }

  return {
    start,
    stop() { teardown('手动'); return { stopped: true }; },
    /**
     * 用户关掉了悬浮窗 = 明确表示"不看了"。
     *
     * 只 `stop()` 不够：下一条 `watch` 看到 `stopped` 会立刻重启采集并把窗**重新开起来**，
     * 用户体感就是"关掉又弹出来，除非卸载插件"（社区实报）。这里立一个硬闸，
     * 直到有人显式指定来源为止。
     */
    hangUp() { hungUp = true; teardown('用户关窗'); return { hungUp: true }; },
    /** 挂断状态（测试和状态页用） */
    isHungUp() { return hungUp; },
    /** 有没有一个"已经放完、不能自动重播"的文件源 */
    endedFile() { return endedSource ? { ...endedSource } : null; },
    /** 这一轮开过窗没有（循环判"用户关窗"用） */
    windowWasOpen() { return windowOpened; },

    /**
     * 阻塞等一张图。
     *
     * `quality` 换了就**重启采集**（分辨率是采集侧定死的，改不了）：
     * 分辨率在采集那一层就定死了，所以换清晰度 = 换一根管道。重启一次 ~400ms，
     * 但换完只发一帧就把"现在是什么"给出去，不用再等攒满一张。
     *
     * @param {{seconds?:number, minFrames?:number, src?:object, quality?:string, opts?:object,
     *          signal?:AbortSignal|null, eagerMs?:number}} o
     * @returns {Promise<{ok:boolean, reason?:string, sheet?:object, waited:number}>}
     */
    async watch({
      seconds = 300, minFrames = 1, src = null, quality: q = null, opts = {},
      // 宿主给的取消信号。**必须在这里看**：不看的话用户按了停止，这个调用还要挂到封顶
      // （陪看那边专门写过这条：`signal` 是"这一轮被取消了"的唯一通知）。
      signal = null,
      // 冷启动时"先给此刻"的宽限：等第一帧最多这么久，等到就立刻出图。
      eagerMs = 3000,
    } = {}) {
      /**
       * 三个"不许自动重开"的硬闸。都来自社区实报：
       * 「回放会解 1955 帧、攒一堆唤醒、一直弹有新画面，关窗也停不干净，得卸载才行」。
       *
       * 共同原因是 `watch` 在 `stopped` 时会**自动重启采集**，而重启对文件源意味着
       * 从头再放一遍，对关过窗的用户意味着"我刚关掉它又弹出来了"。
       * 所以：只有**显式传了来源**（用户明确说要看什么）才允许清闸重开。
       */
      const explicitSrc = Boolean(src && src.kind);
      const blocked = guardReason({ hungUp, fileEnded: Boolean(endedSource), explicitSrc });
      if (blocked === 'hung-up') return { ok: false, reason: 'hung-up', waited: 0 };
      if (blocked === 'file-ended') {
        return { ok: false, reason: 'file-ended', waited: 0, path: endedSource?.path };
      }
      if (explicitSrc) { hungUp = false; endedSource = null; }

      if (busy) return { ok: false, reason: 'busy', waited: 0 };
      busy = true;
      const t0 = Date.now();
      try {
        const prevSrc = source ?? lastSource;
        const switching = Boolean(q && SIZES[q] && q !== quality);
        if (switching) delivery = null;
        // 管线参数变了（常规 ↔ 逐帧）：这两套口径建管线时就定死了，只能重开。
        const modeChanged = Boolean(pipeline) && optsSig(runOpts) !== optsSig(opts);
        /**
         * **要不要重开采集**：`pipeline` 不为空**不等于**采集还在跑。
         *
         * `teardown()` 故意留着 `pipeline`（好把队列里剩下的图发完），于是宽限期到点、
         * 或者模型 `stop` 之后，`pipeline` 还在但 `running` 已经是 false ——
         * 只看 `!pipeline` 就会"跳过启动、直接等一张永远不会来的图"，等到封顶才回一句
         * "没看成"。用户看到的是"第一次能看，第二次就不行了"。
         */
        const stopped = Boolean(pipeline) && !running;
        // **冷启动**（手上没有管线，或采集已经停了）才 eager。换清晰度不算 —— 那条路已经用 oneShot 了。
        const cold = !pipeline || stopped;
        if (!pipeline || stopped || switching || modeChanged) {
          if (pipeline) {
            teardown(stopped ? '采集已停，重开'
              : switching ? `换清晰度 ${quality} → ${q}` : '换模式（逐帧 / 常规）');
          }
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
          await start({
            src: src ?? prevSrc ?? { kind: 'screen' },
            // 只有**换清晰度**才 oneShot：那一下缓冲区刚被扔掉，等攒满一张就等于白等一整个窗口。
            // 普通的第一次 watch 不 oneShot —— 模型要的是"这 20 秒"，不是"此刻"。
            opts: { ...opts, oneShot: switching },
            quality: q,
          });
        } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

        // 真要阻塞了才支窗（第一次起进程 ~1.5s，之后是空操作）
        const win = await ensureWindow();

        /**
         * 取一条用户插话（没有就 null）。
         *
         * 只写一份：冷启动的 eager 和正常等待**都要先看插话**，各写一套就会出现
         * "eager 那段把话吃了但没带上"这种只在首帧复现的丢话。
         */
        const pollUser = () => {
          const said = chatPoll().filter((e) => e.role === 'user');
          if (!said.length) return null;
          return said.map((e) => e.text).join(' / ').slice(0, 800);
        };

        /** 用这句话截断出图（插话优先于一切：不等判据、不排队） */
        const interjectNow = async (text) => {
          // 记一条待回执：下一轮工具结果里如果还没带 `say`，就把「你还没回她」顶出来。
          // 模型很可能先去取图了，回来时那段话已经不在上下文最前面（陪看那边实报过）。
          noteInterjected(text);
          // 刚开采集时可能一帧都还没到（-probe 那几百毫秒）—— 用户问"这是什么"，
          // 空着手回去等于没看。最多等 0.8s 让第一帧到，再截断。
          for (let i = 0; i < 8 && pipeline && !pipeline.hasFrame; i += 1) await sleep(100);
          const now = pipeline?.flushNow(null, 'user');
          const waited = (Date.now() - t0) / 1000;
          return now
            ? { ok: true, sheet: now, waited, quality, userText: text }
            : { ok: false, reason: 'user-no-frame', waited, userText: text };
        };

        const deadline = t0 + Math.max(2, seconds) * 1000;
        // **登记成"我在等用户说话"**：常驻循环也盯这条通道，它一旦先把话吃掉，
        // 就会走 `followup` 投进会话 —— 而会话正卡在这个工具调用里等结果，
        // 那条消息要等这一轮结束才处理，**接不住"从等待里出来"**。
        // 用户看到的就是"我在窗口里说话，它一动不动"（陪看那边实报过）。
        //
        // 冷启动的 eager 也算"在等"：那 3 秒里用户说的话同样不能被循环吃掉。
        const leaveChan = enterChatWait();
        try {
          /**
           * **冷启动先给此刻**。
           *
           * 静止屏幕上第一条要等 30~60 秒（兜底帧 20 秒一个，攒 3 帧才封箱）——
           * 用户说"看看我屏幕"，等一分钟才回话，体感就是"它没反应"。
           * 所以冷启动时第一帧到手就发，多花一张图（216 token），换"1 秒内给反应"。
           *
           * 只在冷启动生效：管温着的时候再 eager，就退化成"每帧一张图"了。
           * **插话优先**：这 3 秒里用户说话了，就按插话走（体感上他是在追问）。
           */
          if (cold && minFrames <= 1 && eagerMs > 0) {
            const eagerUntil = Date.now() + eagerMs;
            while (Date.now() < eagerUntil && !signal?.aborted) {
              const said = pollUser();
              if (said) return await interjectNow(said);
              if (pipeline?.hasFrame) {
                const first = pipeline.flushNow(null, 'first');
                if (first) {
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
            // 宿主取消了这一轮（用户按停止 / 超时策略）就立刻收工，别继续挂着
            if (signal?.aborted) {
              return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
            }
            // **插话优先于一切**：用户说话了就立刻截断，不等判据、不排队
            const said = pollUser();
            if (said) return await interjectNow(said);
            const s = takeSheet();
            if (s) {
              // **正常返回也要过 minFrames**。以前只有超时分支检查，于是
              // `minFrames: 5` 在队列先到的路径上会被无视，照样交一张 1 帧的图
              // （issue #1 的复现：`{ ok: true, frames: 1 }`）。
              // 不够就丢掉这一张接着等 —— 到点还没攒够，会走下面的 no-change 提示。
              if (s.frames.length >= minFrames) {
                return { ok: true, sheet: s, waited: (Date.now() - t0) / 1000, quality, windowOpen: win.ok };
              }
            }
            if (!running && !pipeline?.pending) break;   // 采集停了，队列也空了
            await sleep(120);
          }
        } finally {
          leaveChan();
        }
        // 到点了：手上攒的半张也算数（用户已经在等），但不够 minFrames 就不给
        const last = pipeline?.flushNow(null, 'timeout');
        if (last && last.frames.length >= minFrames) {
          return { ok: true, sheet: last, waited: (Date.now() - t0) / 1000, partial: true, quality };
        }
        return {
          ok: false,
          reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
          waited: (Date.now() - t0) / 1000,
          error: lastError,
        };
      } finally {
        busy = false;
        if (pipeline) armGrace();
      }
    },

    /**
     * 取走**已经拼好的那一张**（后台唤醒走这条）。
     *
     * 语义是 "grab the sheet that already piled up" —— 模型被"有新画面了"叫醒时，
     * 要的就是那张攒好的图，不该再等、也不该换一张。
     *
     * **不能走 `flushNow()`**：那是插话用的，会把 `sheets` 整个清空、再把"此刻那一帧"
     * 塞成一张新图。结果是队列里攒好的多帧摘要被一张单帧替换掉 —— 复现见 issue #1：
     * `queued [0,2,4]` → 调完 peek 变成 `[5.92]`、`pending 0`。
     * 队列空就老实返回 null（调用方会提示"下一张还在攒"），
     * 想看"此刻"请走 `watch`。
     *
     * 顺便支窗（**不等它**）：走 peek 路线的会话没有 watch 的阻塞点，
     * 不在这里开窗的话，用户永远没有可以打字的入口，也就没有"关窗 = 不看了"。
     */
    peek({ allowPaused = false } = {}) {
      if (userPaused && !allowPaused) return null;
      const queued = takeSheet() ?? null;
      if (running) armGrace();
      if (!windowState?.ok && !windowPending) void ensureWindow();
      return queued;
    },
    acknowledge,

    /** 常驻循环每拍续命（见 touch 的注释） */
    touch,

    /** 落一条说明，等下一次工具结果带走（挂断那一条走这里） */
    note(text) {
      const t = String(text ?? '').trim();
      if (t) pendingNote = t;
      return pendingNote;
    },

    /** 取走说明（取完就没了：同一句话不该每一轮都念一遍） */
    takeNote() {
      const n = pendingNote;
      pendingNote = null;
      return n;
    },

    status() {
      return {
        running,
        source,
        lastSource,
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
        // 出图序号（单调递增）：常驻循环靠它保证"同一张图只叫醒一次"。
        // `pending` 只说明"队列里有"，不说明"是不是新的一张"—— 模型不取的话它一直是 1。
        sheets: pipeline?.stats?.sheets ?? 0,
        // 本批第一帧到现在多久：唤醒文案里要说"攒了多久"，不然模型不知道这段时间有多长
        secondsSinceWake: pipeline?.secondsSinceWake ?? null,
        // 这一轮开过窗没有（循环靠它区分"用户关了窗" 和 "窗压根没开起来"）
        windowOpened,
        // 有没有待领的说明（挂断那条）—— status 里看得见，才不会"明明写了没人读"
        notePending: Boolean(pendingNote),
        playback: playback(),
      };
    },
    pause, resume, seek(position) { return changePlayback(position); },
    configure({ quality: q = null, opts = {} } = {}) {
      const at = requestedPositionSec ?? (deliveredAt === null ? 0 : deliveredAt + 1 / (pipeline?.constants.fps ?? 12));
      return changePlayback(at, { nextQuality: q ?? quality, nextOpts: opts, preview: true });
    },
  };
}
