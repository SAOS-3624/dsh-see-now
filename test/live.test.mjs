/**
 * live.test.mjs — 实时管线的三条不变量。
 *
 * 这三个数一旦变，线上表现会直接坏掉，而且坏得不显眼（图还是出得来）：
 *   ① 一镜到底不能出假切点
 *   ② 3 个 1 档帧要排成 L 形（75%），不是被拆成两张各 50%
 *   ③ 插话必须带上「此刻那一帧」
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createTiers } from '../src/tiers.js';
import { solve } from '../src/pack.js';
import { coverInto } from '../src/scale.js';
import { createPipeline } from '../src/pipeline.js';
import {
  checkRegion, listDevices, captureErrorInfo, pickScreenEngine,
  resetScreenEngineCache, screenEngineWarning, sourceArgs, captureArgs,
} from '../src/capture.js';

const W = 160;
const H = 90;

/** 造一帧：底色 + 一个随 f 移动的方块（模拟"画面在动但没换镜头"） */
function frame(scene, f, { shift = 1 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  const [r, g, b] = scene;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  const bx = (f * shift) % (W - 20);
  for (let y = 10; y < 30; y += 1) {
    for (let x = bx; x < bx + 20; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 250;
      buf[i + 1] = 250;
      buf[i + 2] = 250;
    }
  }
  return buf;
}

test('一镜到底：缓慢运动不出切点', () => {
  const p = createPipeline({ width: W, height: H, fps: 12 });
  for (let f = 0; f < 120; f += 1) p.push({ t: f / 12, buf: frame([40, 60, 80], f, { shift: 2 }) });
  p.finish();
  assert.equal(p.stats.cuts, 0, `假切点 ${p.stats.cuts} 个`);
});

test('硬切：换场只认一刀，且只认孤立尖峰', () => {
  const p = createPipeline({ width: W, height: H, fps: 12 });
  for (let f = 0; f < 120; f += 1) {
    const scene = f < 60 ? [30, 120, 60] : [200, 40, 40];
    p.push({ t: f / 12, buf: frame(scene, f) });
  }
  p.finish();
  assert.equal(p.stats.cuts, 1, `切点数 ${p.stats.cuts}`);
  const cut = p.log.find((k) => k.via === 'cut');
  assert.ok(cut.t >= 4.9 && cut.t <= 5.1, `刀抬在了 ${cut.t}s`);
});

test('排布：3 个 1 档帧是一张 75% 的 L 形，不是两张各 50%', () => {
  const three = solve([1, 1, 1], { binCost: 1000 });
  assert.equal(three.bins, 1);
  assert.ok(Math.abs(three.area - 0.75) < 1e-6, `area=${three.area}`);

  const four = solve([1, 1, 1, 1], { binCost: 1000 });
  assert.equal(four.bins, 1);
  assert.ok(Math.abs(four.area - 1) < 1e-6);

  const five = solve([1, 1, 1, 1, 1], { binCost: 1000 });
  assert.equal(five.bins, 2);
});

test('档位：连续留帧会升档，安静下来会降回去', () => {
  const t = createTiers({ fps: 12, dtFrames: 12, smoothFrames: 6 });
  for (let f = 0; f <= 48; f += 1) t.tick(f / 12);
  assert.equal(t.levelAt(), 1, '一开始没有边界，应该是 1 档');

  for (let f = 0; f <= 36; f += 6) t.mark(f / 12);      // 每秒 2 帧
  for (let f = 0; f <= 120; f += 1) t.tick(4 + f / 12);  // 再空转 10 秒
  assert.ok(t.levelAt() <= 2, `安静 10 秒后还停在 ${t.levelAt()} 档`);
});

test('缩放：cover 不改比例，取中间那块', () => {
  const src = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      src[i] = x < W / 2 ? 10 : 200;      // 左暗右亮，缩小时不会混成一个值
      src[i + 1] = 50;
      src[i + 2] = 50;
    }
  }
  const dst = Buffer.alloc(80 * 45 * 3);
  coverInto(src, W, H, dst, 80, 45);
  assert.ok(dst[0] < 60, `左边缘应该是暗的，实际 ${dst[0]}`);
  const right = (44 * 80 + 79) * 3;
  assert.ok(dst[right] > 150, `右边缘应该是亮的，实际 ${dst[right]}`);
});

