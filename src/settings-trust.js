/**
 * 设置页接口的信任栅栏。
 *
 * ## 为什么不能省
 *
 * 本插件注册的前缀是 `/api/see-now`，比内核自己的 `/api` 长，而 webServer 的分发
 * 规则是「最长前缀优先」。也就是说**这些请求根本不经过内核的准入检查** ——
 * 不设防的话，任何能连到 loopback 的进程都能改用户的 `see-now.json`。
 *
 * ## 两层，按序尝试
 *
 * 1. 组合里有 `connection` 服务时，问它要判定结果 —— 那就是内核给自身 `/api` 用的
 *    同一套（信任栅栏 + 浏览器认证 cookie）。
 * 2. 没有这个服务时，用一份结构等价的复刻：Host 必须是 loopback（防 DNS rebinding）、
 *    不许跨站 fetch、客户端带了 Origin 就必须与 Host 同源。
 *
 * ## 内核放行就是放行
 *
 * 第一层通过之后，**不再跑第二层**。这条曾经是反的：内核说没问题，复刻又判一遍，
 * 判不过是它自己的判据过时了 —— 结果是合法请求被 403，而且回给前端的只有一句
 * 「请求不被信任」，连是 401 还是 403 都看不出来。
 *
 * 复刻是「没有内核时也能防」的兜底，不是「比内核更严」的第二道闸。后者只会让
 * 升级后的 header 变化变成一次不明原因的故障。
 *
 * ## 内核自己坏掉时
 *
 * 实测（2026-11-17）：`admit()` 内部会访问 `connection` fiber 里未注入的
 * `authentication`，于是每次调用都抛 `cannot get property
 * "connection.authentication" without inject`。那是内核的依赖缺口，修在插件侧只能
 * 换个地方再撞一次。所以**降级**到复刻判据并留下原话，而不是把用户挡在门外。
 *
 * 降级不是拆闸：Host / cross-site / Origin 同源三项照判，代价只是不再借用内核的
 * 会话认证。
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
 * 内核抛的异常压缩成一行，随降级结果一起回给前端。
 *
 * 不加这个，前端只能看到「内核的准入检查自己抛了错」——正确，但无法据以行动。
 * 抛出点可能是 `admit` / `requestRejection` 里的任何一步（取服务、读 cookie、
 * 解析 Host），三种原因对应的修法完全不同。
 */
function describeError(e) {
  if (e === null || e === undefined) return 'thrown value is ' + String(e);
  const name = typeof e?.name === 'string' ? e.name : typeof e;
  const message = typeof e?.message === 'string' ? e.message : String(e);
  return `${name}: ${message}`;
}

/**
 * 内核那道闸自己抛了错时，退到复刻判据。
 *
 * 复刻比内核少了「浏览器认证」这一层，但 Host / cross-site / Origin 同源三项照判，
 * 而面板只监听 loopback、只写 see-now.json 与 asr.json。**降级的代价是不再借用
 * 内核的会话认证，不是「谁都能改」。**
 */
function degrade(req, e) {
  const verdict = structuralVerdict(req);
  if (verdict !== undefined) return { ok: false, status: 403, code: verdict.code };
  return { ok: true, degraded: describeError(e) };
}

/**
 * 判定一个请求该不该放行，并给出拒绝的来路。
 *
 * @param req - `node:http` 的 IncomingMessage。
 * @param connection - 组合里的 `connection` 服务；没有则走复刻栅栏。
 * @returns `{ok: true}` 放行（可能带 `degraded`）；`{ok: false, status, code}` 拒绝。
 *   `code` 形如 `kernel-401` / `kernel-403`（内核说的）或 `host-not-loopback`（复刻说的）。
 */
export function assessRequest(req, connection) {
  // 服务存在时的两种拼法：新版是 `admit` 返回 `{rejection}`，0.1.7 之前是
  // `requestRejection` 直接返回状态码。读错一次就会把每个请求都判成 503。
  const admit = connection?.admit;
  if (typeof admit === 'function') {
    try {
      const admission = admit.call(connection, req);
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined;
      // 内核放行就是放行。再跑一遍复刻，只会让过时的判据否决合格的请求。
      return status === undefined ? { ok: true } : { ok: false, status, code: `kernel-${status}` };
    } catch (e) {
      return degrade(req, e);
    }
  }

  const reject = connection?.requestRejection;
  if (typeof reject === 'function') {
    try {
      const status = reject.call(connection, req);
      return status === undefined ? { ok: true } : { ok: false, status, code: `kernel-${status}` };
    } catch (e) {
      return degrade(req, e);
    }
  }

  const verdict = structuralVerdict(req);
  return verdict === undefined ? { ok: true } : { ok: false, status: 403, code: verdict.code };
}

/**
 * 只要状态码的老接口。
 *
 * @returns `undefined` 表示放行，否则是要回的 HTTP 状态码。
 */
export function rejectionFor(req, connection) {
  const verdict = assessRequest(req, connection);
  return verdict.ok ? undefined : verdict.status;
}
