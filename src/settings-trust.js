/**
 * 设置页接口的信任栅栏。
 *
 * ## 谁在做认证
 *
 * 内核。`dsh-host-webserver` 的 `authPolicy()` 是 `auth ?? "required"` —— 路由不声明
 * `auth` 就等于要认证。`authorize()` 在调用 handler **之前**就跑完准入，拒绝时直接回
 * 401 / 403 / 503，handler 根本不会被调用：
 *
 * ```js
 * const admission = this.authorize(request, responder.auth);
 * if (admission.kind === "deny") { … res.end("authentication unavailable") … return; }
 * await responder.handler(req, res, admission.peer);
 * ```
 *
 * 所以**既然 handler 进来了，身份就已经确认过了**，`peer` 就是那个证据。这里该做的是
 * 接住它，而不是重新判一遍。
 *
 * ## 这里判什么
 *
 * 1. **有 `peer`** → 放行。内核刚认证过；再叠一层更弱的判据只会更不安全。
 * 2. **没有 `peer`** → 宿主没有认证机制（rc.1 的 webServer 只认 `kind`/`path`/`handler`，
 *    `auth` 是被忽略的未知字段）。那种宿主里所有 loopback 请求同权，此时来源栅栏是
 *    **当时能拿到的最强保护**：Host 必须 loopback（防 DNS rebinding）、不许跨站 fetch、
 *    带了 Origin 就必须同源。判不过就拒。
 *
 * ## 曾经错在哪
 *
 * 早先版本自己调 `connection.admit()`，抛错时退到来源栅栏**并放行**。问题是来源栅栏
 * 只能证明「请求来自本机」，不能证明「调用者是谁」；那样等于把内核刚做完的身份认证
 * 扔掉，换成一个更弱的判据。而且测试把这种放行写成了预期，于是它一直是绿的。
 *
 * @module src/settings-trust.js
 */

/** 同机调用方可能合法使用的地址。IPv6 的 `URL.hostname` 带方括号。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** 把 Host / Origin / Referer 拆成 `{scheme, hostname, port}`，端口按协议补默认值。 */
function authority(value, fallbackScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : `${fallbackScheme ?? 'http'}://${value.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

/** 桌面版把页面从 `dsh-app://app` 转发到 loopback 时会留下这个 Referer。 */
function isDesktopRelay(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'dsh-app:' &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/** 两个 authority 是不是同一个（协议、主机、端口都要对上）。 */
function sameAuthority(a, b) {
  return a.scheme === b.scheme && a.hostname === b.hostname && a.port === b.port;
}

function hasHeader(headers, name) {
  const raw = headers[name];
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * 复刻内核的 `isTrustedApiRequest`。
 *
 * 返回 `{code}` 表示拒绝，或 `undefined` 表示放行。code 只用固定文案，不回显调用方
 * 输入 —— 免得把一个可控字符串原样送回去。
 */
function structuralVerdict(req) {
  const headers = req?.headers ?? {};
  const host = authority(headers.host, 'http');
  if (host === null) return { code: 'no-host' };
  if (!LOOPBACK_NAMES.has(host.hostname)) return { code: 'host-not-loopback' };
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return { code: 'cross-site' };

  // Origin 是授权依据：有它就必须同源，解析不出 scheme 也拒。
  if (hasHeader(headers, 'origin')) {
    const origin = authority(headers.origin.trim());
    if (origin === null) return { code: 'origin-invalid' };
    if (!sameAuthority(origin, host)) return { code: 'origin-mismatch' };
  }

  // Referer 只是线索。桌面转发留下的 `dsh-app://app` 不是跨站证据 —— 它和
  // `Sec-Fetch-Site` 同时出现很正常（Chromium 自动加），曾经因为这一点拒掉了
  // 每一个从 Electron 窗口发出的合法请求。
  if (hasHeader(headers, 'referer')) {
    if (isDesktopRelay(headers.referer.trim())) {
      // Origin 说来自 loopback、Referer 说来自 dsh-app，两者矛盾才有问题。
      if (hasHeader(headers, 'origin')) return { code: 'desktop-relay-with-origin' };
    } else {
      const referer = authority(headers.referer.trim());
      if (referer === null) return { code: 'referer-invalid' };
      if (!sameAuthority(referer, host)) return { code: 'referer-mismatch' };
    }
  }

  return undefined;
}

/**
 * 判定一个请求该不该放行，并给出拒绝的来路。
 *
 * @param req - `node:http` 的 IncomingMessage。
 * @param peer - 内核认证后交给 handler 的 `peer`。有它就说明身份已确认。
 * @returns `{ok: true, path: 'peer' | 'legacy'}` 放行；`{ok: false, status, code}` 拒绝。
 */
export function assessRequest(req, peer) {
  // 内核认证的产物。`admission.peer` 是在 handler 之前由 `authorize()` 填的，
  // 有它就等于「这一位是谁」已经被回答过了。
  if (peer !== undefined && peer !== null) return { ok: true, path: 'peer' };

  // 宿主没有认证机制。此时「谁」无从谈起，只能退到「从哪儿来」。
  const verdict = structuralVerdict(req);
  if (verdict !== undefined) return { ok: false, status: 403, code: verdict.code };
  return { ok: true, path: 'legacy' };
}

/**
 * 只要状态码的老接口。
 *
 * @returns `undefined` 表示放行，否则是要回的 HTTP 状态码。
 */
export function rejectionFor(req, peer) {
  const verdict = assessRequest(req, peer);
  return verdict.ok ? undefined : verdict.status;
}
