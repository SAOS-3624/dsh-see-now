/**
 * index.js — 插件入口。只做三件事：注册工具、路由 action、把图交成附件。
 *
 * **唯一的取图方式是 `watch`**：它阻塞到「攒够一张」或超时，然后把图作为**工具返回值**
 * 交给宿主。不要用 `sessionController.prompt` 往会话里推 —— 那样模型看到图又去调工具、
 * 自己唤醒自己，停不下来（0.0.1 就是死在这儿）。
 */

import { createRunner, SCENE_OPTS, PACES, DEFAULT_PACE } from './runner.js';
import { resolveFfmpeg } from './binaries.js';
import { parseRegion } from './layout.js';
import { seeNowToolSpec, TOOL_TIMEOUT_MS, DEFAULT_BLOCK_SEC, TOOL_NAME } from './tool-spec.js';
import { interjectNote, replyReminder, clearInterjected } from './interject.js';
import { appendSpoken, appendChat, lastSaidNote, lastSaidText, chatDir } from './chat.js';
import { ensureConfiguredVoice, detachAdapters, attachedAdapters, configuredVoiceAdapter, lastVoiceError } from './voice.js';
import { speechSubscribers, onSpeech } from './speech.js';
import { markSpeaking } from './listen.js';
import { startLoop, HANGUP_NOTE } from './loop.js';
import { readTuning } from './tuning.js';
import { windowAlive, windowHidden, setWindowHidden, windowReport, windowLine } from './window.js';
import { pickRegion, loadRegion, clearRegion, regionText } from './region.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** ESM 里拿到同步 require（`node:sqlite` 只有同步 API，动态 import 是异步的）。 */
const nodeRequire = createRequire(import.meta.url);

/**
 * 从工具参数构造 source 描述。`watch` 和 `start` 两个入口共用。
 *
 * `region` 是 `source:"screen"` 的**修饰参数**，不是独立 kind：
 *   - 它同时把 engine 钉死在 `gdigrab` —— `ddagrab` 是 filter source，没有
 *     `-offset_x`/`-video_size`，带 region 给它会把偏移**静默丢掉**（抓到整屏，
 *     用户和模型都以为生效了，这是最坏的一种失败）；
 *   - 格式不对时**明确返回错误**，同样不静默退化成全屏。
 *
 * @returns {{src: object|null, error?: string}}
 */
function srcOf(args) {
  const kind = args.source ? String(args.source).toLowerCase() : null;
  const src = kind ? { kind } : null;
  if (src && kind === 'file') {
    src.path = args.path;
    src.realtime = args.realtime === true;
  }
  const rawRegion = args.region;
  if (rawRegion === undefined || rawRegion === null || rawRegion === '') return { src };
  if (src && kind !== 'screen') {
    return { src: null, error: `region 只能配 source:"screen"，现在是 "${kind}"。` };
  }
  const region = parseRegion(rawRegion);
  if (!region) {
    return {
      src: null,
      error: `region 格式不对：「${String(rawRegion)}」。要 "x,y,w,h" 四个整数（屏幕物理像素，`
        + '和 desktop_control 的 window rect 同一套坐标），例如 "1593,375,568,1010"。'
        + '\n没有按全屏抓 —— 那会让你以为 region 生效了。',
    };
  }
  const out = src ?? { kind: 'screen' };
  out.region = region;
  out.engine = 'gdigrab';
  return { src: out };
}

export const name = 'dsh-see-now';

/**
 * `watch` 最多阻塞多久。
 *
 * **必须比宿主的 timeoutMs 早收工**：工具自己挂得比宿主的死线还久，到点就不是
 * "返回一张图"，而是整条调用被 abort（`signal` 一起 abort，模型看到的是超时错误）。
 * 留 40 秒给建图/交附件/模型想一想。
 */
const MAX_BLOCK_SEC = Math.max(30, Math.floor(TOOL_TIMEOUT_MS / 1000) - 40);

/** 版本号：从 package.json 读，只为日志里能分清"跑的是哪一版"。读不到就 `?`。 */
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; }
})();

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
  throw new Error('cannot resolve @deepseek-ai/dsh-tools (set DSH_TOOLS_PATH for local dev)');
}

/**
 * 台词清单。**只在真有台词时出现** —— 转写没开/没听见的时候，凭空来一行
 * "台词："只会让模型以为转写坏了，然后去猜。
 *
 * 两个时间都给：
 *  - **本机时钟**（`15:57:32`）：用户回头找"那句话是什么时候说的"只能靠它 ——
 *    实时看屏幕没有"视频进度"这个东西，浏览器放第几秒我们根本不知道；
 *  - **相对秒**（`9.3s`）：和上面每帧那个 `24.1s` 是同一个坐标系，模型才能把
 *    "这句话"对到"第几格画面"。
 */
/**
 * DSH 认证 cookie 的"拥挤度"（实际还活着的条数）。
 *
 * 宿主每次登录都会在 127.0.0.1 上签一个 **新的** `dsh-auth-<随机串>` cookie，旧的从不清理。
 * 攒到 70 条左右，`Cookie` 头就超过 16KB，**下次启动在认证那一步直接挂**
 * （`desktop welcome: Web authentication failed`，`phase: startup`）——
 * 那时候任何插件都跑不起来，也就没法自救。所以只能趁还能跑的时候提醒。
 *
 * 用宿主内置的 `node:sqlite` 精确数。**不用"扫文件里的字符串"**：sqlite 删行不擦页，
 * 清理完之后残留还在——实测清到 1 条，按字符串数能数出 95 条，纯误报。
 *
 * @param {string|null} file 覆盖路径（测试用）
 * @returns {number|null} 条数；读不到（mac / 没装 / 没权限 / 没有 sqlite）返回 null
 */
export function authCookiePressure(file = null) {
  try {
    const p = file || join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
    // 动态 require：`node:sqlite` 在某些 Node 版本里还是 experimental，
    // 静态 import 会在没有它的运行时直接让整个插件加载失败 —— 一个体检功能不值这个。
    const { DatabaseSync } = nodeRequire('node:sqlite');
    const db = new DatabaseSync(p, { readOnly: true });
    try {
      const row = db.prepare("select count(*) as c from cookies where name like 'dsh-auth-%'").get();
      return Number(row?.c ?? 0);
    } finally { db.close(); }
  } catch { return null; }
}

