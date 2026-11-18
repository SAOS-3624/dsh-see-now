/**
 * 设置页背后的三条路由，全在 `/api/see-now/` 下。
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET  | `/status` | 当前生效的值、默认值、文件路径、校验警告 |
 * | POST | `/config` | 提交要改的键；校验通过才落盘（`see-now.json`） |
 * | POST | `/local`  | 改转写服务的地址与凭据（`asr.json`） |
 * | GET/POST | `/window` | 看/改悬浮窗外观（`watch-window.json` 的 `glass`） |
 *
 * ## 为什么这么几条
 *
 * 这套配置没有长任务 —— 没有安装、没有下载、没有子进程。读一次文件、写一次文件
 * 都是毫秒级，用不着 ui-locate 那种「POST 起任务 + GET 轮询进度」的形状。
 *
 * ## 为什么拒写也回 200
 *
 * "值越界"是业务上的拒绝，不是请求格式错误：请求本身完全合法，用户的心智模型是
 * 「它没接受我的数」，而不是「网络/接口坏了」。前端拿到 `{ok:false, rejected:[…]}`
 * 直接把原因显示在输入框下面，不用先判 HTTP 状态再解析 body。
 *
 * @module src/settings-api.mjs
 */

import { assessRequest } from './settings-trust.js';
import { asrPath, readAsrConfig, writeAsrConfig } from './asr-store.mjs';
import { readWindowStyle, setWindowStyle, setWindowHidden, setWindowDanmaku } from './window.js';
import {
  readTuning,
  writeTuning,
  tuningPath,
  TUNING_DEFAULTS,
  LISTEN_DEFAULTS,
  PACES_KEYS,
  WRITABLE_KEYS,
  WRITABLE_LISTEN_KEYS,
} from './tuning.js';

/** 与 `client.js` 里的 `API` 常量必须一致。 */
export const ROUTE_PREFIX = '/api/see-now';

/**
 * 退回来源栅栏这件事只报一次日志。
 *
 * 挂在这里而不是 `createSettingsApi` 里面：`/status` 会被面板反复调用，逐条写
 * 只会把那句话淹掉，反而看不见。
 */
let legacyLogged = false;

/**
 * 现在站的是哪条闸。
 *
 * `peer` 是内核认证后交过来的身份，`legacy` 是宿主没有路由认证机制时退的来源栅栏。
 * 后者是兜底，不该悄悄变成常走的路 —— 所以退到它的时候会记一次日志，也会显示在面板上。
 */
function trustOf(verdict) {
  return { path: verdict.path };
}

/** 拒绝时给用户看的话：每一句都指向「该去查什么」。 */
const TRUST_HINTS = {
  'no-host': '请求里没有 Host 头',
  'host-not-loopback': 'Host 不是 loopback 地址',
  'cross-site': 'Sec-Fetch-Site 是 cross-site',
  'origin-invalid': 'Origin 解析不出 http(s)',
  'origin-mismatch': 'Origin 与 Host 不同源',
  'referer-invalid': 'Referer 解析不出 http(s)',
  'referer-mismatch': 'Referer 与 Host 不同源',
  'desktop-relay-with-origin': '同时带了 Origin 与 dsh-app 转发的 Referer，两者互相矛盾',
};

/** 面板提交的 JSON 不该有大请求体；给足富余但仍设上限。 */
const BODY_LIMIT = 32 << 10;

/** 给前端的默认值。派生的 `idleStopMs` 也补上，省得前端自己乘 60000。 */
function defaultsPayload() {
  return {
    ...TUNING_DEFAULTS,
    idleStopMs: TUNING_DEFAULTS.idleStopMin * 60 * 1000,
    listen: { ...LISTEN_DEFAULTS },
  };
}

/** `baseUrl` → `DSH_ASR_BASE_URL`。给面板标出"这个值正被环境变量盖着"。 */
function envKeyOf(name) {
  return `DSH_ASR_${name.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`;
}

/**
 * `asr.json` 的现状 —— 面板上「转写服务」到底指哪个文件、里面写了什么。
 *
 * 文件在 `$DSH_HOME/asr.json`，与 video-storyboard 共用一份。两个插件都读它，
 * 所以面板既能看也能改（只动认得的键，别的键原样留着）。
 */
function localPayload() {
  const info = readAsrConfig(asrPath(tuningPath()));
  // 环境变量优先于文件。面板要能把"你改的那个文件没生效"说出来。
  const envKeys = ['api', 'baseUrl', 'key', 'model', 'language'].filter(
    (k) => Boolean(process.env[envKeyOf(k)]),
  );
  return { ...info, envOverrides: envKeys.length > 0, envKeys };
}

/** 把 `readTuning()` 的结果拆成「值」与「警告」两半 —— 前端要分开用。 */
function valuesOf(tuning) {
  const { warnings, path, ...values } = tuning;
  return values;
}

