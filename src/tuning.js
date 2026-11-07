/**
 * tuning.js — `~/.dsh/see-now.json`：用户自己的节奏参数。
 *
 * 为什么要这个文件：`MAX_AUTONOMOUS_WAKES`（8 次）和 `IDLE_STOP_MS`（3 分钟）
 * 原来写死在 `loop.js`，而**悬浮窗开着时「3 分钟没人说话」那条不判** ——
 * 于是 8 次叫醒就是实际的最长陪看时长（normal 档 15 秒一次 ≈ 2 分钟）。
 * 想让它多陪一会儿的用户只能改源码，或者每次开新会话先手动 `pace:"calm"`（#8）。
 *
 * 和 voice.json / tts.json / asr.json 一个套路：放 `$DSH_HOME`，不进 profile，
 * 所以 `dsh plugin update` 不会覆盖。**改完要重开 DSH**（启动时读一次，
 * 每帧读盘是拿帧率换便利，不划算）。
 *
 * 所有字段都可选；写错类型就退回默认值并记一条 warn —— 配置永远不该把插件弄挂。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// `tiers.js` 是叶子模块（不 import 任何东西），拿它的默认表当默认值不会成环。
// **不许在这里手抄一份数字** —— 抄了就会和 tiers.js 漂移。
import { LEVEL_THRESHOLDS } from './tiers.js';

/** 与 loop.js 的常量保持一致；这里放默认值是为了不形成反向依赖。 */
export const TUNING_DEFAULTS = Object.freeze({
  maxAutonomousWakes: 8,
  idleStopMin: 3,
  defaultPace: 'normal',
  /**
   * 超省模式：攒够几张图才交给模型（1 = 现在这样，攒满一张就交）。
   *
   * 省的不是图的钱 —— 一张 798×450 只有 222 token，多带两张几乎不要钱。
   * 省的是**每一轮请求都要把整个上下文重过一遍**的那笔：按实测 142k 的会话算，
   * 3 张一起交比分 3 次交，输入侧少算 2/3。会话越短省的越少。
   *
   * **光攒不交是不省的**：叫醒了却还是一次只给一张，剩下两张它还得再 peek 两次，
   * 等于又变回三轮。所以 `takeSheets()` 必须把队列里攒下的一次全给出去。
   */
  wakeBatch: 1,
  /**
   * 会话里涨到多少张图就动手省（`imageTrigger`）。**0 = 关掉这个功能**。
   *
   * 为什么不直接"一到留底数就省"：留 100 张时，第 101 张进来省 1 张、第 102 张再省 1 张 ——
   * **每出一张图就改一次历史，前缀缓存每轮全量失效**，比不省还贵得多（实测口径见 offload.js）。
   * 拆成「触发线 300 / 留底 100」后，攒 200 张才重算一次。
   */
  imageTrigger: 300,
  /**
   * 省完保留最近几张（`imageKeep`）。必须**小于** `imageTrigger`，否则一触发就白省。
   *
   * 100 张 ≈ 2.2 万 token（一张 222 token，跟文件大小无关 —— 计费按像素不按字节）。
   */
  imageKeep: 100,
  /**
   * 档位映射：这张图里每帧占多大格子。
   *
   * `standard` 把 1 档压成 1/2（默认）；`native` 原样不压；`full` 整体降一档（格子更大）；
   * `compact` 整体升一档（格子更小）；`custom` 走 `tierMap` 逐档查表。
   *
   * 以前这条只能用 `watch({opts:{strategy}})` 传，而模型从来不会传 —— 等于没得配。
   */
  tierStyle: 'standard',
  /** `custom` 时的查表：第 i 个数 = "档位 i+1 映射到哪一档"。默认恒等。 */
  tierMap: [1, 2, 3, 4, 5, 6, 7, 8],
  /**
   * 档位**怎么算出来**（见 `pipeline.js` 的 `tierMode`）：
   *
   * - `density`（默认）：过去 1 秒平均每秒几帧 —— 这一带节奏快不快；
   * - `weight`：出图时按变化分切面积 —— 变化越大越值得占地方。
   *
   * 曾经还有 `dwell`（按停留时长），五段素材零次胜出，已删（见 `tiers.js` 里的注释）。
   */
  tierMode: 'density',
  /**
   * 七道阈值取哪一套：`docx`（照抄 docx）/ `perceptual`（按人眼瞬时记忆定标）/ `custom`。
   *
   * `custom` 读 `tierThresholds`，**和曲线互斥**：选了 custom 就只看数组，不看曲线名。
   */
  tierCurve: 'docx',
  /** `custom` 时的七道阈值（帧/秒，必须严格递增）。默认就是 docx 那一套。 */
  tierThresholds: [...LEVEL_THRESHOLDS],
  // 「上一句说多久，就等多久再叫下一轮」（见 pacing.js）。false = 退回固定 8 秒。
  speechPacing: true,
  /**
   * 变化日志：交付时在图下面附一段「这期间屏幕怎么动的」（时间 / 变化分 / 方位）。
   * 默认关 —— 每次交付加约 100 token，属于按需打开的能力，不该改所有人的默认成本。
   */
  changeLog: false,
  /**
   * 亮度归一 + 黑边补偿（见 `cuts.js` 的 `normalizeScore`）。默认开。
   *
   * 关掉等于回到 0.1.3 的绝对分：夜戏/暗调影视剧的真切点只有约 5 分，门槛 12 够不着；
   * 2.39:1 的片子上下黑边把分数打了 75 折。**亮场（V ≥ 160）无黑边时它逐位不变**，
   * 所以留着不影响日常屏幕，只在暗场/宽银幕上起作用。
   */
  scoreNormalize: true,
});

