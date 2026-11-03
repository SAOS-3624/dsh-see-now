/**
 * index.js — 插件入口。只做三件事：注册工具、路由 action、把图交成附件。
 *
 * **唯一的取图方式是 `watch`**：它阻塞到「攒够一张」或超时，然后把图作为**工具返回值**
 * 交给宿主。不要用 `sessionController.prompt` 往会话里推 —— 那样模型看到图又去调工具、
 * 自己唤醒自己，停不下来（0.0.1 就是死在这儿）。
 */

import { createRunner, SCENE_OPTS, PACES, DEFAULT_PACE } from './runner.js';
import { resolveFfmpeg } from './binaries.js';
import { seeNowToolSpec, TOOL_TIMEOUT_MS, DEFAULT_BLOCK_SEC } from './tool-spec.js';
import { interjectNote, replyReminder, clearInterjected, noteInterjected, pendingInterjected } from './interject.js';
import { appendSpoken, lastSaidNote } from './chat.js';
import { ensureConfiguredVoice, detachAdapters, attachedAdapters, configuredVoiceAdapter, lastVoiceError } from './voice.js';
import { speechSubscribers } from './speech.js';
import { startLoop, HANGUP_NOTE } from './loop.js';

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
  throw new Error('cannot resolve @deepseek-ai/dsh-tools (set DSH_TOOLS_PATH for local dev)');
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
  return `${head}\n${lines.join('\n')}${ask}${lastSaidNote()}${loopNote}\n（${whyText}；想看下一段就再调一次 \`see_now({action:"watch"})\`。）${replyReminder({ answered: Boolean(say) })}`;
}

/**
 * 提交成宿主附件，并组装工具返回值。
 *
 * **`saveImage` 必须 `.call(svc, …)`**：它内部读 `this.compression`，方法取下来裸调会丢 this，
 * 报 `Cannot read properties of undefined (reading 'compression')` —— 所有出图工具一起挂。
 */
