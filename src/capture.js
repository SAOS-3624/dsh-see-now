/**
 * capture.js — 唯一 spawn ffmpeg 的地方。**一根 rawvideo 管道**，不再切分片。
 *
 * 为什么不是「2 秒一片 + `-ss` 回抓」：分片必须关闭才能 seek，光这一条就是 2 秒固定延迟；
 * 每抓一帧还要 spawn 一次 ffmpeg（实测 135ms）。实时场景要的是「帧到手就判、判完就留」，
 * 所以直接 `-f rawvideo` 吐 rgb24，帧在内存里，留帧零成本。
 *
 * ## 三种源的实测（Windows 机 2560×1600 屏 / i9-12900HX，12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `ddagrab`（桌面复制 API） | 370 ms | **0.28 核** | 走 GPU，屏幕的原生路子 |
 * | `gdigrab`（GDI 抓屏） | 310 ms | 0.45 核 | 每帧先从 GDI 拷 2560×1600 BGRA = **16 MB** 再缩 |
 * | `obs`（OBS 虚拟摄像头） | 575 ms | 0.13 核 | 设备侧已经缩好了，最省 |
 * | `camera`（USB 摄像头） | **1450 ms** | 0.14 核 | 首帧慢是**硬件唤醒**，参数救不了 |
 * | Nikon Webcam Utility（客户端没开） | — | 0.80 核 | 只有 3.4 fps，等于卡死 |
 *
 * 结论：屏幕源**默认用 ddagrab**，跑不起来退回 gdigrab；设备源别停进程 —— 首帧延迟只能靠常驻摊掉。
 *
 * ## macOS（M 系列 / Retina，同样 12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `avfoundation` 屏幕 | **~700 ms** | **~0.16 核** | 起会话慢（AVCaptureSession 冷启动），稳态最省 |
 *
 * 两条 macOS 特有的坑，都写在对应函数里，别删：
 *
 * ① **`-framerate` 在 avfoundation 屏幕源上不压速**。实测 `-frames:v 30` 只用 0.73 秒
 *    （≈40fps），挂上 `-r 12` 才是 3.05 秒。少了这一条，管道会被帧灌满 ——
 *    开发时真被灌出过 **240 GB / 几分钟**的 raw 文件。所以屏幕源在 macOS 上必须挂 `-r`，
 *    而 Windows 的 ddagrab/gdigrab 已经按 fps 抓了，再挂就是白跑一趟。
 *
 * ② **没有「屏幕录制」权限时它不报错，只给你一片纯黑**。exit code 还是 0，
 *    帧数正常，字节数正常。所以探针除了看"有没有帧"，还要看"帧里有没有东西"。
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/** 屏幕采集引擎。macOS 只有 avfoundation；Windows 走 ddagrab/gdigrab。 */
export const ENGINES = Object.freeze(['auto', 'ddagrab', 'gdigrab', 'avfoundation']);

/** macOS 上屏幕设备的默认名字。`-list_devices` 里它永远是英文，相机才是本地化的。 */
export const DEFAULT_SCREEN_DEVICE = 'Capture screen 0';

/**
 * 纯黑帧的提示语。macOS 不会告诉你"权限没给"，只会默默给黑屏 ——
 * 这句是唯一能把人从"插件坏了"领到"系统设置"的路标。
 */
export const SCREEN_PERMISSION_HINT =
  'ffmpeg 没有「屏幕录制」权限：系统设置 → 隐私与安全性 → 屏幕录制，勾上跑 DSH 的那个 App（或终端），重启它再试。';