test('插话：截断出来的图里必须有「此刻那一帧」', () => {
  const p = createPipeline({ width: W, height: H, fps: 12 });
  for (let f = 0; f < 60; f += 1) p.push({ t: f / 12, buf: frame([40, 60, 80], f, { shift: 2 }) });
  const s = p.flushNow(5);
  assert.ok(s, '应该出图');
  // 插话发生在 5.0s，但**此刻**能拿到的最新像素是 4.917s（最后一帧解出来的）——
  // 相差不能超过一帧，否则就是"给了几秒前的画面"
  assert.ok(s.to > 4.9, `最后一张是 ${s.to}s，太旧了`);
  assert.ok(s.frames.length >= 1);
});

test('采集参数：屏幕走 ddagrab 时没有 -framerate，也不挂多余的 -r', async () => {
  // 这些断言全是 **Windows** 的引擎行为，必须显式写 platform ——
  // 否则在 macOS 上跑测试时会走 avfoundation 分支，测的根本不是同一件事。
  const W = { platform: 'win32' };
  const { captureArgs, sourceArgs } = await import('../src/capture.js');
  const dda = captureArgs({ source: { kind: 'screen' }, width: 800, height: 450, fps: 12, engine: 'ddagrab', ...W });
  assert.ok(dda.join(' ').includes('ddagrab=framerate=12'), 'ddagrab 的帧率是滤镜参数');
  assert.ok(dda.join(' ').includes('hwdownload'), 'GPU 帧要先拿下来');
  assert.ok(!dda.includes('-r'), '屏幕源已经按 fps 抓了，再挂 -r 是白跑一趟');

  const gdi = captureArgs({ source: { kind: 'screen' }, width: 800, height: 450, fps: 12, engine: 'gdigrab', ...W });
  assert.ok(gdi.join(' ').includes('-f gdigrab'), 'gdigrab 要显式指定');
  assert.ok(gdi.join(' ').includes('-framerate 12'), 'gdigrab 的帧率是设备侧参数');

  const region = sourceArgs(
    { kind: 'screen', region: { x: 100, y: 50, w: 1280, h: 720 } }, { engine: 'gdigrab', fps: 12, ...W },
  ).join(' ');
  assert.ok(region.includes('-offset_x 100') && region.includes('-video_size 1280x720'));
});

test('采集参数：macOS 屏幕走 avfoundation，且必须挂 -r 压速', async () => {
  const M = { platform: 'darwin' };
  const { captureArgs } = await import('../src/capture.js');
  const mac = captureArgs({ source: { kind: 'screen' }, width: 800, height: 450, fps: 12, ...M });
  const line = mac.join(' ');
  assert.ok(line.includes('-f avfoundation'), 'macOS 只有 avfoundation');
  assert.ok(line.includes('-framerate 12'), '设备侧采样率');
  assert.ok(line.includes('Capture screen 0:none'), '屏幕设备名 + 音频 none，避免开麦克风');
  assert.ok(line.includes('-capture_cursor 0'), '光标必须显式关');
  // 这一条是拿 240GB 换来的：avfoundation 屏幕源不认 -framerate 当节流阀，
  // 缺了 -r 就是 ~40fps 往管道里灌。
  assert.ok(line.includes('-r 12'), 'macOS 屏幕源必须靠输出侧 -r 压回 12fps');
  assert.ok(!line.includes('hwdownload'), 'avfoundation 的帧在内存里，没有 hwdownload 这一步');
  assert.ok(!line.includes('dshow'), 'macOS 上没有 dshow');

  const cam = captureArgs({ source: { kind: 'camera', device: '0' }, width: 800, height: 450, fps: 12, ...M }).join(' ');
  assert.ok(cam.includes('-f avfoundation') && cam.includes('0:none'), '摄像头同样走 avfoundation');

  const region = captureArgs({
    source: { kind: 'screen', region: { x: 100, y: 50, w: 1280, h: 720 } }, width: 800, height: 450, fps: 12, ...M,
  }).join(' ');
  assert.ok(region.includes('crop=1280:720:100:50'), 'avfoundation 没有 -video_size，裁剪走滤镜');
});

test('采集参数：其它平台明确报错，不假装能用', async () => {
  const { pickScreenEngine, resetScreenEngineCache } = await import('../src/capture.js');
  resetScreenEngineCache();
  await assert.rejects(
    pickScreenEngine({ platform: 'linux', ffmpegPath: 'true' }),
    /屏幕采集还没接 linux/,
  );
});