/**
 * 「听声音」那一链的延迟参数（`see-now.json` 的 `listen` 段）。
 *
 * 这几个数决定"视频里说的话多久之后能变成台词"，是全链路唯一能调的地方：
 *
 * ```
 * 开口 ──silence/maxSeg 断句──▶ 落盘 ──pollMs──▶ 转写 ──▶ 台词可读
 *        └─ liveMin/liveStep：长句不等断句，先给一版临时台词
 * ```
 *
 * `live` 那组是 2026-11-04 加的：实测本地 paraformer 转 1.5 秒音频只要 140ms，
 * 而长句要等 `maxSeg`（3 秒）强切才动 —— **等断句的时间是转写本身的 20 倍**。
 */
export const LISTEN_DEFAULTS = Object.freeze({
  /**
   * 用哪个转写器（`auto` / `host` / `local`，见 listen.js 的 `resolveTranscriber`）。
   *
   * 默认 `auto` = 宿主优先、没有就回落本地 —— 社区用户那边不用装任何东西。
   * 另外两个是**说到做到**：指定了就不偷偷换成另一个。之所以要这个开关：
   * 两者转出来的东西不一样（宿主 SenseVoice 走 CPU、70ms 级；自建服务往往是 GPU、
   * 带字级时间码），而原来写死宿主优先，等于自己搭了服务也用不上。
   */
  prefer: 'auto',
  /** 长句「边说边出字幕」：说满 `liveMin` 秒就先转一版，整句落盘后覆盖它。 */
  live: true,
  /** 说满这么多秒才发第一版快照。1.0 秒的片段质量明显掉（实测丢一半），1.5 可用，1.8 稳。 */
  liveMin: 1.8,
  /** 之后每这么多秒刷新一次。**别低于 1.0** —— 转写服务是串行的，压太密只会互相排队。 */
  liveStep: 1.2,
  /** 静音多久算一句说完。0.35 是"人话气口"的下限，再低会把"第一个维/度是技术"切成两半。 */
  silence: 0.35,
  /** 一句话最长多少秒强切。长句靠 `live` 提前出字幕，这里不必再压。 */
  maxSeg: 3.0,
  /** Node 扫目录的间隔（毫秒）。直接计进延迟，200 → 100 净省 100ms。 */
  pollMs: 100,
});

