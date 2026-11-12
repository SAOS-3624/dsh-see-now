# 子代理上下文治理：一条省钱的思路 + 独立模块 + 实测数据

> 这份文档不改 peek/capture 链，只给一条「思路 + 一个能独立引用的最小模块 + 一组实测数据」。
> 结论先摆这：**省钱的杠杆不在图片像素，在上下文治理**。图片已经压到 222 token 一张了，再压没意义；真正吃钱的是「图堆进主会话历史，越看越贵」这条线，而这条线可以在插件里绕过去。

---

## 1. 问题：see-now 现在「看久了会变贵」的根因

你已经在 README 的「看久了会变贵」那节把根因写得很准了，我复述一遍是为了对齐口径，不是为了纠正：

1. 每张图进会话历史是一段 base64，一张 798×450 的 PNG 约 130 KB、base64 后约 **173 KB**。
2. DSH 在「单个请求里保留的 base64 图片总量超过 `maxRequestImageBytes`（默认 20 MiB）」时，会**永久**把最老的图替换成占位文字——改的是会话历史本身。
3. 历史一改，DeepSeek 的前缀缓存从被改的位置往后全部对不上，那一段上下文重新计费。
4. 20 MiB ÷ 173 KB ≈ 120 张，默认节奏一小时上下就撞线。

而你自己下的结论是「**这个插件拦不住它**：省略发生在宿主发请求之前，插件只看得到自己交付的那张图」。这句对了一半——「省略」发生在宿主侧，确实拦不住；但「图要不要进主会话历史」这个决定，**是插件自己做的**。see-now 现在用 `attachAndReturn` 把图 `saveImage` 后作为工具结果返回，图就进了调用它的那个主会话；`offload.js` 再想办法把老图从历史里抠出去。

这里有个绕不开的死结，你其实已经在 `offload.js` 的注释里写到了：

> 追加事件会改历史 → 前缀缓存从第一条被省略的消息起失效 → 一次性全量重算。

也就是说，offload 这条路的本质是：**图先堆进历史（贵），再在历史中间挖洞省略（又贵一次）**。它是「事后补救」，救的是「已经堆进去的图」，而不是「别让它堆进去」。

我们要给的是另一条路：**图压根不进主会话历史**。

---

## 2. 方案：一次性子代理上下文治理

核心就三步：

1. 陪看每次「看一眼」时，不起主会话回合，而是起一个**一次性子代理**（one-shot subagent），图片直接塞进它的 prompt，用完就 dispose。
2. 选一个 `inheritsParentContext === false` 的 provider，这样子代理**不继承主会话的几十万 token 历史**，它只看到「一张图 + 一段提示词」。
3. 用一个**精简 agentPreset**（我们内部叫 `peek`）：无工具、无技能、无运行时上下文，persona 只有一句话。
4. 子代理只回**一句结论**，写进字幕条 / 文件，**不回灌主会话**。回灌等于把主会话叫醒一轮，省下的钱又吐回去。

关键不是「图片变便宜」，是「**带图的那次请求，上下文从几十万 token 缩到两万二**」。

### 为什么 `delivery` / `caller` 这类「看起来像隔离」的开关没用

这是三脚猫最容易踩的坑，我们实打实踩过：

- `delivery: 'parent'`：子代理的汇报和完成通知**各**触发一次主会话回合，一次唤醒塞两条通知，**更贵**。
- `delivery: 'caller'`：会话里看不到回合了（噪音没了），但**上下文没切断**，钱照花——只是「看不到花在哪」。

真正起作用的那一个判断，是**按 `inheritsParentContext === false` 选 provider**，不是按名字猜 provider，也不是调 `delivery`。

---

## 3. 关键代码片段（示意级，字段名以宿主实际 API 为准）

不贴我们 fork 里的私有实现，只讲清三个要点。变量命名贴你的风格（`ctx` / `serviceOf` / 中文注释）：