/** 源描述 → 输入参数。纯函数，可单测。 */
export function sourceArgs(
  source = { kind: 'screen' },
  { engine = 'auto', fps = 12, platform = process.platform, pixelFormat = null } = {},
) {
  const s = source ?? {};
  const mac = platform === 'darwin';

  switch (s.kind) {
    case 'obs':
    case 'camera': {
      const fallback = s.kind === 'obs' ? 'OBS Virtual Camera' : 'HD Webcam';
      const device = s.device ?? fallback;
      if (mac) {
        // macOS 没有 dshow；OBS 虚拟摄像头/本机摄像头都以设备身份出现在 avfoundation 里，
        // 名字和索引都能用。`-framerate` 在这里是**设备侧采样率**，必须给。
        return ['-f', 'avfoundation', '-framerate', String(fps), '-i', `${device}:none`];
      }
      return ['-rtbufsize', '256M', '-thread_queue_size', '512',
        '-f', 'dshow', '-i', `video=${device}`];
    }
    case 'screen': {
      if (mac || s.engine === 'avfoundation' || engine === 'avfoundation') {
        // ① 屏幕合成不走 GPU 路径，只能靠 AVFoundation 推流；
        // ② `-capture_cursor` 必须显式给（默认值随系统版本变，不能靠）；
        // ③ 音频写 `none`，否则某些系统会去开麦克风，触发额外的权限弹窗；
        // ④ `-pixel_format` 不给就默认 yuv420p，而屏幕输入**不支持** yuv420p ——
        //    每进程刷一行 "not supported" 到 stderr。探针会挑一个设备真收的格式，
        //    顺手把那行噪音也消掉（否则真出错时被截断的 300 字里全是它）。
        const pf = s.pixelFormat ?? pixelFormat;
        return ['-f', 'avfoundation', '-framerate', String(fps),
          ...(pf ? ['-pixel_format', pf] : []),
          '-capture_cursor', s.mouse ? '1' : '0',
          '-i', `${s.device ?? DEFAULT_SCREEN_DEVICE}:none`];
      }
      const useDda = s.engine === 'ddagrab' || (s.engine !== 'gdigrab' && engine !== 'gdigrab');
      if (!useDda) {
        // gdigrab 的 -framerate 是**设备侧**采样率，必须给，否则默认 29.97 白解码
        const region = s.region
          ? ['-offset_x', String(s.region.x), '-offset_y', String(s.region.y),
            '-video_size', `${s.region.w}x${s.region.h}`]
          : [];
        return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', ...region,
          '-i', s.desktop ?? 'desktop'];
      }
      // ddagrab 是 filter source，输入侧没有帧率参数
      return ['-f', 'lavfi', '-i', `ddagrab=framerate=${fps}:draw_mouse=${s.mouse ? 1 : 0}`];
    }
    case 'file':
      // `realtime` 才加 -re；离线跑要看的是「管线本身多快」，不能被播放速度骗了
      return [...(s.realtime ? ['-re'] : []), '-i', String(s.path)];
    case 'rtmp':
      return s.listen === false ? ['-i', String(s.url)] : ['-listen', '1', '-i', String(s.url)];
    default:
      throw new RangeError(`unknown source kind: ${s.kind}`);
  }
}

/** ddagrab 出来的帧还在 GPU 上，得先 hwdownload 再缩。 */
function isDda(source, engine, platform = process.platform) {
  if (source?.kind !== 'screen') return false;
  const e = source?.engine ?? engine;
  if (e === 'ddagrab') return true;
  // `auto` 在 Windows 上默认就是 ddagrab；macOS 上它不是候选，别给它套 hwdownload
  return e === 'auto' && platform !== 'darwin';
}

/**
 * 完整的采集命令。
 *
 * **`-r` 只在需要压速时才挂**：gdigrab/ddagrab 已经按 fps 抓了，再串一个 fps 滤镜是白跑一趟
 * （实测 12fps 下省 3–5% CPU）。但 avfoundation 的屏幕源不认 `-framerate` 当节流阀，
 * 必须靠输出侧 `-r` 把 40fps 压回 12fps —— 见文件头 macOS 坑 ①。
 */
