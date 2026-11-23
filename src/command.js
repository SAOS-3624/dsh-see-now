/**
 * command.js — `/seenow` 斜杠命令：**用 `/` 直接把悬浮窗叫出来**。
 *
 * ## 为什么要有它
 *
 * 以前这个插件只有工具，没有命令。于是用户想"看一眼屏幕"必须先跟模型说一句
 * "你用 see_now 看一下屏幕"，等它反应过来再调 —— 而宿主里 `/` 菜单是**零成本**的
 * 直达通道：所有内置能力（`/goal`、`/compact`）都在那儿，唯独"看屏幕"不在。
 * 用户的第一反应就是打 `/` 然后发现列表里没有它（社区实报）。
 *
 * ## 它做了什么（和 `see_now` 工具的分工）
 *
 * 命令是**宿主侧**执行的一段代码，它不等模型：
 *   1. 开窗（`openWindow`，幂等）
 *   2. 起采集（`startCapture`，等价于工具的 `action:"start"`）
 *   3. 把常驻循环绑到**发命令的这个会话**（`ensureLoop(会话 id)`）
 *   4. 用 `steer` 投一句话给模型，让它知道"眼睛已经开了，从现在起是 peek 模式"
 *
 * 第 3 步是关键：以前循环的 owner 是"最后说过话的会话"，多开对话时会绑到别人头上；
 * 现在主人是**发起命令的这一个**（`invocation.agent` 就是它）。
 *
 * 全程不提交用户消息，也不消耗一轮模型 —— 命令只是把机器打开。
 *
 * @module command.js
 */

import { deliverToAgent, serviceOf } from './timer.js';

/** 命令名。宿主只接受 `/^[a-z][a-z0-9_-]*$/`（`parseCommand` 的正则），中文进不了名字。 */
export const COMMAND_NAME = 'seenow';

/** 一句话说明（显示在 `/` 菜单里）。 */
export const COMMAND_DESCRIPTION = '打开看屏幕悬浮窗，开始实时看你的屏幕（/seenow off 关掉）';

/** 用法（错误时回给用户）。 */
export const COMMAND_USAGE = `用法：/${COMMAND_NAME} [off|status|show|hide]`;

/** 打开后投给模型的那句话。 */
export const START_NOTE = '[看屏幕] 用户用 `/seenow` 把悬浮窗打开了，采集已经开始跑。\n'
  + '**不要再调 `see_now({action:"watch"})`** —— 那会重新等一张图、还会把循环重置。\n'
  + '从现在起每个新画面会叫醒你一次：调 `see_now({action:"peek"})` 拿图，\n'
  + '然后按需要 `say`（普通回复用户在窗口里看不到，也不会被念）。\n'
  + '用户关窗 = 不看了，循环会自己停。';

/** 关闭后投给模型的那句话。 */
export const STOP_NOTE = '[看屏幕] 用户用 `/seenow off` 关掉了悬浮窗：采集停了、循环也停了。\n'
  + '不要再调 `see_now`，也不要再 `say`（他看不到）。只回一句短的就行。';

/** 把宿主给的 agent 折成会话 id（`Session.header.id`，老版本是 `Session.id`）。 */
export function sessionOfAgent(agent) {
  const session = agent?.session;
  return session?.header?.id ?? session?.id ?? null;
}

/**
 * 「彻底收工」三件套：循环 → 采集 → 悬浮窗。
 *
 * `/seenow off` 与 `see_now({action:"stop"})` **必须**共用这一份实现：
 * 一处关窗、一处留窗，用户看到的就是"命令关了、工具没关"的割裂。而留窗那种更糟 ——
 * 循环没了 = `chat.jsonl` 再没有人消费，窗里打的字回车有反应、永远没有回音（issue #76）。
 *
 * 每一步都吞异常：某一步没在跑，不该拦住后面两步。
 *
 * @returns {{windowClosed:boolean}} 有没有真的去执行关窗（给文案与测试用）
 */
export function shutDownAll(deps = {}, reason = '手动') {
  let windowClosed = false;
  try { deps.stopLoop?.(reason); } catch { /* 没在跑 */ }
  try { deps.stopCapture?.(); } catch { /* 没在跑 */ }
  try {
    if (deps.closeWindow) {
      deps.closeWindow();
      windowClosed = true;
    }
  } catch { /* 已经关了 */ }
  return { windowClosed };
}

