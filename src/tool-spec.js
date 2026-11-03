/**
 * tool-spec.js — `see_now` 的契约。
 *
 * **注意 `parameters` 的形状**：它是「属性名 → 值 schema」的映射，不是完整的 JSON Schema。
 * 写成 `{ type:'object', properties:{...} }` 会被宿主拒绝：
 * `unsupported JSON schema: parameters.type must be a value schema object`。
 * （`output.schema` 反而是完整 JSON Schema —— 两个形状不一样，别抄错。）
 *
 * 参数**写成什么样，模型就会怎么用**。所以 description 里要把"什么时候调、等多久"说清楚，
 * 而不是罗列字段。
 */

/**
 * 这个工具**最长能被宿主挂多久**（毫秒）。
 *
 * 由宿主的 `dsh-tool-call-timeout-policy` 强制执行：到点不是"返回一张图"，
 * 而是整条调用变成 `tool call timed out after Nms`，并且 `exec.signal` 一起 abort。
 *
 * **必须明显大于 `seconds` 的默认值**：这里曾经写 120_000，而 `seconds` 默认 300 ——
 * 静止屏幕上第 120 秒必定超时（`index.js` 又把超时当"这一轮被取消"）。
 * 陪看那边是 900_000。
 */
export const TOOL_TIMEOUT_MS = 900_000;

/** `seconds` 的默认值：只是**上限**，攒够一张就提前返回。 */
export const DEFAULT_BLOCK_SEC = 300;