export function captureArgs({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  fast = true, sws = 'area', platform = process.platform,
} = {}) {
  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
  const engineUsed = source?.engine ?? engine;
  if (fast) {
    // `-fflags nobuffer` 只对**直播式**输入有意义，而且它会把 `-re` 的文件回放直接堵死
    // （实测：加上它、配上 -re，4 秒一个字节都不出；去掉立刻 57MB）。
    if (source?.kind !== 'file') args.push('-fflags', 'nobuffer');
    args.push('-flags', 'low_delay');
    if (source?.kind === 'obs' || source?.kind === 'camera') {
      args.push('-probesize', '32', '-analyzeduration', '0');
    }
  }
  args.push(...sourceArgs(source, {
    engine, fps, platform,
    pixelFormat: source?.pixelFormat !== undefined
      ? source.pixelFormat
      : (platform === 'darwin' && source?.kind === 'screen' ? cachedFormat : null),
  }));
  args.push('-an', '-sn');

  const filters = [];
  if (isDda(source, engine, platform)) filters.push('hwdownload', 'format=bgra');
  // avfoundation 没有 gdigrab 那种 `-video_size` 局部抓取，裁剪只能在滤镜里做。
  // 坐标按**采集分辨率**算（Retina 上是逻辑分辨率的 2 倍），不做自动换算。
  if (source?.kind === 'screen' && (platform === 'darwin' || engineUsed === 'avfoundation') && source?.region) {
    const r = source.region;
    filters.push(`crop=${r.w}:${r.h}:${r.x}:${r.y}`);
  }
  filters.push(`scale=${width}:${height}:flags=${sws}`);
  args.push('-vf', filters.join(','));

  if (source?.kind !== 'screen' || (platform === 'darwin' || engineUsed === 'avfoundation')) {
    args.push('-r', String(fps));
  }
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return args;
}

/**
 * 同步逐帧回调；返回 false 同时暂停内部 drain 和 stdout，resume 后先消费保留的字节。
 * 文件时间使用 baseSec + i/fps；实时源使用首帧起算的单调时钟。
 * stop 幂等并返回 done；done 只在进程关闭且保留帧消费完后完成。
 */