```js
/**
 * peek 精简预设 —— 子代理只看「一张图 + 一段提示词」。
 * 无工具、无技能、无运行时上下文，persona 只有一句话。
 * 这是把 8 万 token 压到 2 万出头的关键，不是可有可无的优化。
 */
const PEEK_PRESET = {
  id: 'peek',
  tools: [],            // 一个工具都不带：子代理不需要调用任何东西
  skills: [],           // 技能目录也不带
  runtimeContext: null, // 不注入主会话的项目规则 / 记忆
  persona: '你正在看用户屏幕的一帧，用一句话说出值得提醒或可聊的点。没判断就说「没什么想说的」。',
};

/**
 * 从宿主提供的 provider 里挑一个「不继承父上下文」的。
 * 不要按名字猜（名字在不同宿主版本里会变），按字段判断。
 */
function pickCleanProvider(ctx) {
  const subs = ctx?.subagents;
  if (!subs?.getProvider) return null;
  for (let i = 0; ; i++) {
    const p = subs.getProvider(i);
    if (!p) break;
    if (p.inheritsParentContext === false) return p;
  }
  return null; // 宿主一个「隔离」provider 都没有时，降级回主会话（或直接停）
}

/**
 * 看一眼：图直塞一次性子代理，结论写进字幕/文件，不回灌主会话。
 * 示意 —— startActivation 的参数形状以宿主实际签名为准。
 */
async function peekOnce(ctx, imageRef, promptText) {
  const provider = pickCleanProvider(ctx);
  if (!provider) return { ok: false, reason: 'no-isolated-provider' };

  const result = await ctx.subagents.startActivation({
    provider: provider.id,
    preset: PEEK_PRESET,
    // 图直接进子代理的 prompt，不进主会话历史
    prompt: [imageRef, promptText],
    // 结论走文件/字幕，NOT 回灌主会话（回灌 = 又把主会话叫醒一轮）
    delivery: 'file',          // 示意：往约定的文件写一句，主会话不产生回合
  });

  // 用完即弃，别留着子代理会话占上下文
  await result.dispose?.();
  return { ok: true, text: result.output };
}
```

三个要点，缺一个都不成立：

| 要点 | 为什么必须 |
|---|---|
| `inheritsParentContext === false` | 不继承主会话历史，这是「几十万 token → 几万 token」的前提 |
| 精简 preset（无工具/无技能/无运行时） | 否则新会话仍有 8 万 token 的「系统提示 + 工具表 + 技能目录」固定开销 |
| 不回灌主会话 | 回灌一条消息 = 主会话多一轮，省的钱全吐回去 |

---

## 4. 实测数据（三轮迭代的完整链条）

测试环境：dsh-whale-sense 陪看插件，DeepSeek 系模型，星际争霸 II 真实对局。三轮迭代，每轮只改一个变量。

| 版本 | 单次唤醒成本 | 原因 |
|---|---|---|
| 旧版（子代理继承父上下文） | **约 4 分** | 每次带主会话几十万 token 历史 |
| `delivery: 'parent'` | **约 1 毛 2** | 双通知，每条各触发一次主会话回合，比旧版更贵 |
| `delivery: 'caller'` | **约 2.8 分** | 没切断上下文，钱照花，只是会话里看不到回合 |
| `inheritsParentContext === false` | 前六次几十万 token → 后稳定 **8 万 token** | 8 万那个底是「新会话固定开销」：系统提示 + 工具表 + 技能目录 |
| + `peek` 精简预设 | **约 2.2 万 token ≈ 7 厘** | 把 8 万里的工具表 + 技能目录 + 运行时上下文全砍掉 |

三个硬结论（都是拿 `.dshw-usage.json` 账本对唤醒次数算出来的，不是拍脑袋）：

1. **`delivery: 'caller'` 没有切断上下文**。真正见效的是 `inheritsParentContext === false` 选 provider。
2. **8 万 token 那个底跟陪看无关**，是「系统提示 + 工具表 + 技能目录」。`peek` 预设把它们全砍掉，才到 2.2 万。
3. **2.2 万里，图片只占一两千 token，剩下是模型底层固定开销。**

### 为什么「砍图片像素」这条路走不通（这可能是你最有用的那一条）

我们专门测过：**图片从 1280 宽砍到 800 宽、体积降 47%，token 只降 1.5%**（22,693 → 22,351）。

也就是说，see-now 已经把单张图片编码成本压到 222 token，这个方向到头了——**再压图片，省的是那一两千 token 里的一小半，省不到整次请求的大头**。大头是「带图的那次请求到底带了多少上下文」。

你算的「222 token」是**单张图片编码成本**的口径（patch 网格）；我们算的「2.2 万 token」是**整次唤醒总成本**（含模型底层前缀）。两个不冲突，正好拼成完整图景：图片你已经做到极致，剩下该动的是上下文那侧。

---

## 5. 独立最小示例模块（可放 `examples/peek-agent.mjs` 的形态）

下面是给你参考怎么接的最小形态，不依赖我们 fork 的任何东西，也不改你的 `src/`。它演示「抓一帧 → 起隔离子代理 → 结论写文件」这条闭合链路。**具体 `ctx.subagents` 的 API 名以你手上宿主版本为准**，这里按字段语义写，方便你对着宿主实现调。