export function seeNowToolSpec() {
  return {
    name: 'see_now',
    description:
      'Watch what is on the user\'s screen **live** and get back one image made of several frames. '
      + 'Frames are picked by how much the picture changes, so a static screen costs almost nothing '
      + 'while a busy one gives you more frames.\n\n'
      + 'How to use it:\n'
      + '- `see_now({action:"watch"})` — **blocking call; this is the normal way to watch.** The first '
      + 'call returns the current screen in about a second; after that it blocks until a sheet is ready '
      + '(15–40s when the screen is changing, longer when it is static) or the user types in the floating '
      + 'window, then returns that sheet. **Call it again right after you reply** — the blocking call IS '
      + 'the pause; the conversation never ends between sheets. Do not end your turn while the user is '
      + 'still watching.\n'
      + '- `see_now({action:"peek"})` — grab the sheet that already piled up, without waiting. Use this '
      + 'when the plugin wakes you ("有新画面了"), because then you are not inside a `watch` any more.\n'
      + '- `see_now({action:"status"})` — is it still watching, is the loop alive, is sound attached.\n'
      + '- `see_now({action:"stop"})`.\n\n'
      + 'Safety net: if you ever stop calling `watch`, the plugin still keeps capturing and will wake '
      + 'you with a short note when a new sheet fills up (then `peek`). It also stops everything the '
      + 'moment the user closes the floating window, and tells you so — when that note appears, do NOT '
      + 'call `see_now` again until the user asks.\n\n'
      + '**`say` is the ONLY channel the user can see and hear.** Your normal reply text never reaches '
      + 'the floating window and is never spoken — only `say` is. So whenever the user might be waiting, '
      + 'watching, or has just typed something, put what you want to tell them in `say` on the same call. '
      + 'One `say` = one bubble = one spoken utterance, so put two or three sentences in it rather than '
      + 'splitting them across calls.\n\n'
      + '**They are looking at the same screen as you, over and over.** So: do not narrate everything, '
      + 'do not repeat the sentence you already said (the tool result reminds you of it), and silence is '
      + 'a perfectly good answer — there is no quota. Say something when it actually changed or when it '
      + 'is worth pointing at.\n\n'
      + 'The image is returned as a tool result (not pushed into the chat), so just read it. '
      + 'Frames are numbered 1..n in time order; the text lists each frame\'s timestamp and pixel size. '
      + 'Do NOT poll faster than every ~10 seconds — nothing new arrives that fast, and each image costs tokens.\n\n'
      + 'If you cannot read something (small text, filenames, a menu), do NOT guess: call again with '
      + '`quality:"high"` and you get one sharp frame of the current screen in about half a second.',
    parameters: {
      action: {
        type: 'string',
        description: 'watch（默认）| peek | start | stop | status | pause | resume | seek（文件跳转）| configure（更新设置，不取图）',
      },
      position: { type: 'number', description: 'action:"seek" 时定位到本地视频的非负秒数，返回预览；保留原先的暂停/播放状态。' },
      source: {
        type: 'string',
        description: 'Where to capture from: "screen" (whole desktop, default), "obs" (OBS virtual camera), '
          + '"camera" (first webcam). Only matters on the first call of a session. '
          + 'Use "file" together with path to replay a local video instead of a live source (debugging).',
      },
      path: {
        type: 'string',
        description: 'With source:"file": absolute path of a video to replay.',
      },
      realtime: {
        type: 'boolean',
        description: 'With source:"file": replay at 1x speed instead of as fast as ffmpeg can decode.',
      },
      pace: {
        type: 'string',
        description: '"calm" | "normal"（默认）| "dense" | "action" —— 控制**多久算换一次画面、多久叫醒你一次**。\n'
          + '用户说**"太密了 / 回复太频繁 / 省点钱 / 慢一点 / 别老说话"**时，立刻传 `pace:"calm"`'
          + '（20 分以上才算换画面，最多 30 秒叫一次）。这是唯一能真的降低开销的旋钮 —— '
          + '口头答应"我少说点"不会改变出图频率。\n'
          + '用户抱怨**"漏了 / 不灵敏 / 太迟钝"**时传 `pace:"dense"`（7 分就算换，最多 8 秒一次，贵）。\n'
          + '用户在**打游戏、看高速运动画面**，抱怨"发得太频繁 / 一张图糊得看不清 / 顶到限速"时，'
          + '传 `pace:"action"`：切点门槛抬到 80、出帧按 30 秒运动量攒、每张最多 8 帧、最多 20 秒叫一次。'
          + '这一档适合动作游戏，**不适合访谈/口播/播放器看剧**（那种内容会半天没反应，要切回 normal）。\n'
          + '粘性，一直生效到下次再改；改它要重开采集（约 0.5 秒）。不传就是保持当前档。',
      },
      scene: {
        type: 'boolean',
        description: '**逐帧 / 逐场景模式**，默认关。'
          + '打开后：每留下一个画面就单独给你一张**满幅**图（一张图 = 一个场景，不再拼格），'
          + '并且每换一次画面就叫你一次，你回一句 `say` 说清那是什么。'
          + '`scene:true` 打开，`scene:false` 关掉；**它是粘性的**，一直生效到这轮看完，'
          + '不用每次 watch 都传。\n'
          + '**什么时候才该打开**：用户明确说要"每换一个场景就告诉我"、"每翻一页说一句这是什么"、'
          + '"逐帧播报"、"一个画面一张图"这类要求时。'
          + '**平时一律不要开** —— 每次唤醒 = 一张图 + 一轮模型往返，'
          + '画面每 2 秒换一次就是每分钟 30 次唤醒，很贵，而且用户会嫌你话太多。'
          + '用户没明确这么说，就别传这个参数。',
      },
      say: {
        type: 'string',
        description: 'What you say to the user — **this is the only text they can see and hear**. '
          + 'It goes into their floating window as one bubble and is spoken aloud once. '
          + 'Your normal reply never reaches them. Put two or three sentences in a single `say` '
          + 'instead of calling again just to add more.',
      },
      seconds: {
        type: 'integer',
        description: 'With action:"watch": the **upper bound** of the blocking wait, in seconds (default 300, '
          + 'capped at 860). You normally do not need to touch this: it returns early the moment a sheet '
          + 'fills up (every 15–40s when the screen is changing) or the user types in the floating window. '
          + 'The ceiling only matters when the screen is static — then you simply stay blocked instead of '
          + 'ending your turn, which is exactly right: the blocking call IS the pause.',
      },
      minFrames: {
        type: 'integer',
        description: 'With action:"watch": do not bother returning an image with fewer frames than this '
          + '(default 1). A 1-frame image costs the same as a 4-frame one, so raising this saves tokens '
          + 'when the screen is mostly static.',
      },
      quality: {
        type: 'string',
        description: 'How sharp the image is. "low" (default, 800×450, ≈218 tokens) — 4 frames are 400×225 each, '
          + 'enough for faces/scenes/video but small text is unreadable. '
          + '"standard" (1066×600, ≈388 tokens) — 533×300 per frame, medium text readable. '
          + '"high" (1280×720, ≈559 tokens) — 640×360 per frame, filenames readable. '
          + '"ultra" (1600×900, ≈872 tokens) — a single frame is nearly the real screen; use it only when '
          + '"high" is still not enough.\n'
          + 'Switch it UP as soon as you cannot read something — do not guess from a blurry image. '
          + 'Changing quality restarts the capture (~0.6s) and immediately returns ONE frame of the current '
          + 'screen, so you get the sharp view right away; the following calls stay at that quality.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          images: { type: 'array', items: { type: 'json' } },
          meta: { type: 'json' },
        },
      },
      render(args, value) {
        return [
          ...(value.images ?? []).map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe() {
      return false;   // 会话里只有一个采集进程，并发跑会把两张图交错
    },
  };
}