export function spawnFrames({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  onFrame, onStderr = null, onFirst = null, baseSec = source?.seek ?? source?.startSec ?? 0,
  firstFrameTimeoutMs = 15_000, spawnProcess = spawn,
} = {}) {
  if (![width, height].every((n) => Number.isInteger(n) && n > 0) || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(baseSec) || baseSec < 0) {
    throw new RangeError('采集宽高必须是正整数，fps 为正数，baseSec 为非负秒数');
  }
  const args = captureArgs({ source, width, height, fps, ffmpegPath, engine }).slice(1);
  const child = spawnProcess(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const need = width * height * 3;
  let pending = null;
  let n = 0;
  const t0 = performance.now();
  let firstAt = null;
  let err = '';
  let paused = false;
  let stopped = false;
  let settled = false;
  let closed = null;
  let failure = null;
  let timer = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolveDone2, rejectDone2) => { resolveDone = resolveDone2; rejectDone = rejectDone2; });

  function settle() {
    if (settled || !closed || (!stopped && !failure && pending?.length)) return;
    settled = true;
    clearTimeout(timer);
    if (failure) rejectDone(failure);
    else resolveDone({ reason: stopped ? 'stopped' : 'eof', frames: n, ms: performance.now() - t0, ...closed });
  }
  function fail(error) {
    if (failure || settled || stopped) return;
    clearTimeout(timer);
    failure = error;
    pending = null;
    child.stdout.resume();
    if (!closed) { try { child.kill('SIGKILL'); } catch { /* 等待已退出进程的 close */ } }
    settle();
  }
  function drain() {
    try {
      while (!paused && !stopped && !failure && pending?.length >= need) {
        const buf = pending.subarray(0, need);
        pending = pending.subarray(need);
        const i = n++;
        if (i === 0) {
          clearTimeout(timer);
          firstAt = performance.now();
          onFirst?.(firstAt - t0);
        }
        const t = source?.kind === 'file' ? baseSec + i / fps : (performance.now() - firstAt) / 1000;
        if (onFrame?.({ i, t, buf }) === false) { paused = true; child.stdout.pause(); }
      }
      if (pending?.length === 0) pending = null;
      if (closed && pending?.length && pending.length < need && !paused && !stopped) {
        fail(new Error(`FFmpeg 原始帧不完整：${pending.length}/${need} 字节`));
      }
    } catch (error) { fail(error); }
    settle();
  }
  child.stdout.on('data', (chunk) => {
    if (stopped || failure) return;
    pending = pending?.length ? Buffer.concat([pending, chunk]) : chunk;
    drain();
  });
  child.stderr.on('data', (d) => {
    err = `${err}${d}`.slice(-4000);
    try { onStderr?.(String(d)); } catch (error) { fail(error); }
  });
  child.on('error', (error) => fail(new Error(`FFmpeg 启动失败（${ffmpegPath}，${error.code ?? 'error'}）：${error.message}`, { cause: error })));
  child.on('close', (code, signal) => {
    closed = { code, signal: signal ?? null };
    clearTimeout(timer);
    if (!stopped && code !== 0) fail(new Error(`FFmpeg 退出（${ffmpegPath}，code=${code}，signal=${signal ?? 'none'}）：${err.trim().slice(-1000) || '无 stderr'}`));
    drain();
  });
  if (firstFrameTimeoutMs > 0) timer = setTimeout(() => {
    fail(new Error(`FFmpeg ${firstFrameTimeoutMs}ms 内未产生首帧（${ffmpegPath}）：${err.trim().slice(-1000) || '无 stderr'}`));
  }, firstFrameTimeoutMs);

  return {
    done,
    pause() { if (!settled) { paused = true; child.stdout.pause(); } },
    resume() {
      if (settled || stopped || failure) return;
      paused = false;
      drain();
      if (!paused && !closed && !failure) child.stdout.resume();
    },
    stop() {
      if (!stopped && !settled) {
        stopped = true;
        pending = null;
        clearTimeout(timer);
        child.stdout.resume();
        if (!closed) { try { child.kill('SIGKILL'); } catch { /* 等待 close */ } }
        settle();
      }
      return done;
    },
  };
}

/* ---------------------------------------------------------------- 引擎探测 */

/**
 * 屏幕源用哪个引擎 —— **测一次、整个进程记住**。
 *
 * 为什么需要探测（Windows）：`ddagrab` 走桌面复制 API，独占全屏的游戏 / 部分远程桌面会把它挡住
 * （报 "Selected output not supported" 或者干脆不吐帧）。那种情况下不能哑着 ——
 * 退到 `gdigrab` 只是多花 0.17 核，画面照样能看。
 *
 * 代价是进程里第一次开屏幕要多 spawn 一次 ffmpeg（~400ms）。所以结果缓存，
 * 之后每次 start 都是 0 成本；本机这两种引擎的可用性不会在一次会话里变。
 *
 * macOS 没有备选引擎，但探针**仍然要跑**：它顺带替我们回答"屏幕录制权限给了没"。
 * 没权限的时候 ffmpeg 照样 exit 0、照样吐帧，只是全黑 —— 只有看平均像素才知道。
 */
let cachedEngine = null;
let cachedFormat = null;            // macOS 屏幕像素格式：'' = 用设备默认
let screenWarning = null;

export function resetScreenEngineCache() {
  cachedEngine = null;
  cachedFormat = null;
  screenWarning = null;
}

/** 上一次探测留下的警告（目前只有"没有屏幕录制权限"这一类）。 */
export function screenEngineWarning() {
  return screenWarning;
}

/** 抽样求均值就够了，不用全量遍历 6912 字节 × 每帧。 */
function meanOf(buf) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 97) {
    sum += buf[i];
    n += 1;
  }
  return n ? sum / n : 0;
}