test('采集参数：设备源走 dshow，保留 -r 和 rtbufsize', async () => {
  const { captureArgs } = await import('../src/capture.js');
  const cam = captureArgs({ source: { kind: 'camera' }, width: 800, height: 450, fps: 12, platform: 'win32' }).join(' ');
  assert.ok(cam.includes('-f dshow'), 'dshow');
  assert.ok(cam.includes('video=HD Webcam'), '默认设备名');
  assert.ok(cam.includes('-r 12'), '设备帧率不是 12，要重采样');
  assert.ok(cam.includes('-rtbufsize'), '直播设备必须给缓冲');
  assert.ok(!cam.includes('-framerate'), 'dshow 不能加 -framerate，会 I/O error');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.kills = (child.kills ?? 0) + 1;
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  return child;
}

test('checkRegion：校验物理像素整数坐标，非负规则分引擎处理', () => {
  assert.doesNotThrow(() => checkRegion({ x: 0, y: 0, w: 1920, h: 1080 }));
  assert.doesNotThrow(() => checkRegion(null));
  assert.doesNotThrow(() => checkRegion(undefined));

  assert.throws(() => checkRegion({ x: 10.5, y: 0, w: 100, h: 100 }), /RangeError.*region 必须使用物理像素整数坐标/);
  assert.throws(() => checkRegion({ x: 0, y: 0, w: 0, h: 100 }), /RangeError/);
  assert.throws(() => checkRegion({ x: 0, y: 0, w: 100, h: -50 }), /RangeError/);

  assert.throws(() => checkRegion({ x: -10, y: 0, w: 100, h: 100 }), /RangeError/);
  assert.throws(() => checkRegion({ x: 0, y: -20, w: 100, h: 100 }), /RangeError/);

  assert.doesNotThrow(() => checkRegion({ x: -1920, y: 0, w: 1920, h: 1080 }, { allowNegative: true }));
  assert.doesNotThrow(() => checkRegion({ x: 0, y: -1080, w: 1920, h: 1080 }, { allowNegative: true }));

  assert.throws(() => sourceArgs({ kind: 'screen', region: { x: -5, y: 0, w: 100, h: 100 } }, { platform: 'darwin' }), /RangeError/);
  assert.throws(() => sourceArgs({ kind: 'screen', region: { x: 0, y: 0, w: 0, h: 100 } }, { platform: 'win32', engine: 'ddagrab' }), /RangeError/);
});

test('listDevices：解析 macOS avfoundation 与 Windows dshow 输出，带超时和异常防护', async () => {
  const macChild = fakeChild();
  const macPromise = listDevices({
    platform: 'darwin',
    ffmpegPath: 'ffmpeg',
    spawnProcess: () => macChild,
  });
  macChild.stderr.write(
    '[AVFoundation indev @ 0x123] AVFoundation video devices:\n' +
    '[AVFoundation indev @ 0x123] [0] FaceTime HD Camera\n' +
    '[AVFoundation indev @ 0x123] [1] Capture screen 0\n' +
    '[AVFoundation indev @ 0x123] AVFoundation audio devices:\n' +
    '[AVFoundation indev @ 0x123] [0] Built-in Microphone\n'
  );
  macChild.emit('close', 1);
  const macRes = await macPromise;
  assert.equal(macRes.platform, 'darwin');
  assert.deepEqual(macRes.devices, [
    { index: 0, name: 'FaceTime HD Camera', kind: 'camera' },
    { index: 1, name: 'Capture screen 0', kind: 'screen' },
    { index: 0, name: 'Built-in Microphone', kind: 'audio' },
  ]);

  const winChild = fakeChild();
  const winPromise = listDevices({
    platform: 'win32',
    ffmpegPath: 'ffmpeg.exe',
    spawnProcess: () => winChild,
  });
  winChild.stderr.write(
    '[dshow @ 0x123] DirectShow video devices\n' +
    '[dshow @ 0x123]  "Integrated Webcam" (video)\n' +
    '[dshow @ 0x123] DirectShow audio devices\n' +
    '[dshow @ 0x123]  "Microphone Array" (audio)\n'
  );
  winChild.emit('close', 1);
  const winRes = await winPromise;
  assert.equal(winRes.platform, 'win32');
  assert.deepEqual(winRes.devices, [
    { index: 0, name: 'Integrated Webcam', kind: 'camera' },
    { index: 0, name: 'Microphone Array', kind: 'audio' },
  ]);

  await assert.rejects(listDevices({ platform: 'linux' }), /RangeError.*linux 暂无设备枚举实现/);

  const emptyChild = fakeChild();
  const emptyPromise = listDevices({
    platform: 'darwin',
    spawnProcess: () => emptyChild,
  });
  emptyChild.emit('close', 1);
  await assert.rejects(emptyPromise, /FFmpeg 未返回设备/);

  const timeoutChild = fakeChild();
  const timeoutPromise = listDevices({
    platform: 'darwin',
    timeoutMs: 10,
    spawnProcess: () => timeoutChild,
  });
  await assert.rejects(timeoutPromise, /设备枚举超过 10ms/);
  assert.ok(timeoutChild.kills >= 1, '超时必须 kill 子进程');
});

test('captureErrorInfo：依据明确证据将异常分类，保留底层 stage、code 与 stderrTail', () => {
  const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  const c1 = captureErrorInfo(enoent, 'spawn');
  assert.equal(c1.category, 'dependency-missing');
  assert.equal(c1.stage, 'spawn');
  assert.equal(c1.code, 'ENOENT');

  const range = new RangeError('region 必须使用物理像素整数坐标');
  const c2 = captureErrorInfo(range, 'validate');
  assert.equal(c2.category, 'invalid-input');

  const perm = Object.assign(new Error('AVFoundation: permission denied'), { stderrTail: 'permission denied' });
  const c3 = captureErrorInfo(perm, 'exit');
  assert.equal(c3.category, 'permission-denied');
  assert.equal(c3.stderrTail, 'permission denied');

  const devErr = new Error('video device not available: Could not find video device');
  const c4 = captureErrorInfo(devErr);
  assert.equal(c4.category, 'device-unavailable');

  const generic = new Error('ffmpeg exit 1: unknown error');
  const c5 = captureErrorInfo(generic);
  assert.equal(c5.category, 'capture-failed');

  assert.equal(captureErrorInfo({ errorInfo: c1 }), c1);
});

test('pickScreenEngine：探针总超时控制、子进程关闭等待、缓存与黑屏预警', async () => {
  resetScreenEngineCache();

  const triedFormats = [];
  const macSpawn = (cmd, args) => {
    const child = fakeChild();
    const pfIdx = args.indexOf('-pixel_format');
    const pf = pfIdx !== -1 ? args[pfIdx + 1] : null;
    triedFormats.push(pf);
    queueMicrotask(() => {
      if (pf === 'nv12') {
        child.emit('close', 1);
      } else {
        child.stdout.write(Buffer.alloc(64 * 36 * 3, 128));
      }
    });
    return child;
  };

  const eng1 = await pickScreenEngine({
    platform: 'darwin',
    ffmpegPath: 'ffmpeg',
    spawnProcess: macSpawn,
  });
  assert.equal(eng1, 'avfoundation');
  assert.deepEqual(triedFormats, ['nv12', 'uyvy422']);
  assert.equal(screenEngineWarning(), null, '有效像素不应报警');

  const beforeCount = triedFormats.length;
  const engCached = await pickScreenEngine({
    platform: 'darwin',
    ffmpegPath: 'ffmpeg',
    spawnProcess: () => { throw new Error('不应再次调用 spawn'); },
  });
  assert.equal(engCached, 'avfoundation');
  assert.equal(triedFormats.length, beforeCount);

  resetScreenEngineCache();
  const blackSpawn = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.write(Buffer.alloc(64 * 36 * 3, 0));
    });
    return child;
  };
  await pickScreenEngine({
    platform: 'darwin',
    ffmpegPath: 'ffmpeg',
    spawnProcess: blackSpawn,
  });
  assert.match(screenEngineWarning(), /没有「屏幕录制」权限/);

  resetScreenEngineCache();
  const winSpawn = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.write(Buffer.alloc(64 * 36 * 3, 200));
    });
    return child;
  };
  const winEng = await pickScreenEngine({
    platform: 'win32',
    ffmpegPath: 'ffmpeg.exe',
    spawnProcess: winSpawn,
  });
  assert.equal(winEng, 'ddagrab');

  resetScreenEngineCache();
});