/**
 * 台词清单。**只在真有台词时出现** —— 转写没开/没听见的时候，凭空来一行
 * "台词："只会让模型以为转写坏了，然后去猜。
 *
 * 三个信息叠在一行：
 *  - **`#2`**：这句话最接近第几格画面。模型不用自己拿时间码去对格子，
 *    一眼就知道"这句配那张图"；
 *  - **本机时钟**（`15:57:32`）：用户回头找"那句话是几点说的"只能靠它 ——
 *    实时看屏幕没有"视频进度"这个东西，浏览器放到第几秒我们根本不知道；
 *  - **相对秒**（`9.3s`）：和每帧那个 `24.1s` 同一坐标系，可交叉验证。
 */
export function linesText(sheet) {
  const got = sheet.lines;
  if (!got?.length) return '';
  const frames = sheet.frames ?? [];
  const f0 = frames[0];
  // frame.wall 是 epoch ms、frame.t 是相对秒 → 两者相减就是"t=0 那一刻的 epoch"
  const origin = f0?.wall != null ? f0.wall - f0.t * 1000 : null;

  /** 这句话落在哪一格：最后一个 `t <= 本句起点` 的帧（比首帧还早的归第 1 格）。 */
  const cellFor = (tRel) => {
    if (!frames.length) return null;
    let idx = 0;
    for (let i = 0; i < frames.length; i += 1) if (frames[i].t <= tRel + 1e-6) idx = i;
    return idx + 1;
  };

  const rows = got.map((l) => {
    const tRel = origin === null ? null : (l.t0 - origin) / 1000;
    const rel = tRel === null ? null : `${tRel.toFixed(1)}s`;
    let clock = null;
    try { clock = new Date(l.t0).toLocaleTimeString('zh-CN', { hour12: false }); } catch { /* 时区数据缺失 */ }
    const stamp = [clock, rel].filter(Boolean).join(' / ');
    const cell = tRel === null ? null : cellFor(tRel);
    // `partial` = 长句说到一半先给的临时版（还没断句）。标出来，模型才不会当成定论。
    const tail = l.partial ? '（还在说…）' : '';
    return `  ${cell === null ? '' : `#${cell}  `}${stamp || '—'}  ${l.text}${tail}`;
  });
  return `\n台词（这段时间里视频里在说的，机器转写，可能有错字/听岔；`
    + '`#n` = 这句最接近第 n 格画面，后面是本机时钟 / 相对这张图起点的秒数；'
    + '带「还在说…」的是说了一半的临时版）：\n'
    + rows.join('\n');
}

/**
 * 循环状态那一行。三种态要分清，别都写成"在跑"：
 *   - `listen`：采集停了，但窗口里的输入还收得到（用户打字仍然能叫醒模型）
 *   - `active`：正常在跑
 *   - 已停 / 没起
 *
 * **必须在模块顶层**：它原来写在 `route()` 里面（靠函数提升才没报错），
 * 于是每次工具调用都要重新创建三个闭包，而且缩进是 0 —— 读代码的人会以为它在外面。
 */
function loopLine(lp) {
  if (!lp) return '没起（还没调过 watch）';
  if (lp.mode === 'listen') return '只听（采集已停，窗口里的输入还收得到；要看就调 peek）';
  if (lp.stopped) return lp.reason ? `已停（${lp.reason}）` : '已停';
  const fail = lp.wakeFailures ? `，失败 ${lp.wakeFailures} 次` : '';
  const last = lp.lastWakeAt
    ? `，上一次 ${Math.round((Date.now() - lp.lastWakeAt) / 1000)}s 前${lp.lastWakeOk === false ? '（失败）' : ''}`
    : '';
  // 节奏诊断：上一句多长、下一轮最早什么时候 —— 用户问"怎么半天不说话"时先看这两个数
  const speech = lp.lastSpeechMs ? `，上一句约 ${(lp.lastSpeechMs / 1000).toFixed(1)}s` : '';
  const wait = lp.nextWakeAt && lp.nextWakeAt > Date.now()
    ? `，下一轮最早 ${Math.ceil((lp.nextWakeAt - Date.now()) / 1000)}s 后` : '';
  return `在跑（叫醒 ${lp.wakes} 次${fail}${last}${speech}${wait}，会话 ${lp.session ?? '未知'}）`;
}

/** 快到临界才提醒 —— 超了之后插件根本跑不起来，只能趁现在说。 */
function cookieWarnLine() {
  const n = authCookiePressure();
  if (n === null || n < 50) return '';
  return `\n⚠ DSH 认证 cookie 已约 ${n} 条：攒到 70 条左右宿主会起不来`
    + '（`Web authentication failed`，跟插件无关）。关掉 DSH 后跑 `tools/fix-dsh-startup.cmd` 清一下。';
}

/**
 * 「听声音」一行。
 *
 * 用户说"它好像没听见台词"时，答案全在这一行：是没转写服务、没 Python 包、
 * 还是这台机器根本抓不到回环。**不要把未启用写成"正常"** —— 那会让人一直查画面。
 */
function listenLine(l) {
  if (!l) return '没起（还没调过 watch）';
  if (!l.enabled) return `没在听 —— ${l.reason}`;
  // **转写挂了不能说成"在听"**：那会让人一直去查画面。
  // 2026-11-04 社区实报：本地 ASR 服务没起，界面上一直显示"在听、0 句"，
  // 看起来和"视频是默片"一模一样。
  if (l.paused) return `在听但转写停了：${l.error ?? '原因未知'}（30 秒后自动重试，音量条还在）`;
  if (l.error) return `在听（${l.backend}），但最近一次转写失败：${l.error}`;
  const last = l.lastSegAt ? `，最近一句 ${Math.round((Date.now() - l.lastSegAt) / 1000)}s 前` : '，还没转出过台词';
  // 延迟诊断：从"这句话开口"到"进了台词缓冲"用了多久。调快慢就看这一个数。
  const lag = l.lastLineLagMs != null ? `，上一句开口→可读 ${(l.lastLineLagMs / 1000).toFixed(1)}s` : '';
  const part = l.partials ? `，临时字幕 ${l.partials} 次` : '';
  return `在听（${l.backend}，累计 ${l.total} 句${last}${lag}${part}）`;
}