/**
 * 构造命令定义（纯对象，方便单测直接调 `handler`）。
 *
 * @param {object} deps - 全部由 `index.js` 注进来，命令自己不去碰 runner/window 的单例
 * @param {(m:string)=>void} [deps.log]
 * @param {(o?:object)=>Promise<{ok:boolean, reason?:string, already?:boolean}>} deps.openWindow
 * @param {()=>void} deps.closeWindow
 * @param {(hidden:boolean)=>void} deps.setWindowHidden
 * @param {()=>Promise<object>} deps.startCapture
 * @param {()=>void} deps.stopCapture
 * @param {(owner:string|null)=>object} deps.ensureLoop
 * @param {()=>object} deps.getLoop
 * @param {(reason:string)=>void} deps.stopLoop
 * @param {()=>string} deps.statusText
 */
export function createSeenowCommand(deps = {}) {
  const log = deps.log ?? (() => {});
  const caller = () => deps.getCaller?.() ?? null;

  async function open(onAgent) {
    const win = await deps.openWindow?.({ log });
    if (win && win.ok === false && win.reason !== 'disabled') {
      return { kind: 'error', text: `悬浮窗没开起来：${win.reason ?? '原因未知'}` };
    }
    // 窗可能上次被"最小化到托盘"了（配置里 hidden:true）。开命令的语义是"我要看见它"。
    try { deps.setWindowHidden?.(false); } catch { /* 写不进配置也不影响这一次 */ }

    let started = null;
    try { started = await deps.startCapture?.(); } catch (e) { started = { error: String(e?.message ?? e) }; }
    if (started?.error) {
      return { kind: 'error', text: `采集没起来：${started.error}` };
    }

    const owner = sessionOfAgent(onAgent) ?? caller();
    let loop = null;
    try { loop = deps.ensureLoop?.(owner) ?? null; } catch (e) { loop = null; log(`/seenow 起循环失败：${e?.message ?? e}`); }

    // 让模型知道"眼睛开了"。**必须是 steer**：它可能正在跑别的活，排队要等到这一轮结束。
    const said = deliverToAgent(onAgent, START_NOTE);

    const bits = [
      '悬浮窗已打开，开始看屏幕。',
      started?.already ? '（采集本来就在跑）' : '',
      loop ? '循环已绑到本会话。' : '⚠️ 循环没起来（看 `see_now({action:"status"})` 的诊断）。',
      said?.ok ? '' : `⚠️ 没能叫醒本会话（${said?.reason ?? '未知'}）。`,
    ].filter(Boolean);
    return { kind: 'success', text: bits.join('') };
  }

  function off(onAgent) {
    shutDownAll(deps, '/seenow off');
    const said = deliverToAgent(onAgent, STOP_NOTE);
    return {
      kind: 'success',
      text: `悬浮窗已关闭，采集和循环都停了。${said?.ok ? '' : `（没能叫醒本会话：${said?.reason ?? '未知'}）`}`,
    };
  }

  return {
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    // 命令不接受附件：带图提交会走宿主统一的拒绝路径
    input: { hint: '[off|status|show|hide]' },
    handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim().toLowerCase();
      const onAgent = invocation?.agent ?? null;
      try {
        if (raw === '' || raw === 'on' || raw === 'watch' || raw === 'start') return open(onAgent);
        if (raw === 'off' || raw === 'close' || raw === 'stop') return off(onAgent);
        if (raw === 'show') {
          deps.setWindowHidden?.(false);
          return { kind: 'success', text: '已让悬浮窗显示出来。' };
        }
        if (raw === 'hide') {
          deps.setWindowHidden?.(true);
          return { kind: 'success', text: '已把悬浮窗最小化到托盘（采集照常）。' };
        }
        if (raw === 'status') {
          return { kind: 'success', text: deps.statusText?.() ?? '（没有状态可报）' };
        }
        return { kind: 'error', text: COMMAND_USAGE };
      } catch (e) {
        return { kind: 'error', text: `/seenow 出错：${String(e?.message ?? e)}` };
      }
    },
  };
}

/**
 * 注册 `/seenow`。
 *
 * **拿不到 `commands` 服务就安静地跳过**：这个插件在 headless / 老宿主上也要能加载，
 * 为了一个可选入口让整棵树挂掉是最糟的取舍。返回 `null` 表示"没注册"。
 *
 * @param {object} ctx
 * @param {object} deps - 见 `createSeenowCommand`
 * @returns {(()=>void)|null} dispose
 */
export function registerSeenowCommand(ctx, deps = {}) {
  const commands = serviceOf(ctx, 'commands');
  if (!commands || typeof commands.register !== 'function') return null;
  const dispose = commands.register(createSeenowCommand(deps));
  return typeof dispose === 'function' ? dispose : () => {};
}