/** 可用节奏。和 runner.js 的 PACES 同步，但不在模块层 import（避免环形依赖）。 */
export const PACES_KEYS = Object.freeze(['calm', 'normal', 'dense', 'game-economic']);

/**
 * 转写服务的三种选择。
 *
 * `auto` 的顺序就是回落方向：宿主能用就用宿主，没有再找本地。
 * `host` / `local` 是严格的（找不到就明说没有，不换一个顶上）。
 */
export const PREFER_KEYS = Object.freeze(['auto', 'host', 'local']);

/**
 * 档位映射的四种取法。
 *
 * `native` / `full` / `compact` 和 `tiers.js` 的 `STRATEGIES` 同名，
 * `custom` 是设置页展开八个下拉的那一档（走 `tierMap`）。
 * 注意 `single`（逐帧模式固定整幅）**不在这里**：它是逐帧模式的内部约定，不该被用户改。
 */
export const TIER_STYLES = Object.freeze(['standard', 'native', 'full', 'compact', 'custom']);

/** 档位怎么算出来。与 `pipeline.js` 的 `tierMode` 同名。`dwell` 已删（零次胜出）。 */
export const TIER_MODE_KEYS = Object.freeze(['density', 'weight']);

/** 七道阈值取哪一套。`custom` 走 `tierThresholds`。 */
export const TIER_CURVE_KEYS = Object.freeze(['docx', 'perceptual', 'custom']);