/** 一张图 → 模型看得懂的清单。数字都是「这张图里第几格」，不是抽象指标。 */
function sheetText(sheet, { waited = 0, partial = false, userText = null, say = null, looping = false } = {}) {
  const { frames, from, to, why } = sheet;
  // 单帧时首尾相等，写成区间会变成"过去 24.1–24.1 秒"，读起来像出错了
  const span = frames.length === 1
    ? `此刻（第 ${frames[0].t.toFixed(1)} 秒）的 1 个画面`
    : `过去 ${from.toFixed(1)}–${to.toFixed(1)} 秒的 ${frames.length} 个画面`;
  const head = `${span} · ${sheet.w}×${sheet.h}`
    + `${partial ? '，还没攒满就截断了' : ''}`
    + `${waited ? ` · 等了 ${waited.toFixed(0)}s` : ''}`;
  const lines = frames.map((f, i) => {
    const cell = sheet.cells?.[i];
    const size = cell ? `${cell.pw}×${cell.ph}` : '—';
    // 档位要报**两件事**：算法给的档位，和它实际占多少画布。
    // 两者不一致是因为排布器为了把这一批塞进一张图，把格子压小了 —— 只报档位会让
    // 人以为"1 档 = 整幅"，而实际是 400×225（踩过：用户看到"1 档"配 400×225 以为算错了）。
    const k = cell ? Math.max(1, Math.round(sheet.w / Math.max(1, cell.pw))) : null;
    const tierText = k && k !== f.tier ? `${f.tier}档→1/${k}` : `${f.tier} 档`;
    return `  ${i + 1}. ${f.t.toFixed(1)}s · ${size} · ${f.via} · ${tierText}`;
  });
  const whyText = why === 'user' ? '用户插话截断的'
    : why === 'timeout' ? '等满了先给你'
      : why === 'time' ? '攒到这个点先给你'
        : why === 'full' ? '这张装满了'
          : why === 'first' ? '刚打开，先给你此刻'
            : why === 'oneshot' ? '换了清晰度，先给你此刻'
              : '流结束';
  const ask = userText
    ? `\n${interjectNote(userText, { at: Date.now() })}`
    : '';
  // 常驻模式要**明说**，否则模型会以为"还得我自己再调一次"，或者以为"看一眼就完事了"
  const loopNote = looping
    ? '\n**已经进入常驻模式**：下一张攒够我会再叫你，不用你现在就调下一次。'
      + '你现在只要做一件事 —— 值得说就用 `say` 说一句，不值得说就别出声。'
      + '用户关掉悬浮窗我就停。'
    : '';
  return `${head}\n${lines.join('\n')}${linesText(sheet)}${ask}${lastSaidNote()}${loopNote}\n（${whyText}；想看下一段就再调一次 \`see_now({action:"watch"})\`。）${replyReminder({ answered: Boolean(say) })}`;
}

/**
 * 提交成宿主附件，并组装工具返回值。
 *
 * **`saveImage` 必须 `.call(svc, …)`**：它内部读 `this.compression`，方法取下来裸调会丢 this，
 * 报 `Cannot read properties of undefined (reading 'compression')` —— 所有出图工具一起挂。
 */
