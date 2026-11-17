import test from 'node:test';
import assert from 'node:assert/strict';

import { assessRequest, rejectionFor } from '../src/settings-trust.js';

/**
 * 两条路：内核给了 peer 就放行；没给（宿主没有路由认证）才自己判。
 *
 * 这个模块随设置面板一起进来之后一直零测试覆盖，于是那条「内核放行之后再判一遍」的
 * 判据在仓库里躺了两个版本，直到有人从面板上撞见它。下面这些用例钉的就是这件事。
 */

/** 一份最小的 IncomingMessage 替身：这些函数只看 headers。 */
const req = (headers) => ({ headers, method: 'GET', url: '/api/see-now/status' });

/** 内核认证后交给 handler 的身份。 */
const peer = { id: 'peer-1', principal: { kind: 'owner' } };

const desktop = { host: '127.0.0.1:4096', referer: 'dsh-app://app/', 'sec-fetch-site': 'same-origin' };

test('a peer means the kernel already answered who this is', () => {
  // 内核在调用 handler 之前就跑完准入（`auth ?? "required"`），能进来的请求都带 peer。
  // 所以这里不该再看 headers —— 再看一遍只会用一个更弱的判据覆盖掉内核的结论。
  for (const headers of [
    desktop,
    { ...desktop, 'sec-fetch-site': 'none' },
    { ...desktop, 'sec-fetch-site': 'same-origin' },
    { host: '127.0.0.1:4096', referer: 'https://example.com/' },
    // 连这些也放行：跨站与非 loopback 的 Host 在内核那一层就已经被拒了，
    // 能走到这里说明它们不是真正的来源证据。
    { host: '203.0.113.9:4096' },
    { host: '127.0.0.1:4096', origin: 'http://evil.example' },
  ]) {
    assert.deepEqual(assessRequest(req(headers), peer), { ok: true, path: 'peer' }, JSON.stringify(headers));
  }
});

test('a fake peer object is enough — but only because the kernel had to build it', () => {
  // 这条锁住契约：判定只看「有没有 peer」，而不是看它的形状。形状由内核定义，
  // 插件按字段猜测只会跟着上游版本漂移。
  assert.deepEqual(assessRequest(req({}), { anything: true }), { ok: true, path: 'peer' });
  assert.deepEqual(assessRequest(req({}), { id: undefined }), { ok: true, path: 'peer' });
});

test('without a peer the fence decides — and it always answers', () => {
  const cases = [
    [{ host: '127.0.0.1:4096' }, { ok: true, path: 'legacy' }],
    [{ host: 'localhost:4096' }, { ok: true, path: 'legacy' }],
    [{ host: '127.0.0.1:4096', 'sec-fetch-site': 'same-origin' }, { ok: true, path: 'legacy' }],
    [{ host: '127.0.0.1:4096', 'sec-fetch-site': 'cross-site' }, { ok: false, status: 403, code: 'cross-site' }],
    [{ host: '127.0.0.1:4096', origin: 'http://127.0.0.1:4096' }, { ok: true, path: 'legacy' }],
    [{ host: '127.0.0.1:4096', origin: 'http://127.0.0.1:9999' }, { ok: false, status: 403, code: 'origin-mismatch' }],
    [{ host: '127.0.0.1:4096', origin: 'dsh-app://app' }, { ok: false, status: 403, code: 'origin-invalid' }],
    [{ host: '127.0.0.1:4096', referer: 'http://127.0.0.1:4096/settings' }, { ok: true, path: 'legacy' }],
    [{ host: '127.0.0.1:4096', referer: 'http://127.0.0.1:8080/' }, { ok: false, status: 403, code: 'referer-mismatch' }],
    [{}, { ok: false, status: 403, code: 'no-host' }],
    [{ host: '203.0.113.9:4096' }, { ok: false, status: 403, code: 'host-not-loopback' }],
  ];
  for (const [headers, expected] of cases) {
    assert.deepEqual(assessRequest(req(headers), undefined), expected, JSON.stringify(headers));
  }
});

test('an absent peer is not a rejection — it is an older host', () => {
  // 旧宿主的 webServer 只认 kind/path/handler，`auth` 是被忽略的未知字段，peer 恒为
  // undefined。那种部署里所有 loopback 请求同权，来源栅栏是当时能拿到的最强保护；
  // 把它判成 503 会让设置页在这些宿主上完全打不开。
  assert.deepEqual(assessRequest(req({ host: '127.0.0.1:4096' }), null), { ok: true, path: 'legacy' });
  assert.deepEqual(assessRequest(req({ host: '127.0.0.1:4096' }), undefined), { ok: true, path: 'legacy' });
});

test('a desktop relay Referer is not evidence of a cross-site request', () => {
  // Chromium 给同源请求一律加 Sec-Fetch-Site，桌面转发又会留下 dsh-app:// 的
  // Referer。曾经只要这两样同时出现就拒，等于把整个 Electron 窗口挡在门外。
  for (const site of ['same-origin', 'same-site', 'none']) {
    const headers = { host: '127.0.0.1:4096', referer: 'dsh-app://app/', 'sec-fetch-site': site };
    assert.deepEqual(assessRequest(req(headers), undefined), { ok: true, path: 'legacy' }, site);
  }
});

test('a dsh-app Referer together with a loopback Origin is contradictory', () => {
  const headers = { host: '127.0.0.1:4096', referer: 'dsh-app://app/', origin: 'http://127.0.0.1:4096' };
  assert.deepEqual(assessRequest(req(headers), undefined), {
    ok: false,
    status: 403,
    code: 'desktop-relay-with-origin',
  });
});

test('rejectionFor still answers with a bare status code', () => {
  assert.equal(rejectionFor(req(desktop), peer), undefined);
  assert.equal(rejectionFor(req({ host: '203.0.113.9:4096' }), undefined), 403);
});
