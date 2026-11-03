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

/** 区域参数校验。gdigrab 允许虚拟桌面跨屏的负坐标，其它引擎要求非负整数。 */
export function checkRegion(region, { allowNegative = false } = {}) {
  if (!region) return;
  const { x, y, w, h } = region;
  if (![x, y, w, h].every(Number.isInteger) || w <= 0 || h <= 0 || (!allowNegative && (x < 0 || y < 0))) {
    throw new RangeError('region 必须使用物理像素整数坐标，且宽高为正数');
  }
}

/** 保留底层证据；只有明确的 stderr 才归类权限或设备错误。 */
export function captureErrorInfo(error, stage = 'exit') {
  if (error?.errorInfo) return error.errorInfo;
  const message = String(error?.message ?? error);
  const category = error?.code === 'ENOENT' || /找不到 FFmpeg|spawn.*ENOENT/i.test(message) ? 'dependency-missing'
    : error instanceof RangeError ? 'invalid-input'
      : /permission denied|not authorized|operation not permitted|screen recording permission/i.test(message) ? 'permission-denied'
        : /device.*(?:not found|invalid)|invalid.*device|could not find.*device|video device.*not available/i.test(message) ? 'device-unavailable'
          : 'capture-failed';
  return { category, stage, code: error?.code ?? null, signal: error?.signal ?? null, stderrTail: error?.stderrTail ?? null };
}