async function attachAndReturn(ctx, sheet, extra = {}) {
  const svc = serviceOf(ctx, 'attachments');
  if (!svc?.saveImage) {
    return { text: '拿到图了，但宿主没有 attachments 服务，交不上去。', meta: { ok: false, ...extra } };
  }
  const ref = await svc.saveImage.call(svc, {
    data: sheet.png,
    mediaType: 'image/png',
    name: `see-now-${Date.now()}.png`,
  });
  // `say` 是给清单用的，不进 meta —— 那是整段话，塞进 meta 只会让返回值翻倍
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

/** 当前声音状态（status 用）。**听不到声音时第一个要看的就是它。** */
function voiceState() {
  const configured = configuredVoiceAdapter();
  let speakers = 0;
  try { speakers = speechSubscribers(); } catch { /* 总线还没建起来 */ }
  return {
    configured: configured ?? null,
    adapters: attachedAdapters(),
    speakers,
    // 配了但没挂上：把最后一次失败原因带出来，否则只能猜"是不是没重启"
    reason: speakers > 0 ? null : (lastVoiceError() ?? null),
  };
}

export async function apply(ctx) {
  try {
    return await registerAll(ctx);
  } catch (e) {
    // 最坏的情况是插件不能用，不是应用起不来
    try { ctx?.logger?.error?.(`[dsh-see-now] failed to load: ${e?.stack ?? e}`); } catch { /* ignore */ }
    /**
     * **失败必须留痕。** 以前只打 logger.error —— 那玩意儿只在开发者工具里，
     * 用户看到的现象是"这个会话根本没有 see_now 这个工具"，模型只能靠读文件猜，
     * 还把猜出来的调用当正文吐出来（2026-11-03 实报）。
     * 现在写到 `~/.dsh/see-now/plugin-error.log`，出问题直接看这个文件。
     */
    writeLoadError(e);
    if (process.env.DSH_SEE_DEBUG) throw e;
    return () => {};
  }
}

/** 加载失败落盘（追加，超过 64KB 就重开一份；不抛）。 */
function writeLoadError(e) {
  try {
    const path = join(chatDir(), 'plugin-error.log');
    mkdirSync(dirname(path), { recursive: true });
    let old = '';
    try { old = readFileSync(path, 'utf8'); } catch { /* 第一次 */ }
    if (old.length > 64 * 1024) old = old.slice(-32 * 1024);
    writeFileSync(path, `${old}${new Date().toISOString()} ${e?.stack ?? e}\n`, 'utf8');
  } catch { /* 记不住也不能再炸一次 */ }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const disposers = [];
  const log = (m) => { try { ctx?.logger?.info?.(`[dsh-see-now] ${m}`); } catch { /* ignore */ } };

  // DSH 桌面版把 ffmpeg 放在 `~/.dsh/tools/ffmpeg/bin`，**不进 PATH**。
  // 写裸 'ffmpeg' 在 macOS 上就是 ENOENT，而且会伪装成"插件坏了"。
  const ffmpeg = resolveFfmpeg();
  log(`ffmpeg: ${ffmpeg.path}（${ffmpeg.source}）`);
  /**
   * 用户自己的节奏参数（`~/.dsh/see-now.json`）。在 apply 时读一次：
   * 改配置要重开 DSH，和 voice.json 的热读不同 —— 这些值影响的是循环的收工线，
   * 每拍读盘不值得。
   *
   * **必须在 createRunner 之前读**：`listen` 段要传给听声音那条链
   * （断句参数、pollMs、长句快照都在里面）。
   */
  const tuning = readTuning();
  if (tuning.warnings.length) log?.(`[see-now] ${tuning.warnings.join('；')}`);
  const runner = createRunner({
    ffmpegPath: ffmpeg.path,
    log,
    // 听声音要宿主 `speechToText`（社区用户那边零安装）；给不到就只降级成"没字幕"
    ctx,
    listen: tuning.listen,
  });
  disposers.push(() => runner.stop());

  // 声音：和陪看共用同一份 `~/.dsh/voice.json`。**失败一律不抛** ——
  // 声音是可选能力，装坏了最多没声音，不能让看屏幕起不来。
  // 不 await 到阻塞启动：适配器要 import 模块、探测引擎，可能几百毫秒。
  // 启动时挂一次只是热身；真正保证"改完配置就生效"的是每次调用前的 ensureConfiguredVoice。
  ensureConfiguredVoice({ log })
    .then((r) => { if (!r.ok && r.reason !== 'not-configured') log(`声音没挂上：${r.reason}`); })
    .catch(() => { /* 已经在里面兜过了 */ });
  disposers.push(() => { detachAdapters().catch(() => {}); });

  /**
   * 念之前占住"静音窗口"。
   *
   * 不占会怎样：AI 用自己的声音念台词 → 音箱出声 → 回环收回去 → 转成文字 →
   * 被当成"视频里说的" → 模型接着那句话聊下去。自己跟自己聊，停不下来。
   *
   * **`voice: false` 不能省**：那是"只观察、不出声"的订阅者。标成 true 会让
   * `speechSubscribers()` 一直 > 0，展示层就会一直等一个永远不会来的 `spoken`。
   */
  disposers.push(onSpeech((e) => {
    if (e?.state === 'due') markSpeaking(e.text);
  }, { voice: false }));

  /**
   * 当前会话 id：从 `session/event` 钩子里拿（`session.header.id`）。
   *
   * 必须有它才能叫醒模型 —— 没有就退化成"看完一张就停"，那正是要修的病。
   * 用**函数**而不是快照：会话 id 由钩子随时更新，闭包里存值会让第一次之后全用旧的。
   */
  let lastSessionId = null;

  /**
   * **逐帧 / 逐场景模式**（默认关）。
   *
   * 开了之后：每留下 1 帧就单独出一张满幅图 → 每换一次场景模型就收到一张图 + 一次唤醒。
   * 这是给演示用的（"每换一个场景就告诉我这是什么"），**平时别开**：
   * 2 秒换一张画面就是每分钟 30 次唤醒，每次一张图（222 token，含音轨条）+ 一轮模型往返。
   *
   * 之所以做成"会话级粘性开关"而不是每次 watch 传参：模型很容易忘，
   * 忘一次就退回多帧拼图，演示当场露馅。所以开一次管到 `scene:false` 或 `stop` 为止。
   */
  let sceneMode = false;
  /** 节奏：calm / normal / dense（粘性）。**这是"省点钱"唯一能真的生效的旋钮。** */
  let paceMode = PACES[tuning.defaultPace] ? tuning.defaultPace : DEFAULT_PACE;
  /**
   * **上一次真正生效的 source 类型**。`cutAbs` 的自动选择要靠它，不能看本次请求的 `src`：
   * 第二次 `watch` 通常不带 path（接着看同一段），那时 `src` 是 undefined，判定就会从
   * "文件回放"翻回默认档 —— 参数一变 runner 就重启采集，画面从 0 秒重来。
   * 实测 e2e「连看两次，第二张不会重复第一张」就是这么挂的。
   */
  let lastSrcKind = null;
  /** 循环是按哪个模式起的 —— 模式变了要重建，不然唤醒节奏还是旧的 */
  let loopScene = null;
  /** 切模式时那一句说明：下一次工具结果里带给模型，然后清掉 */
  let pendingModeNote = '';
  /**
   * 上一次告诉模型的区域。变了才说一句 —— 每张图都重复"你在看 x,y,w,h"是噪音，
   * 但**变了不说**更糟：模型会拿一块区域的画面去回答整屏的问题。
   */
  let lastRegionKey = regionText(loadRegion());

  /**
   * 把模型的**正文**也记进小窗那条流。
   *
   * 为什么：小窗原来只有 `say` 气泡和用户自己打的字 —— 模型正常回的话一句都不在
   * 里面，于是它只好跟用户解释"我们的对话不会记录在窗口"（2026-11-03 社区反馈）。
   * 记录本来就该是完整的：窗开着的时候，把这一轮的正文追加进 `chat.jsonl`
   * （**不朗读** —— 只有 `say` 才念，这条只是留痕）。
   *
   * 三条护栏：
   *   - 窗没开着就不写：没人在看，写了只是让文件长胖；
   *   - `say` 已经进过窗的（正文包含那句 say）就跳过，不然用户会看到同一句两遍；
   *   - 超长截断到 600 字：小窗是气泡流，不是终端。
   */
  const mirrorAssistantText = (event) => {
    try {
      if (event?.type !== 'assistant/message') return;
      const payload = event.data ?? event;
      const blocks = payload?.message?.content;
      if (!Array.isArray(blocks)) return;
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text.length < 2) return;
      if (!windowAlive()) return;
      const said = lastSaidText();
      const norm = (s) => String(s).replace(/\s+/g, '');
      if (said && Date.now() - said.at < 120_000 && norm(text).includes(norm(said.text))) return;
      appendChat('assistant', text.length > 600 ? `${text.slice(0, 600)}…` : text);
    } catch { /* 记录失败绝不能影响会话本身 */ }
  };
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session, event) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
        mirrorAssistantText(event);
      });
      if (typeof off === 'function') disposers.push(off);
    } catch (e) {
      // 拿不到就退化成"只能手动调"，但要说出来 —— 静默失败是这类 bug 的温床
      log(`session/event 钩子失败：${e?.message ?? e}`);
    }
  }

  /** 正在跑的常驻循环（同一时刻只有一个） */
  let loop = null;
  const stopLoop = (reason = '手动') => {
    if (!loop) return;
    const wasStopped = loop.stopped();
    loop.dispose();
    loop = null;
    if (!wasStopped) log(`循环停了（${reason}）`);
  };
  disposers.push(() => stopLoop('插件卸载'));

  /**
   * 起循环（幂等，按会话）。
   *
   * **这是"看完一张就停"和"一直看下去"的分界线**：以前 `watch` 返回一张图就结束了，
   * 模型回完话自然收工。现在 watch 返回第一张图之后，插件自己接着跑，
   * 攒够下一张就叫醒模型 —— 直到用户关窗。
   *
   * **不接 `run.signal`**：那是单次调用的取消通知，挂上去等于"这一轮结束循环就死"
   * （实测表现就是"它答一句就没下文了"）。取消/超时在 `runner.watch()` 里自己判。
   *
   * **换会话要换循环**：`lastSessionId` 会被任何一个会话的 `session/event` 顶掉，
   * 沿用旧循环就会把话投到别的会话里（"我在这个窗口说话，另一个窗口回答"）。
   *
   * **owner 由调用方传入的优先**：`watch` 是阻塞的（15~40 秒），等它返回时
   * `lastSessionId` 可能已经被另一个会话的事件顶掉了。所以 `watch` 会在**开始等待前**
   * 把当时的会话 id 记下来传进来，而不是让这里现取（issue #1 的归属竞争）。
   */
  const ensureLoop = (owner = null) => {
    /**
     * **非实时的文件回放不起常驻循环。**
     *
     * 循环的意义是"实时源一直在产帧，攒够一张就叫你"。而 `source:"file"` 是调试用的：
     * 有限、放完就停，模型自己调 `watch` 就能一段段取完。给它起循环的后果是
     * 24 秒解出 1955 帧、刷出几十张图、把模型反复叫醒（社区实报）。
     */
    const st0 = runner.status();
    const finiteFile = st0?.lastSource?.kind === 'file' && st0?.lastSource?.realtime !== true;
    if (finiteFile) {
      if (loop) stopLoop('文件回放（有限，不需要循环）');
      loopScene = null;
      return null;
    }
    const sid = owner ?? lastSessionId;
    // 模式和节奏都影响唤醒间隔，任一个变了都得重建循环
    const key = sceneMode ? 'scene' : paceMode;
    if (loop && !loop.stopped() && loop.state().session === sid && loopScene === key) return loop;
    if (loop) stopLoop(loop.state().session ? '换会话' : '重建');
    loopScene = key;
    loop = startLoop({
      ctx,
      sessionId: sid,
      getSessionId: () => lastSessionId,
      runner,
      log,
      scene: sceneMode,
      // 逐帧模式出图最密，4 秒是"一句短话念得完"的下限；
      // 常规按节奏走（normal 15 秒 / calm 30 秒）—— 8 秒一次太吵，实报过。
      wakeMinGapSec: sceneMode ? 4 : PACES[paceMode].wakeGapSec,
      // 收工线（叫醒次数上限 / 空闲分钟）可由 ~/.dsh/see-now.json 覆盖
      tuning,
      onStop: (reason) => {
        if (reason === 'window-closed') {
          // 用户关窗 = 不看了。**落进待领说明**，下一次工具结果带走。
          // 不能写 chat.jsonl：窗已经关了，那条流没人看，模型也拿不到 ——
          // 实测会连写两条，而模型还在说"我还在看"。
          try { runner.note(HANGUP_NOTE); } catch { /* 记不住也要停 */ }
          // **必须用 hangUp 而不是 stop**：stop 只是停采集，下一条 watch 会立刻
          // 重启并把窗重新开起来 —— 用户体感是"关掉又弹出来，只能卸载插件"。
          try { runner.hangUp(); } catch { /* 已经停了 */ }
          return;
        }
        try { runner.stop(); } catch { /* 已经停了 */ }
      },
    });
    log(`常驻循环已启动（会话 ${sid ?? '未知'}）`);
    return loop;
  };

  /**
   * 把"待领的说明"（挂断那一条）贴到工具结果最前面。
   *
   * 取完就没了 —— 同一句话不该每一轮都念一遍。这也解释了为什么不能写进 chat.jsonl：
   * 窗关掉之后那条流没人看，模型也拿不到（实测它继续调 watch，还说"我还在看"）。
   */
  const withPendingNote = (value) => {
    let note = null;
    try { note = runner.takeNote(); } catch { note = null; }
    if (!note || !value || typeof value !== 'object') return value;
    const text = typeof value.text === 'string' ? value.text : '';
    return { ...value, text: text ? `${note}\n\n${text}` : note };
  };

  const toolObj = {
    ...seeNowToolSpec(),
    async execute(args = {}, run = {}) {
      // 第二个参数是宿主的 `ToolRunContext`：`signal` 是"这一轮被取消了"的唯一通知。
      // 它只交给**阻塞等待**（watch）；常驻循环不挂它，理由见 ensureLoop。
      const out = await toolObj.route(args, run);
      // 切模式那句话只带一次：模型要立刻知道"从现在起一张图一个画面"，
      // 但下一轮还念一遍就变成噪音了。
      const noted = pendingModeNote && out && typeof out.text === 'string'
        ? { ...out, text: `${pendingModeNote}\n\n${out.text}` }
        : out;
      pendingModeNote = '';
      return toLosslessJson(withPendingNote(noted));
    },

    async route(args = {}, run = {}) {
      const action = String(args.action ?? 'watch').toLowerCase();

      // **每次调用都检查一遍声音**：改了 voice.json / tts.json，下一句就生效，不用重启宿主。
      // 代价是一次 stat —— 挂载状态没变时 ensure 立刻返回，不会重复 import。
      await ensureConfiguredVoice({ log }).catch(() => { /* 声音永远不该挡住看屏幕 */ });

      // **`say` 的唯一入口**，在**任何采集动作之前**处理。
      //
      // 两件事必须同时发生，所以只能有一处：
      //   ① 写盘 + 发声（`appendSpoken`）—— 窗口里有字、嘴里有声，缺一个就是 bug；
      //   ② 撤掉"你还没回她"的待回执 —— 说了话就等于回了。
      //
      // 以前这两件事写在 `runner.watch()` 里，于是 `peek` 带 `say` 时既不发声也不清待回执
      // （实测：peek 回了话，下一轮还在念"你还没回"）。放在这里所有 action 都覆盖到。
      const said = args.say ? String(args.say).trim().slice(0, 800) : null;
      if (said) {
        try { appendSpoken('assistant', said); } catch { /* 写不进不影响看屏幕 */ }
        clearInterjected();
      }

      /**
       * 模式开关（粘性）。
       *
       * 变了就必须**把管线拆掉重开**：`maxFrames` / `strategy` 是建管线时定死的参数，
       * 运行中改不了。同时把循环也重建一次 —— 唤醒间隔跟着模式走
       * （逐帧 4 秒 / 常规 8 秒），不重建的话切过去还是旧节奏。
       */
      let modeNote = '';
      if (typeof args.scene === 'boolean' && args.scene !== sceneMode) {
        sceneMode = args.scene;
        try { runner.stop(); } catch { /* 没在跑 */ }
        stopLoop('换模式');
        loopScene = null;
        modeNote = sceneMode
          ? '已切到**逐帧模式**：每换一次场景给你一张满幅图（一张图 = 一个画面）。'
            + '只在演示/逐场景播报时用；说完话接着调 watch，换场景时我会叫你。'
          : '已切回**常规模式**：一张图装几帧、攒够才发。';
        log(modeNote.replace(/\*\*/g, ''));
        pendingModeNote = modeNote;
      }

      /**
       * 节奏（粘性）。**这是"太密了 / 省点钱"唯一真正生效的入口。**
       *
       * 光靠模型在 `say` 里答应没用 —— 出图频率和唤醒间隔都是插件参数，
       * 不改参数就是不改行为。所以听到"慢一点 / 省点钱"就传 `pace:"calm"`。
       */
      let wantPace = args.pace ? String(args.pace).toLowerCase() : null;
      // 旧名兼容：`action` 曾短暂用过，收到就走新档
      if (wantPace === 'action') wantPace = 'game-economic';
      if (wantPace && PACES[wantPace] && wantPace !== paceMode) {
        paceMode = wantPace;
        try { runner.stop(); } catch { /* 没在跑 */ }
        stopLoop('换节奏');
        loopScene = null;
        const t = {
          calm: '已切到**省电节奏**：20 分以上才算换画面，最多 30 秒叫你一次。',
          normal: '已切回**默认节奏**：12 分算换画面，最多 15 秒叫一次。',
          dense: '已切到**灵敏节奏**：7 分就算换画面，最多 8 秒叫一次（费钱，只在演示/逐帧时用）。',
          'game-economic': '已切到**动作节奏**：80 分以上才算换画面，出帧按"攒够 30 秒运动量"算，'
            + '最多 20 秒叫一次，每张图最多 8 帧（全屏游戏/高速画面用，信息量比 normal 少）。',
        }[wantPace];
        pendingModeNote = [t, pendingModeNote].filter(Boolean).join('\n\n');
        log(t.replace(/\*\*/g, ''));
      }

      if (['pause','resume','seek','configure'].includes(action)) {
        const result = action === 'seek' ? await runner.seek(args.position) : action === 'configure' ? await runner.configure({ quality: args.quality }) : await runner[action]();
        return { text: result.ok ? `文件操作完成：${action}` : `文件操作未完成：${result.reason}`, meta: result };
      }
      if (action === 'watch') {
        // **循环的 owner 必须在等待开始前锁定**。`runner.watch()` 会阻塞 15~40 秒，
        // 这期间任何会话的 `session/event` 都会改写 `lastSessionId`；等它返回再
        // `ensureLoop()` 现取，就会把后续唤醒投到"等待期间最后说话的那个会话"去
        // （issue #1 的复现：watch 在 A 会话发起，结束后循环绑到了 B）。
        const ownerAtStart = lastSessionId;
        /**
         * region 的三个入口，优先级从高到低：
         *   1. `region:"off"` —— 取消（存的那块一起删掉）
         *   2. `region:"x,y,w,h"` —— 这一次用这块（`srcOf` 负责校验和报错）
         *   3. 都没传 —— 用用户上次框好的那块（`~/.dsh/see-now/region.json`）
         *
         * 第 3 条是这次的重点：**模型不该被要求记住四个数字**。用户框一次，之后
         * 每轮 `watch` 自动就是那块。
         */
        const rawRegion = typeof args.region === 'string' ? args.region.trim() : '';
        const regionOff = /^(off|none|clear)$/i.test(rawRegion);
        const built = srcOf(regionOff ? { ...args, region: undefined } : args);
        if (built.error) return { text: built.error, meta: { ok: false, reason: 'bad-region' } };
        const src = built.src;
        const stickyRegion = regionOff ? null : (rawRegion ? undefined : loadRegion());
        if (regionOff) clearRegion();
        // 变了一次说一次：模型要知道自己现在只看这一块，也得知道已经回到整屏
        const regionKey = regionText(stickyRegion ?? src?.region ?? null);
        if (regionKey !== lastRegionKey) {
          lastRegionKey = regionKey;
          pendingModeNote = [
            regionKey
              ? `现在只抓屏幕上的 **${regionKey}** 这一块（屏幕物理像素）—— 画面之外的东西你看不到，`
                + '也不要假设整屏发生过什么。'
              : '已经回到**整屏**，不再只抓那一块。',
            pendingModeNote,
          ].filter(Boolean).join('\n\n');
        }
        // **封顶必须小于宿主给这个工具的 timeoutMs**（见 tool-spec）：工具自己挂得比
        // 宿主的死线还久，到点就不是"返回一张图"，而是整条调用被 abort（还会顺带 abort signal）。
        const seconds = Math.min(
          Number(args.seconds) > 0 ? Number(args.seconds) : DEFAULT_BLOCK_SEC,
          MAX_BLOCK_SEC,
        );
        const requestedMinFrames = Number(args.minFrames) > 0 ? Number(args.minFrames) : 1;
        // **逐帧模式和 minFrames 互斥**：逐帧一张图就 1 帧，`minFrames > 1` 永远等不满，
        // 会一路等到超时再报"画面没变"——那是假故障。让 minFrames 让路（它只是
        // "别给我太碎的图"，而逐帧本来就要碎），并把这句说出去，别让人以为设了 5 就真有 5。
        const minFrames = sceneMode ? 1 : requestedMinFrames;
        if (sceneMode && requestedMinFrames > 1) {
          pendingModeNote = [
            `逐帧模式下每张图只有 1 帧，\`minFrames: ${requestedMinFrames}\` 这条路上不生效（已按 1 处理）。`
            + '要按帧数攒图，先 `see_now({scene:false})`。',
            pendingModeNote,
          ].filter(Boolean).join('\n\n');
        }
        if (src?.kind) lastSrcKind = src.kind;
        const r = await runner.watch({
          seconds,
          minFrames,
          src,
          // 存下来的那块（undefined = 这次没提，保持原样；null = 显式取消）
          region: regionOff ? null : stickyRegion,
          quality: args.quality ? String(args.quality).toLowerCase() : null,
          // 逐帧模式：一张图一帧 + 档位固定 1（铺满）；常规按节奏定切点门槛。
          // 参数变了 runner 会自己重开管线。
          opts: {
            ...(sceneMode ? SCENE_OPTS : {}),
            // 档位自带的管线覆盖（`action` 用：积分阈值、每张帧数、兜底间隔…）。
            // 逐帧模式不吃这套 —— 它自己已经定死了 maxFrames/strategy。
            ...(sceneMode ? {} : (PACES[paceMode].pipeline ?? {})),
            // **文件回放（看视频）走视频最优门槛**：实测 27 段短视频上，cutAbs 7 的切点 F1 是 56.8%，
            // 默认 12 只有 51.9%（12fps 采样本来就会吃掉一部分快切）。屏幕采集不受影响。
            // 用户显式传了 pace 就尊重用户。
            cutAbs: (sceneMode
              ? PACES.dense
              : (lastSrcKind === 'file' && !wantPace && paceMode === 'normal' ? PACES.dense : PACES[paceMode])).cutAbs,
          },
          signal: run?.signal ?? null,
        });
        if (!r.ok) {
          // 用户关过窗：**只有他重新要求看，才允许再开**。这一条以前只靠工具描述
          // 里的一句"别再调了"，模型不照做就会把窗重新弹出来。
          if (r.reason === 'hung-up') {
            return {
              text: '用户已经关掉了悬浮窗，这一轮看屏幕结束了。\n'
                + '**不要再调 `see_now`**。等用户明确说要看（或者重新打开窗口）再开始。',
              meta: { ok: false, reason: 'hung-up' },
            };
          }
          // 文件回放放完了：不能自动从头重播，必须显式再传一次来源。
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
        // **拿到第一张图之后就把钟起起来** —— 这是"看一眼就完"和"一直看下去"的分界线。
        // 之后每攒够一张，循环会自己叫醒你，不用你再调。
        const lp = ensureLoop(ownerAtStart);
        const out = await attachAndReturn(ctx, r.sheet, {
          waited: r.waited, partial: r.partial, quality: r.quality,
          userText: r.userText ?? null,
          say: said,
          looping: Boolean(lp) && !lp.stopped(),
          loopWakes: lp ? lp.state().wakes : 0,
        });
        /**
         * **窗被藏起来时必须当面说清**，否则就是"你说'眼睛开上了'，屏幕上什么都没有"。
         * 只在藏着的时候加这一句（正常情况不加噪音），并给出唯一能用的那条指令。
         */
        if (r.windowOpen === false) {
          // 窗压根没开起来（最常见：没有带 tkinter 的 python）。这时候 `say` 同样是石沉大海，
          // 但**不能**叫模型去 show —— show 改的是配置，解决不了"进程起不来"。
          const why = runner.status().window?.reason;
          return {
            ...out,
            text: `${out.text}\n\n**悬浮窗没开起来${why ? `（${why}）` : ''}** —— 用户看不到也听不到你的 \`say\`。`
              + '\n别说"我在看着你"这类话；先在正文里告诉他这个情况（正文能到，`say` 到不了）。',
            meta: { ...out.meta, windowOpen: false },
          };
        }
        if (!windowHidden()) return out;
        return {
          ...out,
          text: `${out.text}\n\n${windowLine()}\n`
            + '**用户看不到你的 `say`** —— 窗是藏起来的。'
            + '要他看见就调 `see_now({action:"window", show:true})`。',
          meta: { ...out.meta, windowHidden: true },
        };
      }

      if (action === 'peek') {
        const s = runner.peek();
        const st = runner.status();
        // 走 peek 路线的会话也要有循环：不然模型摘完这一张就结束，没人再叫它。
        // **但采集都停了就别起** —— 起一个下一拍就自杀的钟只是噪音。
        const lp = (s || st.running || st.pending) ? ensureLoop() : null;
        if (!s) {
          return {
            text: '手上还没有画面（刚开或刚发完，下一张还在攒）。\n'
              + `循环${!lp || lp.stopped() ? '没在跑' : '在跑'} —— 攒够我会叫你；要看此刻可以调 \`see_now({action:"watch"})\`。`,
            meta: { ok: false, reason: 'no-sheet', loop: lp?.state() ?? null },
          };
        }
        return await attachAndReturn(ctx, s, { looping: Boolean(lp) && !lp.stopped() });
      }

      if (action === 'start') {
        const built = srcOf(args);
        if (built.error) return { text: built.error, meta: { ok: false, reason: 'bad-region' } };
        const r = await runner.start({ src: built.src ?? { kind: 'screen' } });
        return {
          text: r.already ? '已经在看了。'
            : `开始看 ${r.source.kind}（引擎 ${r.engine}）${r.warning ? `。⚠️ ${r.warning}` : '。'}`,
          meta: r,
        };
      }

      if (action === 'stop') {
        stopLoop('手动 stop');
        runner.stop();
        return { text: '停了。窗口还开着，想再看得重新调 watch。', meta: { ok: true } };
      }

      /**
       * 悬浮窗的显示 / 隐藏 / 状态。
       *
       * **这是"窗在但看不见"的唯一出口。** 以前没有它：模型发现窗被藏起来了，
       * 只能去读 `~/.dsh/watch-window.json`，又没有写权限，于是答
       * "我这边只有读权限，发不了「显示」指令"（2026-11-03 社区反馈）。
       *
       * 改的是窗口进程每 250ms 轮询的那份文件，所以**不用重启窗口**，一拍就生效。
       */
      if (action === 'window') {
        const wants = typeof args.show === 'boolean' ? args.show : null;
        let changed = null;
        if (wants !== null) {
          changed = setWindowHidden(wants, { log });
          log(`悬浮窗${wants ? '显示' : '隐藏'}${changed.changed ? '' : '（本来就是）'}`);
        }
        const r = windowReport();
        const head = wants === null
          ? '悬浮窗现在是这样：'
          : wants
            ? (changed?.error ? `没改成显示（${changed.error}），现状：` : '已让悬浮窗显示出来。')
            : (changed?.error ? `没改成隐藏（${changed.error}），现状：` : '已把悬浮窗藏起来（采集照常，只是看不见）。');
        return {
          text: `${head}\n${windowLine(r)}`
            + (r.alive ? '' : '\n窗没开着 —— 下一次 `watch` 会重新开一个。')
            + (r.alive && r.hidden && wants !== false
              ? '\n**用户现在看不到任何东西**：要么 `see_now({action:"window", show:true})`，'
                + '要么就别再用 `say` 说话，等他主动问。'
              : ''),
          meta: { ok: changed ? !changed.error : true, window: r, changed: changed?.changed ?? false },
        };
      }

      /**
       * 框一块屏幕给它看（`action:"region"`）。
       *
       * 为什么要有这条：`region:"x,y,w,h"` 是 PR #9 加的，但**谁来量这四个数**是
       * 没人解决的问题 —— 让用户去截图软件里读像素不现实。这里起一个全屏取框窗
       * （`pick_region.py`，和悬浮窗共用同一个带 tkinter 的 python），拖一下松手，
       * 坐标直接落盘，之后 `watch` 默认就用它。
       *
       * 会**阻塞到用户框完**（最长 3 分钟）。调用前最好先 `say` 一句"屏幕上会变暗，
       * 拖个框就行"，否则用户不知道那块黑罩子是哪来的。
       */
      if (action === 'region') {
        if (/^(off|none|clear)$/i.test(String(args.region ?? '').trim())) {
          const had = loadRegion();
          clearRegion();
          lastRegionKey = null;
          return {
            text: had ? `已取消区域（原来是 ${regionText(had)}），下一次 watch 抓整屏。` : '本来就没设区域，现在还是整屏。',
            meta: { ok: true, region: null },
          };
        }
        const r = await pickRegion({ log });
        if (!r.ok) {
          const why = {
            cancelled: '用户取消了框选（Esc / 右键），什么都没改。',
            timeout: '等了三分钟没框完，取框窗已经收掉了。',
            'no-python': `找不到能跑取框窗的 python（要带 tkinter）：${r.detail ?? ''}`,
            'no-script': `取框脚本不见了：${r.detail ?? ''}`,
            failed: `取框失败：${r.detail ?? ''}`,
          }[r.reason] ?? `取框没成（${r.reason}）。`;
          return { text: why, meta: { ok: false, reason: r.reason, detail: r.detail ?? null } };
        }
        const t = regionText(r.region);
        lastRegionKey = t;
        pendingModeNote = `用户刚框好一块：**${t}**（屏幕物理像素）。现在只看这一块。`;
        log(`区域已选：${t}`);
        return {
          text: `框好了：**${t}**（${r.region.w}×${r.region.h}，屏幕物理像素）。\n`
            + '从现在起 `watch` 默认只抓这块，不用再传 `region`。\n\n'
            + '三条你要知道的（也是该告诉用户的）：\n'
            + '- 抓的是**屏幕上正在显示的像素**：这块被别的窗口挡住，你看到的就是挡住它的那个窗口。\n'
            + '- 没接 OBS，抓不到后台窗口、最小化的窗口。\n'
            + '- 只在主屏有效；框到主屏外面会被拒绝（gdigrab 不接受负偏移）。\n'
            + '换一块：再调一次 `see_now({action:"region"})`；不要了：`see_now({action:"region", region:"off"})`。',
          meta: { ok: true, region: r.region },
        };
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
            // 循环状态单独一行：**"模型答一句就停"时第一个要看的就是它**
            + `\n循环：${loopLine(lp)}`
            // 队列：手上有没有攒着没取走的图 —— `pending` 一直是 1 时模型不会收到新图，只会一直被叫
            + `\n队列：${s.pending ? `有 ${s.pending} 张没取走（出图序号 ${s.sheets}）` : '空'}`
            // 窗口：**"它在看但我什么都没看到"时第一个要看的就是这一行**
            + `\n${windowLine()}`
            + (s.window?.ok === false && s.window?.reason ? `\n  ↳ 开窗失败：${s.window.reason}` : '')
            // 模式：逐帧时一张图只有一帧、铺满；常规是多帧拼格
            + `\n模式：${sceneMode ? '逐帧（一张图 = 一个场景，铺满）' : '常规（多帧拼一张）'}`
            + ` · 节奏：${sceneMode ? 'dense（跟逐帧走）' : paceMode}`
            + `（切点门槛 ${(sceneMode ? PACES.dense : PACES[paceMode]).cutAbs}，`
            + `最多 ${sceneMode ? 4 : PACES[paceMode].wakeGapSec} 秒叫一次）`
            // 收工线：用户改过 see-now.json 时要能看出来，否则"怎么陪我一会儿就停了"查不到
            + `\n收工线：连续 ${tuning.maxAutonomousWakes} 次叫醒没人理`
            + ` · ${tuning.idleStopMin > 0 ? `没开窗时 ${tuning.idleStopMin} 分钟没说话` : '空闲线已关闭'}`
            + `${tuning.path && tuning.maxAutonomousWakes === 8 && tuning.idleStopMin === 3 ? '（默认）' : `（${tuning.path}）`}`
            // 区域：只看一小块时，模型得知道自己看到的不是整屏
            + `\n区域：${regionText(s.lastSource?.region ?? loadRegion()) ?? '整屏'}`
            // 声音单独一行：听不到声音时第一个要看的就是这里
            + `\n声音：${voice.speakers > 0
              ? `已接上 ${voice.adapters.join(', ') || '适配器'}（${voice.speakers} 个会出声的订阅者）`
              : voice.configured
                ? `配了 ${voice.configured} 但没挂上（${voice.reason ?? '原因未知'}）`
                : '没配 —— 写 ~/.dsh/voice.json 的 {"adapter":"…"} 才有声音'}`
            // 听声音（视频里的台词）：**"它不知道台词"时第一个要看的就是这一行**
            + `\n听声音：${listenLine(s.listen)}`
            // 宿主 cookie 拥挤度：只快满了才出现（满了之后插件根本起不来，提醒不到）
            + cookieWarnLine(),
          meta: { ...s, voice, loop: lp, window: windowReport() },
        };
      }

      return { text: `未知 action: ${action}（可用 watch / peek / start / stop / status）`, meta: { action } };
    },
  };

  /**
   * 注册工具。**单独兜住"已经被别人注册过"**：装了两次（profile 的 bundles 里有一份、
   * 又在 patch 里插了一份）时这里会抛 `tool "see_now" is already registered`。
   * 以前这句会一路冒到 `apply()` 的兜底里，把整个插件判死 —— 连窗和循环都不起。
   * 现在只记一行，让已经注册的那一份继续工作。
   */
  try {
    disposers.push(ctx.tools.register(defineTool(toolObj)));
    // 注册成功要留一行：出问题时"加载失败"（有 plugin-error.log）和"装了两份、被去重"
    // 是两回事，没有这行只能靠猜。
    log(`已注册工具 ${TOOL_NAME}（v${VERSION}）`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/already registered/i.test(msg)) throw e;
    /**
     * 装了两份：另一份已经在供货。**这一份必须整个退掉** —— 只是"不注册工具"的话，
     * 它的 runner / 常驻循环 / 窗口照样起来，于是同一个模型被两套循环各叫一次。
     */
    log(`工具 ${TOOL_NAME} 已经注册过了（${msg}）—— 这一份直接退出，避免两套循环同时叫醒模型`);
    for (const d of disposers.reverse()) { try { d?.(); } catch { /* 收不干净也不能再炸 */ } }
    return () => {};
  }

  return () => { for (const d of disposers.reverse()) d?.(); };
}