async function attachAndReturn(ctx, sheet, extra = {}, signal = null, acknowledge = null) {
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
  if (signal?.aborted && signal.reason !== 'control') return { text: '这一轮已取消，文件图保留待重试。', meta: { ok: false, reason: 'cancelled' } };
  acknowledge?.();
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
    if (process.env.DSH_SEE_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const disposers = [];
  const log = (m) => { try { ctx?.logger?.info?.(`[dsh-see-now] ${m}`); } catch { /* ignore */ } };

  // DSH 桌面版把 ffmpeg 放在 `~/.dsh/tools/ffmpeg/bin`，**不进 PATH**。
  // 写裸 'ffmpeg' 在 macOS 上就是 ENOENT，而且会伪装成"插件坏了"。
  const ffmpeg = resolveFfmpeg();
  log(`ffmpeg: ${ffmpeg.path}（${ffmpeg.source}）`);
  const runner = createRunner({
    ffmpegPath: ffmpeg.path,
    log,
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
   * 2 秒换一张画面就是每分钟 30 次唤醒，每次一张图（233 token）+ 一轮模型往返。
   *
   * 之所以做成"会话级粘性开关"而不是每次 watch 传参：模型很容易忘，
   * 忘一次就退回多帧拼图，演示当场露馅。所以开一次管到 `scene:false` 或 `stop` 为止。
   */
  let sceneMode = false;
  /** 节奏：calm / normal / dense（粘性）。**这是"省点钱"唯一能真的生效的旋钮。** */
  let paceMode = DEFAULT_PACE;
  /** 循环是按哪个模式起的 —— 模式变了要重建，不然唤醒节奏还是旧的 */
  let loopScene = null;
  /** 切模式时那一句说明：下一次工具结果里带给模型，然后清掉 */
  let pendingModeNote = '';
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
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
      const wantPace = args.pace ? String(args.pace).toLowerCase() : null;
      if (wantPace && PACES[wantPace] && wantPace !== paceMode) {
        paceMode = wantPace;
        try { runner.stop(); } catch { /* 没在跑 */ }
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
          const saved = await attachAndReturn(ctx, result.sheet, {}, run?.externalSignal ?? run?.signal, () => runner.acknowledge(result.sheet));
          if (saved.meta?.ok === false) return saved;
          return { ...saved, text: `已跳转到 ${result.playback.requestedPositionSec ?? result.playback.positionSec}s，预览已附上。`, meta: { ...saved.meta, ...result } };
        }
        return { text: result.ok ? `文件操作完成：${action}` : `文件操作未完成：${result.reason}`, meta: result };
      }

      if (action === 'watch') {
        // **循环的 owner 必须在等待开始前锁定**。`runner.watch()` 会阻塞 15~40 秒，
        // 这期间任何会话的 `session/event` 都会改写 `lastSessionId`；等它返回再
        // `ensureLoop()` 现取，就会把后续唤醒投到"等待期间最后说话的那个会话"去
        // （issue #1 的复现：watch 在 A 会话发起，结束后循环绑到了 B）。
        const ownerAtStart = lastSessionId;
        const src = args.source ? {
          kind: String(args.source).toLowerCase(), path: args.path, realtime: args.realtime === true,
        } : null;
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
        const r = await runner.watch({
          seconds,
          minFrames,
          src,
          quality: args.quality ? String(args.quality).toLowerCase() : null,
          // 逐帧模式：一张图一帧 + 档位固定 1（铺满）；常规按节奏定切点门槛。
          // 参数变了 runner 会自己重开管线。
          opts: {
            ...(sceneMode ? SCENE_OPTS : {}),
            // 档位自带的管线覆盖（`action` 用：积分阈值、每张帧数、兜底间隔…）。
            // 逐帧模式不吃这套 —— 它自己已经定死了 maxFrames/strategy。
            ...(sceneMode ? {} : (PACES[paceMode].pipeline ?? {})),
            cutAbs: (sceneMode ? PACES.dense : PACES[paceMode]).cutAbs,
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
        return await attachAndReturn(ctx, r.sheet, {
          waited: r.waited, partial: r.partial, quality: r.quality,
          userText: r.userText ?? null,
          say: said,
          looping: Boolean(lp) && !lp.stopped(),
          loopWakes: lp ? lp.state().wakes : 0,
        });
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
        const src = args.source ? { kind: String(args.source).toLowerCase() } : { kind: 'screen' };
        const r = await runner.start({ src });
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
            + `\n循环：${lp && !lp.stopped
              ? `在跑（叫醒 ${lp.wakes} 次${lp.wakeFailures ? `，失败 ${lp.wakeFailures} 次` : ''}`
                + `${lp.lastWakeAt ? `，上一次 ${Math.round((Date.now() - lp.lastWakeAt) / 1000)}s 前${lp.lastWakeOk === false ? '（失败）' : ''}` : ''}`
                + `，会话 ${lp.session ?? '未知'}）`
              : lp?.reason ? `已停（${lp.reason}）` : '没起（还没调过 watch）'}`
            // 手上有没有攒着没取走的图 —— `pending` 一直是 1 时模型不会收到新图，只会一直被叫
            + `\n队列：${s.pending ? `有 ${s.pending} 张没取走（出图序号 ${s.sheets}）` : '空'}`
            // 模式：逐帧时一张图只有一帧、铺满；常规是多帧拼格
            + `\n模式：${sceneMode ? '逐帧（一张图 = 一个场景，铺满）' : '常规（多帧拼一张）'}`
            + ` · 节奏：${sceneMode ? 'dense（跟逐帧走）' : paceMode}`
            + `（切点门槛 ${(sceneMode ? PACES.dense : PACES[paceMode]).cutAbs}，`
            + `最多 ${sceneMode ? 4 : PACES[paceMode].wakeGapSec} 秒叫一次）`
            // 声音单独一行：听不到声音时第一个要看的就是这里
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

  disposers.push(ctx.tools.register(defineTool(toolObj)));

  return () => { for (const d of disposers.reverse()) d?.(); };
}