/** 有界枚举设备；FFmpeg 的 list_devices 会主动退出，不进入采集。 */
export async function listDevices({
  ffmpegPath = 'ffmpeg', platform = process.platform, timeoutMs = 3000, spawnProcess = spawn,
} = {}) {
  if (!['darwin', 'win32'].includes(platform)) throw new RangeError(`${platform} 暂无设备枚举实现`);
  const input = platform === 'darwin' ? 'avfoundation' : 'dshow';
  const args = ['-hide_banner', '-list_devices', 'true', '-f', input, '-i', platform === 'darwin' ? '' : 'dummy'];
  return new Promise((resolveList, rejectList) => {
    let child;
    try {
      child = spawnProcess(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      const wrapped = new Error(`FFmpeg 设备枚举启动失败（${ffmpegPath}）：${err.message}`, { cause: err });
      wrapped.errorInfo = captureErrorInfo(err, 'spawn');
      rejectList(wrapped);
      return;
    }
    let stderr = '';
    let failure = null;
    const timer = setTimeout(() => {
      failure = new Error(`FFmpeg 设备枚举超过 ${timeoutMs}ms（${ffmpegPath}）`);
      try { child.kill('SIGKILL'); } catch { /* 等待 close */ }
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
    child.on('error', (error) => {
      failure = new Error(`FFmpeg 设备枚举启动失败（${ffmpegPath}）：${error.message}`, { cause: error });
      failure.errorInfo = captureErrorInfo(error, 'spawn');
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) { rejectList(failure); return; }
      const devices = [];
      let audio = false;
      for (const line of stderr.split(/\r?\n/)) {
        if (/AVFoundation audio devices/i.test(line)) audio = true;
        if (platform === 'darwin') {
          const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
          if (match) devices.push({ index: Number(match[1]), name: match[2], kind: audio ? 'audio' : /^Capture screen \d+$/.test(match[2]) ? 'screen' : 'camera' });
        } else {
          const match = line.match(/"(.+)"\s+\((video|audio)\)/);
          if (match) devices.push({ index: devices.filter((d) => (d.kind === 'audio') === (match[2] === 'audio')).length, name: match[1], kind: match[2] === 'audio' ? 'audio' : 'camera' });
        }
      }
      if (!devices.length) {
        const err = new Error(`FFmpeg 未返回设备（${ffmpegPath}，code=${code}，signal=${signal ?? 'none'}）：${stderr.trim().slice(-1000) || '无输出'}`);
        err.stderrTail = stderr.trim().slice(-1000) || null;
        err.errorInfo = captureErrorInfo(err, 'exit');
        rejectList(err);
        return;
      }
      resolveList({ ffmpegPath, platform, devices, stderr });
    });
  });
}

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
      if (!['darwin', 'win32'].includes(platform)) {
        throw new RangeError(
          `屏幕采集还没接 ${platform}：Windows 走 ddagrab/gdigrab，macOS 走 avfoundation，Linux 需要 x11grab 或 PipeWire，还没做。`,
        );
      }
      const selected = s.engine ?? engine;
      const useDda = selected === 'ddagrab' || (selected !== 'gdigrab' && engine !== 'gdigrab');
      const isGdi = !mac && (selected === 'gdigrab' || (!useDda && selected !== 'avfoundation'));
      checkRegion(s.region, { allowNegative: isGdi });
      if (mac || selected === 'avfoundation' || engine === 'avfoundation') {
        const pf = s.pixelFormat ?? pixelFormat;
        return ['-f', 'avfoundation', '-framerate', String(fps),
          ...(pf ? ['-pixel_format', pf] : []),
          '-capture_cursor', s.mouse ? '1' : '0',
          '-i', `${s.device ?? DEFAULT_SCREEN_DEVICE}:none`];
      }
      if (!useDda) {
        // gdigrab 的 -framerate 是**设备侧**采样率，必须给，否则默认 29.97 白解码
        const region = s.region
          ? ['-offset_x', String(s.region.x), '-offset_y', String(s.region.y),
            '-video_size', `${s.region.w}x${s.region.h}`]
          : [];
        return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', s.mouse ? '1' : '0', ...region,
          '-i', s.desktop ?? 'desktop'];
      }
      // ddagrab 是 filter source，输入侧没有帧率参数
      const output = s.device == null ? '' : `:output_idx=${s.device}`;
      return ['-f', 'lavfi', '-i', `ddagrab=framerate=${fps}:draw_mouse=${s.mouse ? 1 : 0}${output}`];
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
  if (source?.kind === 'screen' && (platform === 'darwin' || engineUsed === 'avfoundation' || engineUsed === 'ddagrab') && source?.region) {
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
 * 逐帧读，**同步回调**。回调里做的事会直接变成对 ffmpeg 的背压 —— 这是刻意的：
 * 判帧、留帧、重排都在回调里跑完，绝不让帧在内存里越堆越多。
 *
 * @returns {{stop:()=>void, done:Promise<{frames:number, ms:number, code:number|null}>}}
 */
export function spawnFrames({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  onFrame, onStderr = null, onFirst = null, spawnProcess = spawn,
} = {}) {
  const args = captureArgs({ source, width, height, fps, ffmpegPath, engine }).slice(1);
  const child = spawnProcess(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const need = width * height * 3;
  let pending = null;
  let n = 0;
  const t0 = Date.now();
  let err = '';
  let stopped = false;

  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      pending = pending?.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= need) {
        const buf = pending.subarray(0, need);
        pending = pending.subarray(need);
        const i = n;
        n += 1;
        if (i === 0) onFirst?.(Date.now() - t0);
        onFrame?.({ i, t: i / fps, buf });
      }
      if (pending.length === 0) pending = null;
    });
    child.stderr.on('data', (d) => {
      err = `${err}${d}`.slice(-4000);
      onStderr?.(String(d));
    });
    child.on('error', (e) => {
      e.errorInfo = captureErrorInfo(e, 'spawn');
      reject(e);
    });
    child.on('close', (code, signal) => {
      // `code === null` = 被我们自己 SIGKILL 的（stop / 换清晰度 / 收工）。
      // 那是正常收尾，不是失败 —— 否则每次 stop 都往 lastError 里写一条假错误。
      if (!stopped && code !== 0 && code !== null) {
        const error = new Error(`ffmpeg exit ${code}: ${err.trim().slice(-300) || '无 stderr'}`);
        error.code = code;
        error.signal = signal ?? null;
        error.stderrTail = err.trim().slice(-1000) || null;
        error.errorInfo = captureErrorInfo(error, 'exit');
        reject(error);
        return;
      }
      resolve({ frames: n, ms: Date.now() - t0, code });
    });
  });

  return {
    done,
    stop() {
      stopped = true;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
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
let cachedEngineKey = null;
let cachedFormat = null;            // macOS 屏幕像素格式：'' = 用设备默认
let screenWarning = null;

export function resetScreenEngineCache() {
  cachedEngine = null;
  cachedEngineKey = null;
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
  ffmpegPath = 'ffmpeg', fps = 12, timeoutMs = 2500, platform = process.platform, spawnProcess = spawn,
  device = DEFAULT_SCREEN_DEVICE,
} = {}) {
  const key = `${platform}:${ffmpegPath}:${device}`;
  if (cachedEngine && cachedEngineKey === key) return Promise.resolve(cachedEngine);
  if (platform === 'darwin') {
    return probeAvfoundation({ ffmpegPath, fps, timeoutMs, device, spawnProcess }).then((engine) => {
      cachedEngineKey = key;
      return engine;
    });
  }
  if (platform !== 'win32') {
    return Promise.reject(new RangeError(
      `屏幕采集还没接 ${platform}：Windows 走 ddagrab/gdigrab，macOS 走 avfoundation，Linux 需要 x11grab 或 PipeWire，还没做。`,
    ));
  }
  return probeDdagrab({ ffmpegPath, fps, timeoutMs, spawnProcess }).then((engine) => {
    cachedEngineKey = key;
    return engine;
  });
}

/** macOS：探一次 avfoundation —— 一次回答三个问题。
 *
 * ① 能不能出帧（ffmpeg 在不在、设备名对不对）；
 * ② **哪个像素格式设备真收**（默认的 yuv420p 屏幕输入不支持，必须自己试）；
 * ③ 画面是不是全黑（= 系统没给「屏幕录制」权限，ffmpeg 自己不会报）。
 *
 * 顺序是**按实测 CPU 从省到费**排的（本机 12fps→800×450：nv12 0.14 核 ≈ uyvy422 0.15 ≈
 * 设备默认 0.14，bgr0 0.23）。格式不对时 ffmpeg 会很快报错退出，所以串行试不会拖慢。
 */
async function probeAvfoundation({ ffmpegPath, fps, timeoutMs, device = DEFAULT_SCREEN_DEVICE, spawnProcess = spawn }) {
  const W = 64;                      // 探针只取 1 帧，尺寸越小越快
  const H = 36;
  const formats = ['nv12', 'uyvy422', 'bgr0', null];
  const deadline = Date.now() + timeoutMs;
  for (const pf of formats) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const shot = await grabOneFrame({ ffmpegPath, fps, width: W, height: H, pixelFormat: pf, timeoutMs: remaining, device, spawnProcess });
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

/** 单帧探针。拿到满一帧发送 SIGKILL 并等待子进程 close 后 resolve，避免孤儿进程。 */
function grabOneFrame({ ffmpegPath, fps, width, height, pixelFormat, timeoutMs, device = DEFAULT_SCREEN_DEVICE, spawnProcess = spawn }) {
  const args = captureArgs({
    source: { kind: 'screen', device, engine: 'avfoundation', pixelFormat: pixelFormat ?? '' },
    width, height, fps, ffmpegPath, engine: 'avfoundation', platform: 'darwin',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');
  const need = width * height * 3;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ got: false, buf: Buffer.alloc(0) });
      return;
    }
    let buf = Buffer.alloc(0);
    let timer = null;
    let killed = false;

    const killChild = () => {
      if (killed) return;
      killed = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    };

    timer = setTimeout(killChild, timeoutMs);

    child.stdout?.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= need) killChild();
    });
    child.on('error', () => { killChild(); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ got: buf.length >= need, buf: buf.subarray(0, need) });
    });
  });
}

/** Windows：探 ddagrab，不行退 gdigrab。 */
function probeDdagrab({ ffmpegPath, fps, timeoutMs, spawnProcess = spawn }) {
  const W = 64;
  const H = 36;                     // 探针只取 1 帧，尺寸越小越快
  const args = captureArgs({
    source: { kind: 'screen', engine: 'ddagrab' }, width: W, height: H, fps, ffmpegPath, engine: 'ddagrab', platform: 'win32',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('gdigrab');
      return;
    }
    let got = 0;
    let result = null;
    let timer = null;

    const finish = (engine) => {
      if (result) return;
      result = engine;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    };

    timer = setTimeout(() => finish('gdigrab'), timeoutMs);

    child.stdout?.on('data', (d) => {
      got += d.length;
      if (got >= W * H * 3) finish('ddagrab');
    });
    child.on('error', () => finish('gdigrab'));
    child.on('close', () => {
      clearTimeout(timer);
      const chosen = result ?? (got >= W * H * 3 ? 'ddagrab' : 'gdigrab');
      cachedEngine = chosen;
      resolve(chosen);
    });
  });
}