function dshHome(env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function tuningPath(env = process.env) {
  return join(dshHome(env), 'see-now.json');
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/**
 * `listen` 段。每项都夹在自己那段区间里，越界退回默认并记一条 warn ——
 * 写成 `"silence": "0.3"`（字符串）这种也必须能跑，配置不该把听声音弄停。
 */
function readListen(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = { ...LISTEN_DEFAULTS };
  const bad = [];

  if (src.prefer !== undefined) {
    if (PREFER_KEYS.includes(src.prefer)) out.prefer = src.prefer;
    else bad.push(`listen.prefer 只能是 ${PREFER_KEYS.join(' / ')}，已用默认 auto`);
  }
  if (src.live !== undefined) {
    if (typeof src.live === 'boolean') out.live = src.live;
    else bad.push('listen.live 只能是 true / false');
  }
  // 判据必须看**原始值**，不能看夹回后的值：`clampNum(x, min, max, out[key])` 越界时
  // 返回的 fallback 就是 `out[key]` 本身，于是 `v !== out[key]` 恒为 false ——
  // 越界的值悄悄被夹回、一条警告都不留（用户以为改生效了）。反方向也错：合法但
  // 不等于默认的值（`silence: 0.5`）会被报成"必须在 0.15–1.5 之间"。
  const num = (key, min, max) => {
    if (src[key] === undefined) return;
    const want = Number(src[key]);
    const ok = Number.isFinite(want) && want >= min && want <= max;
    if (!ok) bad.push(`listen.${key} 必须在 ${min}–${max} 之间（秒）`);
    out[key] = ok ? want : out[key];
  };
  num('liveMin', 0.8, 6);
  num('liveStep', 0.4, 4);
  num('silence', 0.15, 1.5);
  num('maxSeg', 0.8, 15);

  if (src.pollMs !== undefined) {
    const n = Number(src.pollMs);
    const ok = Number.isInteger(n) && n >= 50 && n <= 1000;
    if (!ok) bad.push('listen.pollMs 必须是 50–1000 的整数（毫秒）');
    out.pollMs = ok ? n : out.pollMs;
  }
  // 快照间隔必须小于强切上限，否则一遍都发不出来
  if (out.live && out.liveStep > out.maxSeg) {
    bad.push('listen.liveStep 不能大于 maxSeg，已按 maxSeg 收窄');
    out.liveStep = out.maxSeg;
  }
  return { listen: out, warnings: bad };
}

/**
 * @param {{env?:NodeJS.ProcessEnv, readFile?:typeof readFileSync}} [opts]
 * @returns {{maxAutonomousWakes:number, idleStopMin:number, idleStopMs:number,
 *            defaultPace:string, path:string, warnings:string[]}}
 */
export function readTuning({ env = process.env, readFile = readFileSync } = {}) {
  const path = tuningPath(env);
  const warnings = [];
  let raw = {};
  try {
    raw = JSON.parse(readFile(path, 'utf8')) ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push('see-now.json 不是 JSON 对象，整份忽略');
      raw = {};
    }
  } catch (err) {
    // ENOENT 是正常的（没配过）；其它错误要说出来，否则用户改坏了也不知道
    if (err?.code !== 'ENOENT') warnings.push(`see-now.json 读不了：${err?.message ?? err}`);
    raw = {};
  }

  const maxAutonomousWakes = clampInt(
    raw.maxAutonomousWakes, 1, 200, TUNING_DEFAULTS.maxAutonomousWakes,
  );
  if (raw.maxAutonomousWakes !== undefined && maxAutonomousWakes === TUNING_DEFAULTS.maxAutonomousWakes) {
    const n = Number(raw.maxAutonomousWakes);
    if (!(Number.isInteger(n) && n >= 1 && n <= 200)) {
      warnings.push('maxAutonomousWakes 必须是 1–200 的整数，已用默认 8');
    }
  }

  // 0 = 关掉这条收工线（愿意一直陪着的人自己负责）
  const idleStopMin = clampInt(raw.idleStopMin, 0, 1440, TUNING_DEFAULTS.idleStopMin);
  if (raw.idleStopMin !== undefined && Number(raw.idleStopMin) !== idleStopMin) {
    warnings.push('idleStopMin 必须是 0–1440 的整数（分钟），已用默认 3');
  }

  const wakeBatch = clampInt(raw.wakeBatch, 1, 4, TUNING_DEFAULTS.wakeBatch);
  if (raw.wakeBatch !== undefined && Number(raw.wakeBatch) !== wakeBatch) {
    warnings.push('wakeBatch 必须是 1–4 的整数（攒够几张图才交），已用默认 1');
  }

  // 触发线：0 = 关掉；留底：0 = 全省（只留触发线之后新来的）
  let imageTrigger = clampInt(raw.imageTrigger, 0, 2000, TUNING_DEFAULTS.imageTrigger);
  if (raw.imageTrigger !== undefined && Number(raw.imageTrigger) !== imageTrigger) {
    warnings.push('imageTrigger 必须是 0–2000 的整数（0 = 关闭），已用默认 300');
  }
  let imageKeep = clampInt(raw.imageKeep, 0, 2000, TUNING_DEFAULTS.imageKeep);

  /**
   * `keep >= trigger` 是**没意义**的配置：一触发就想省，结果发现不用省。
   * 不拒绝加载（配置不该把插件弄挂），把它夹到 `trigger - 1` 并说一声。
   */
  if (imageTrigger > 0 && imageKeep >= imageTrigger) {
    const fixed = Math.max(0, imageTrigger - 1);
    warnings.push(`imageKeep（${imageKeep}）必须小于 imageTrigger（${imageTrigger}），已改为 ${fixed}`);
    imageKeep = fixed;
  }

  let tierStyle = TUNING_DEFAULTS.tierStyle;
  if (raw.tierStyle !== undefined) {
    const want = String(raw.tierStyle ?? '').trim();
    if (TIER_STYLES.includes(want)) tierStyle = want;
    else {
      // 警告里带上提交值：`writeTuning` 靠“警告是否变多”判断本次提交是否合法。
      // 如果两条不同的坏值产生同一句警告，历史坏值会遮住新坏值，用户看到保存成功，
      // 实际却被静默换成默认值。
      warnings.push(`tierStyle 只能是 ${TIER_STYLES.join(' / ')}（收到 ${JSON.stringify(want)}），已用默认 ${TUNING_DEFAULTS.tierStyle}`);
    }
  }

  /**
   * 逐档映射。**坏值逐项忽略，不整份作废** —— 用户手改 `see-now.json` 时写错一个数字，
   * 不该让另外 7 档也跟着回到默认。长度不足按默认补齐，超出截断。
   */
  let tierMap = [...TUNING_DEFAULTS.tierMap];
  if (raw.tierMap !== undefined) {
    if (Array.isArray(raw.tierMap)) {
      // 数组没有"只写想改的那一项"这回事 —— 少写就是漏配，说清楚比默默补齐好
      if (raw.tierMap.length !== 8) {
        warnings.push(`tierMap 必须是 8 个数（现在是 ${raw.tierMap.length} 个），缺的按默认补齐`);
      }
      for (let i = 0; i < 8; i += 1) {
        const n = Number(raw.tierMap[i]);
        if (Number.isInteger(n) && n >= 1 && n <= 8) tierMap[i] = n;
        else if (raw.tierMap[i] !== undefined) warnings.push(`tierMap[${i + 1}] 必须是 1–8 的整数，已用 ${i + 1}`);
      }
    } else {
      warnings.push('tierMap 必须是 8 个数字的数组，已用默认映射');
    }
  }

  /**
   * 档位怎么算 + 七道阈值取哪一套。
   *
   * 阈值那一组**必须严格递增**：`createTiers` 的滞回是「升档越 `up[i]`、降档跌穿
   * `down[i]`」，一旦不递增，两道阈值的滞回带会互相盖住，档位会卡在某一档不动 ——
   * 表现是"改了阈值完全没反应"，最难查。所以宁可整份退回默认并说明。
   */
  let tierMode = TUNING_DEFAULTS.tierMode;
  if (raw.tierMode !== undefined) {
    const want = String(raw.tierMode ?? '').trim();
    if (TIER_MODE_KEYS.includes(want)) tierMode = want;
    else if (want === 'dwell') {
      // 这个值是**真存在过**的，不能只报"只能是 density / weight" —— 用户会以为自己拼错了，
      // 翻半天配置。明确说它被删了、为什么删。
      warnings.push('tierMode 的 "dwell"（按停留时长）已移除：真实素材上零次胜出，已用默认 density');
    } else {
      warnings.push(`tierMode 只能是 ${TIER_MODE_KEYS.join(' / ')}，已用默认 density`);
    }
  }

  let tierCurve = TUNING_DEFAULTS.tierCurve;
  if (raw.tierCurve !== undefined) {
    const want = String(raw.tierCurve ?? '').trim();
    if (TIER_CURVE_KEYS.includes(want)) tierCurve = want;
    else warnings.push(`tierCurve 只能是 ${TIER_CURVE_KEYS.join(' / ')}，已用默认 docx`);
  }

  let tierThresholds = [...TUNING_DEFAULTS.tierThresholds];
  if (raw.tierThresholds !== undefined) {
    if (!Array.isArray(raw.tierThresholds)) {
      warnings.push('tierThresholds 必须是 7 个数字的数组，已用默认那一套');
    } else {
      const src = raw.tierThresholds;
      if (src.length !== 7) {
        warnings.push(`tierThresholds 必须是 7 个数（现在是 ${src.length} 个），缺的按默认补齐`);
      }
      const parsed = [];
      for (let i = 0; i < 7; i += 1) {
        const n = Number(src[i]);
        const ok = Number.isFinite(n) && n > 0;
        if (!ok && src[i] !== undefined) {
          warnings.push(`tierThresholds[${i + 1}] 必须是正数（帧/秒），已用默认 ${TUNING_DEFAULTS.tierThresholds[i]}`);
        }
        parsed.push(ok ? n : TUNING_DEFAULTS.tierThresholds[i]);
      }
      // 单项坏值已经各自退回默认，这里只判"合并后整条还增不递增"
      let increasing = true;
      for (let i = 1; i < 7; i += 1) if (!(parsed[i] > parsed[i - 1])) increasing = false;
      if (increasing) tierThresholds = parsed;
      else warnings.push('tierThresholds 必须从左到右严格递增（帧/秒，阈值越大格子越小），已用默认那一套');
    }
  }

  let defaultPace = TUNING_DEFAULTS.defaultPace;
  if (typeof raw.defaultPace === 'string' && raw.defaultPace.trim()) {
    const want = raw.defaultPace.trim();
    if (PACES_KEYS.includes(want)) defaultPace = want;
    else warnings.push(`defaultPace 只能是 ${PACES_KEYS.join(' / ')}，已用默认 normal`);
  }

  // true / "follow" = 按上一句时长排；"guard" = 旧间隔与说完取更晚；false = 关掉
  let speechPacing = TUNING_DEFAULTS.speechPacing;
  if (raw.speechPacing !== undefined) {
    if (typeof raw.speechPacing === 'boolean') speechPacing = raw.speechPacing;
    else if (raw.speechPacing === 'guard') speechPacing = 'guard';
    else warnings.push('speechPacing 只能是 true / false / "guard"，已用默认 true');
  }

  let changeLog = TUNING_DEFAULTS.changeLog;
  if (raw.changeLog !== undefined) {
    if (typeof raw.changeLog === 'boolean') changeLog = raw.changeLog;
    else warnings.push('changeLog 只能是 true / false，已用默认 false');
  }

  // 只认真正的布尔：写成 `0` / `"false"` 是最容易踩的坑 —— `"false"` 是真值，
  // 用户以为关掉了，实际一直开着。所以类型不对就报出来并回默认。
  let scoreNormalize = TUNING_DEFAULTS.scoreNormalize;
  if (raw.scoreNormalize !== undefined) {
    if (typeof raw.scoreNormalize === 'boolean') scoreNormalize = raw.scoreNormalize;
    else warnings.push('scoreNormalize 只能是 true / false，已用默认 true');
  }

  const listenCfg = readListen(raw.listen);
  warnings.push(...listenCfg.warnings);

  return {
    maxAutonomousWakes,
    idleStopMin,
    wakeBatch,
    imageTrigger,
    imageKeep,
    idleStopMs: idleStopMin * 60 * 1000,
    tierStyle,
    tierMap,
    tierMode,
    tierCurve,
    tierThresholds,
    defaultPace,
    speechPacing,
    changeLog,
    scoreNormalize,
    listen: listenCfg.listen,
    path,
    warnings,
  };
}

// ------------------------------------------------------------------ 写回（设置面板）

/** 面板能改的顶层键。`idleStopMs` 是派生的，不在这里 —— 传进来会被拒。 */
export const WRITABLE_KEYS = Object.freeze([
  'maxAutonomousWakes', 'idleStopMin', 'wakeBatch', 'imageTrigger', 'imageKeep', 'tierStyle', 'tierMap',
  'tierMode', 'tierCurve', 'tierThresholds',
  'defaultPace', 'speechPacing', 'scoreNormalize', 'listen',
]);

/** `listen` 段能改的键。 */
export const WRITABLE_LISTEN_KEYS = Object.freeze([
  'prefer', 'live', 'liveMin', 'liveStep', 'silence', 'maxSeg', 'pollMs',
]);

/**
 * 读原始 JSON（不做校验）。`readTuning` 内部那份是内联的，写回需要一个"原样"的副本 ——
 * 合并时要保住用户手写、而面板不认识的键，所以不能拿 `readTuning` 的返回值当底稿
 * （那个已经被夹过、也只含九个字段）。
 */
function readRaw(env, readFile) {
  const path = tuningPath(env);
  try {
    const raw = JSON.parse(readFile(path, 'utf8')) ?? {};
    return (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 把设置面板提交的值合并进 `see-now.json`。
 *
 * 三条规矩，都是为了"配置不该把插件弄挂"这一条：
 *
 * 1. **只动白名单里的键**。文件里其它键原样保留 —— 用户手写过什么、以后版本加了什么，
 *    面板不认识就不该碰。认不出来的键直接拒，而不是静默丢掉。
 * 2. **校验复用 `readTuning`，不另写一套**。把合并后的内容喂给它，如果警告**变多**了，
 *    说明是这次提交引入的，整份拒写并把原话返回前端。用"变多"而不是"有没有"，
 *    是因为文件里可能本来就躺着一处历史错误，不该因此让面板永远存不进去。
 * 3. **只写用户提交过的键**。改一个值就只多一行，不把九个键全刷一遍 ——
 *    否则用户改完打开文件，会看到一堆他从没设过的默认值。
 *
 * @param {object} patch 面板提交的片段，例如 `{ idleStopMin: 10, listen: { silence: 0.4 } }`
 * @returns {{ok:boolean, path:string, values:object, warnings:string[], rejected:string[]}}
 *   - `values`：规范化之后**实际写进去**的那几个键（越界的值进不来，见规矩 2）
 *   - `warnings`：读取时文件里本来就有的警告（给面板做提醒，不阻塞保存）
 *   - `rejected`：本次被拒的原因，直接显示给用户
 */
export function writeTuning(patch, {
  env = process.env, readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync,
} = {}) {
  const path = tuningPath(env);
  const fail = (...rejected) => ({ ok: false, path, values: {}, warnings: [], rejected });

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail('提交的内容必须是 JSON 对象');
  }
  const unknown = Object.keys(patch).filter((k) => !WRITABLE_KEYS.includes(k));
  if (unknown.length) return fail(`面板不认识这些字段：${unknown.join(', ')}`);

  const raw = readRaw(env, readFile);
  const next = { ...raw, ...patch };

  if (patch.listen !== undefined) {
    const src = patch.listen;
    if (src === null || typeof src !== 'object' || Array.isArray(src)) {
      return fail('listen 必须是一个对象');
    }
    const bad = Object.keys(src).filter((k) => !WRITABLE_LISTEN_KEYS.includes(k));
    if (bad.length) return fail(`listen 里不认识这些字段：${bad.join(', ')}`);
    const base = (raw.listen && typeof raw.listen === 'object' && !Array.isArray(raw.listen)) ? raw.listen : {};
    next.listen = { ...base, ...src };
  }

  // 规矩 2：拿他自己的校验器判，警告变多就是这次提交的问题
  const before = readTuning({ env, readFile });
  const after = readTuning({ env, readFile: () => JSON.stringify(next) });
  const added = after.warnings.filter((w) => !before.warnings.includes(w));
  if (added.length) return { ok: false, path, values: {}, warnings: before.warnings, rejected: added };

  // 规矩 3：只写提交过的键，值取规范化之后的
  const values = {};
  for (const key of Object.keys(patch)) {
    if (key !== 'listen') values[key] = after[key];
  }
  if (patch.listen !== undefined) {
    values.listen = {};
    for (const key of Object.keys(patch.listen)) values.listen[key] = after.listen[key];
  }

  const out = { ...raw, ...values };
  if (values.listen !== undefined) {
    const base = (raw.listen && typeof raw.listen === 'object' && !Array.isArray(raw.listen)) ? raw.listen : {};
    out.listen = { ...base, ...values.listen };
  }

  try {
    mkdir(dirname(path), { recursive: true });
    writeFile(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  } catch (err) {
    // 写不进去要说清楚是哪一步，否则用户看到的是"保存没反应"
    return fail(`写 ${path} 失败：${err?.message ?? err}`);
  }

  return { ok: true, path, values, warnings: before.warnings, rejected: [] };
}