export function pickScreenEngine({
  ffmpegPath = 'ffmpeg', fps = 12, timeoutMs = 2500, platform = process.platform,
} = {}) {
  if (cachedEngine) return Promise.resolve(cachedEngine);
  if (platform === 'darwin') return probeAvfoundation({ ffmpegPath, fps, timeoutMs });
  if (platform !== 'win32') {
    return Promise.reject(new RangeError(
      `屏幕采集还没接 ${platform}：Windows 走 ddagrab/gdigrab，macOS 走 avfoundation，Linux 需要 x11grab 或 PipeWire，还没做。`,
    ));
  }
  return probeDdagrab({ ffmpegPath, fps, timeoutMs });
}

/** macOS：探一次 avfoundation，同时判黑屏（= 没权限）。 */
/**
 * macOS：探一次 avfoundation —— 一次回答三个问题。
 *
 * ① 能不能出帧（ffmpeg 在不在、设备名对不对）；
 * ② **哪个像素格式设备真收**（默认的 yuv420p 屏幕输入不支持，必须自己试）；
 * ③ 画面是不是全黑（= 系统没给「屏幕录制」权限，ffmpeg 自己不会报）。
 *
 * 顺序是**按实测 CPU 从省到费**排的（本机 12fps→800×450：nv12 0.14 核 ≈ uyvy422 0.15 ≈
 * 设备默认 0.14，bgr0 0.23）。格式不对时 ffmpeg 会很快报错退出，所以串行试不会拖慢。
 */
async function probeAvfoundation({ ffmpegPath, fps, timeoutMs }) {
  const W = 64;                      // 探针只取 1 帧，尺寸越小越快
  const H = 36;
  const formats = ['nv12', 'uyvy422', 'bgr0', null];
  for (const pf of formats) {
    const shot = await grabOneFrame({ ffmpegPath, fps, width: W, height: H, pixelFormat: pf, timeoutMs });
    if (!shot.got) continue;
    cachedEngine = 'avfoundation';
    cachedFormat = pf ?? '';
    // 拿到帧但全是黑的 → 有采集会话、没画面，这就是 macOS 的"没权限"的样子。
    screenWarning = meanOf(shot.buf) < 1 ? SCREEN_PERMISSION_HINT : null;
    return 'avfoundation';
  }
  // 一帧都没拿到：启动层面的问题（ffmpeg 不在、设备名不对），留给 start 报错。
  cachedEngine = 'avfoundation';
  cachedFormat = '';
  screenWarning = null;
  return 'avfoundation';
}

/** 单帧探针。拿到满一帧就提前 resolve，不等 close。 */
function grabOneFrame({ ffmpegPath, fps, width, height, pixelFormat, timeoutMs }) {
  const args = captureArgs({
    source: { kind: 'screen', engine: 'avfoundation', pixelFormat: pixelFormat ?? '' },
    width, height, fps, ffmpegPath, engine: 'avfoundation',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');
  const need = width * height * 3;

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve({ got: buf.length >= need, buf: buf.subarray(0, need) });
    };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= need) { clearTimeout(timer); finish(); }
    });
    child.on('error', () => { clearTimeout(timer); finish(); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
}

/** Windows：探 ddagrab，不行退 gdigrab。 */
function probeDdagrab({ ffmpegPath, fps, timeoutMs }) {
  const W = 64;
  const H = 36;                     // 探针只取 1 帧，尺寸越小越快
  const args = captureArgs({
    source: { kind: 'screen', engine: 'ddagrab' }, width: W, height: H, fps, ffmpegPath, engine: 'ddagrab',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let got = 0;
    const done = (engine) => {
      cachedEngine = engine;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve(engine);
    };
    const timer = setTimeout(() => done('gdigrab'), timeoutMs);
    child.stdout.on('data', (d) => {
      got += d.length;
      if (got >= W * H * 3) { clearTimeout(timer); done('ddagrab'); }
    });
    child.on('error', () => { clearTimeout(timer); done('gdigrab'); });
    child.on('close', () => { clearTimeout(timer); if (!got) done('gdigrab'); });
  });
}