export function createSettingsApi({ logger } = {}) {
  function log(line) {
    try {
      logger?.info?.(line);
    } catch {
      /* 记日志失败不该影响接口 */
    }
  }

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};
    return JSON.parse(text);
  }

  /** `{patch}` 包一层，理由见 `/config` 里的注释。 */
  async function patchOf(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      send(res, 400, { ok: false, rejected: [`请求体不是合法 JSON：${err?.message ?? err}`] });
      return undefined;
    }
    const patch = body && typeof body === 'object' ? body.patch : undefined;
    if (patch === undefined) {
      send(res, 400, { ok: false, rejected: ['缺少 patch'] });
      return undefined;
    }
    return patch;
  }

  return async function handle(req, res, peer) {
    // 内核在调用我们之前就做完准入（路由不声明 auth 就等于 required），拒绝时
    // handler 根本不会进来。所以 `peer` 在这里的身份是「身份已经被回答过」的证据，
    // 只有它缺席（宿主没有路由认证）时才退到来源栅栏。
    const verdict = assessRequest(req, peer);
    if (verdict.path === 'legacy' && !legacyLogged) {
      legacyLogged = true;
      // 只报一次：旧宿主上每个请求都会走到这里，逐条写日志只会把它淹掉。
      log('see-now: 这个宿主没有路由认证，设置接口退回来源栅栏判定');
    }
    if (!verdict.ok) {
      send(res, verdict.status, {
        ok: false,
        rejected: [TRUST_HINTS[verdict.code] ?? '请求不被信任'],
        code: verdict.code,
      });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      send(res, 400, { ok: false, rejected: ['请求路径无法解析'] });
      return;
    }

    const route = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname;
    const method = String(req.method ?? 'GET').toUpperCase();

    try {
      if (route === '/status') {
        if (method !== 'GET' && method !== 'HEAD') {
          send(res, 405, { ok: false, rejected: ['只支持 GET'] });
          return;
        }
        const tuning = readTuning();
        send(res, 200, {
          ok: true,
          path: tuning.path,
          values: valuesOf(tuning),
          defaults: defaultsPayload(),
          paces: PACES_KEYS,
          writable: { keys: WRITABLE_KEYS, listen: WRITABLE_LISTEN_KEYS },
          local: localPayload(),
          // 现在站的是哪条闸：peer（内核认证过的身份）或 legacy（宿主没有路由认证时退的来源栅栏）
          trust: trustOf(verdict),
          // 悬浮窗样式在另一个文件（watch-window.json），和上面那套互不影响
          window: readWindowStyle(),
          warnings: tuning.warnings,
        });
        return;
      }

      if (route === '/config') {
        if (method !== 'POST') {
          send(res, 405, { ok: false, rejected: ['只支持 POST'] });
          return;
        }
        // 包一层 `patch` 而不是整个 body 当补丁：以后加 `dryRun` 之类的元数据时
        // 不用改协议，也不会把元数据误当成配置键。
        const patch = await patchOf(req, res);
        if (patch === undefined) return;

        const result = writeTuning(patch);
        if (result.ok) log(`see-now: 配置已写回 ${result.path}`);
        else log(`see-now: 配置被拒 ${JSON.stringify(result.rejected)}`);

        // 回包给的是**写完之后文件里的完整快照**，不是 `writeTuning().values` ——
        // 后者按"规矩 3"只含这次提交的键，前端拿它当整份配置重建草稿时，
        // 只改 `idleStopMin` 就会让 `values.listen` 整段消失（草稿读它直接抛错）。
        const after = readTuning();
        send(res, 200, {
          ok: result.ok,
          path: after.path,
          values: valuesOf(after),
          warnings: result.warnings,
          rejected: result.rejected,
        });
        return;
      }

      if (route === '/local') {
        if (method !== 'POST') {
          send(res, 405, { ok: false, rejected: ['只支持 POST'] });
          return;
        }
        const patch = await patchOf(req, res);
        if (patch === undefined) return;

        const result = writeAsrConfig(patch, { path: asrPath(tuningPath()) });
        if (result.ok) log(`see-now: 转写服务配置已写回 ${result.path}`);
        else log(`see-now: 转写服务配置被拒 ${JSON.stringify(result.rejected)}`);

        send(res, 200, {
          ok: result.ok,
          path: result.path,
          local: localPayload(),
          rejected: result.rejected,
        });
        return;
      }

      if (route === '/window') {
        if (method === 'GET' || method === 'HEAD') {
          send(res, 200, { ok: true, window: readWindowStyle() });
          return;
        }
        if (method !== 'POST') {
          send(res, 405, { ok: false, rejected: ['只支持 GET / POST'] });
          return;
        }
        const patch = await patchOf(req, res);
        if (patch === undefined) return;

        // 只校验传来过的键：`setWindowStyle(undefined)` 会返回"样式不合法"，
        // 那样只改弹幕也会被一个不相干的错误拦住。
        let result = { ok: true, rejected: [] };
        if (patch.style !== undefined) {
          result = setWindowStyle(patch.style, { log });
          if (result.ok) log(`see-now: 悬浮窗样式 → ${result.style}`);
        }
        // 最小化 / 弹幕：和样式一样是"改完 250ms 生效"的键，走同一个接口，
        // 少一套路由就少一处不同步（两个键各有自己的合法值，分别校验）。
        let rejected = result.rejected ?? [];
        let modeResult = null;
        if (patch.mode !== undefined) {
          const want = String(patch.mode ?? '').trim().toLowerCase();
          if (want !== 'full' && want !== 'hidden') rejected = [...rejected, 'mode 必须是 full / hidden'];
          else modeResult = setWindowHidden(want === 'hidden', { log });
        }
        let danmakuResult = null;
        if (patch.danmaku !== undefined) danmakuResult = setWindowDanmaku(Boolean(patch.danmaku), { log });
        const ok = rejected.length === 0
          && result.ok !== false
          && (modeResult?.error === undefined)
          && (danmakuResult?.error === undefined);
        send(res, 200, {
          ok,
          window: readWindowStyle(),
          rejected,
        });
        return;
      }

      send(res, 404, { ok: false, rejected: [`没有这条路由：${route}`] });
    } catch (err) {
      // 兜底：任何未预料的异常都要变成一条结构化的答复，而不是断掉的连接 ——
      // 前端在等 JSON，连接一断它只会显示"网络错误"，真正的原因就丢了。
      log(`see-now: 接口异常 ${err?.stack ?? err}`);
      send(res, 500, { ok: false, rejected: [String(err?.message ?? err)] });
    }
  };
}