```js
/**
 * examples/peek-agent.mjs — 最小示例：用一次性子代理「看一眼」，图不进主会话。
 *
 * 跑法（示意）：在 DSH 插件里 import 后，抓屏路径换成你自己的 capture 输出。
 * 核心要讲清的就三件事：
 *   1. provider 按 inheritsParentContext === false 选，不按名字猜；
 *   2. preset 精简到无工具 / 无技能 / 无运行时上下文；
 *   3. 结论写文件（或字幕），不回灌主会话。
 */

const PEEK_PRESET = {
  tools: [],
  skills: [],
  runtimeContext: null,
  persona: '看用户屏幕的一帧，一句话说值得提醒或可聊的点；没判断就说「没什么想说的」。',
};

function pickIsolatedProvider(ctx) {
  const subs = ctx?.subagents;
  if (!subs?.getProvider) return null;
  for (let i = 0; ; i++) {
    const p = subs.getProvider(i);
    if (!p) return null;
    if (p.inheritsParentContext === false) return p;
  }
}

/**
 * @param {object} ctx       宿主注入的插件上下文
 * @param {object} imageRef  一张图的引用（宿主 attachments 的 ref，或 base64 data）
 * @param {string} promptText 给子代理的那句话
 * @param {string} outPath    结论写哪个文件（字幕条 / 歌词条读同一个文件）
 */
export async function peekOnce(ctx, imageRef, promptText, outPath) {
  const provider = pickIsolatedProvider(ctx);
  if (!provider) {
    return { ok: false, reason: 'no-isolated-provider' };
  }

  const activation = await ctx.subagents.startActivation({
    provider: provider.id,
    preset: PEEK_PRESET,
    prompt: [imageRef, promptText],
    // 关键：不让子代理的完成通知落回主会话。字段名按宿主实现调。
    notifyParent: false,
  });

  const text = activation?.output ?? '';

  // 结论落到文件，主会话不产生回合；字幕/歌词条读这个文件
  if (outPath && text) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(outPath, text, 'utf8');
  }

  await activation?.dispose?.(); // 用完即弃
  return { ok: true, text };
}
```

接进 see-now 时，`imageRef` 就是你 `attachAndReturn` 里 `saveImage` 出来的那个 ref，`promptText` 就是你 `sheetText` 生成的那段「这期间屏幕怎么动」的说明——**省掉的是「把图作为工具结果塞回主会话」这一步**，换成「塞给一次性子代理」。

---

## 6. 边界与代价（得说清，别让作者误以为是白嫖）

1. **子代理不继承上下文 = 每次都是「失忆」的。** 它只看这一张图 + 一段提示词，不知道上一张图、不知道你们在聊什么。所以「跨帧的连续判断」（「这已经是第三次矿气堆着没花了」）它做不了，除非你自己把「最近 3–5 句结论」塞进 prompt。
2. **记忆得靠回写接上。** 结论写文件/字幕，但「陪看的记忆」要落在**主会话**里——用户回主会话问「刚才那局怎么样」，得能答上。所以不是「完全不碰主会话」，是「子代理干活时不碰，结论以文字形式有选择地落进主会话历史」。文字比图片便宜得多，这是它和「图堆历史」的本质区别。
3. **依赖宿主的 provider 能力。** `inheritsParentContext === false` 的 provider 不是每个宿主/每个版本都有。`pickIsolatedProvider` 返回 null 时要有降级路径（退回主会话，或者干脆停，别假装隔离成功）。
4. **2.2 万是模型的底价，不是提示词的锅。** 我们砍到 `deepseek-flash` + `peek` 预设之后，2.2 万里图片只占一两千，剩下是模型底层固定开销。**再往下只能换模型或砍频率，不能靠改提示词。**
5. **去重/质量控制不在这套里。** 我们的实测还暴露了「同一判断隔一条就重来」的去重问题、拼图 HUD 数字读不出、UI 遮挡误触发等，那些是另一摊事，和「上下文治理」正交。

---

## 附：我们为什么用这套，而不是改进 offload

不是你的 `offload.js` 写得不好——它把「省略」这件宿主只留了口子的事做得很完整（触发线/留底分开、surface 重放、`image/offload` 事件）。它省的是「历史里已经堆进去的图」。

我们的分歧在更上游：**图到底该不该进主会话历史。** 我们的答案是「不该」——带图的那次请求用一次性子代理扛下来，图用完即弃，主会话历史里根本不出现图，自然不用「省略」、也不会触发前缀缓存中间挖洞的问题。

所以这不是「替代 offload」，是「让 offload 在大多数场景下变成不需要」。真到了必须往主会话交大图的场景（比如用户主动要保存这一帧看），offload 那套照样有价值。

---

*数据来源：`陪看-上下文治理-测试报告.md`（三轮实测，2026-11-10）与 `余光-需求与现状.md`「成本降下来的完整链条」一节。所有数字为真实测值，非估算；API 字段名因宿主版本而异，代码均为示意级。*
