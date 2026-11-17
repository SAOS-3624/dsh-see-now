import test from 'node:test';
import assert from 'node:assert/strict';

import { assessRequest, rejectionFor } from '../src/settings-trust.js';

/** 一份最小的 IncomingMessage 替身：这些函数只看 headers。 */
const req = (headers) => ({ headers, method: 'GET', url: '/api/see-now/status' });

/** 内核已经放行的 connection：admit 返回 peer，不带 rejection。 */
const kernelAllows = { admit: () => ({ peer: { id: 'peer-1' } }) };
/** 内核拒绝的 connection，状态码可指定。 */
const kernelRejects = (status) => ({ admit: () => ({ rejection: status }) });

const desktop = { host: '127.0.0.1:4096', referer: 'dsh-app://app/', 'sec-fetch-site': 'same-origin' };

test('the kernel admitting a request ends the decision', () => {
  // 这条曾经是反的：内核说没问题，复刻又判一遍，判不过是复刻自己过时。
  // 后果是 Electron 窗口里每个合法请求都 403，而且回给前端的只有「请求不被信任」。
  for (const headers of [
    desktop,
    { ...desktop, 'sec-fetch-site': 'none' },
    { ...desktop, 'sec-fetch-site': 'same-origin' },
    { host: '127.0.0.1:4096', referer: 'https://example.com/' },
    { host: '203.0.113.9:4096' },
  ]) {
    assert.deepEqual(assessRequest(req(headers), kernelAllows), { ok: true }, JSON.stringify(headers));
  }
});

test('a kernel rejection keeps its own status code', () => {
  assert.deepEqual(assessRequest(req(desktop), kernelRejects(401)), {
    ok: false,
    status: 401,
    code: 'kernel-401',
  });
  assert.deepEqual(assessRequest(req(desktop), kernelRejects(403)), {
    ok: false,
    status: 403,
    code: 'kernel-403',
  });
});

test('a kernel that throws degrades to the replica fence, and the fence still says no', () => {
  const broken = {
    admit() {
      throw new Error('boom');
    },
  };
  // 内核那道闸自己坏了（实测：`connection.authentication` without inject）。
  // 让每个请求都吃 503 等于把用户锁在门外，所以退到复刻判据，并留下原话。
  assert.deepEqual(assessRequest(req(desktop), broken), { ok: true, degraded: 'Error: boom' });
  // 但降级不是拆闸：跨站 Origin 在这条路上照样被拒。
  assert.deepEqual(assessRequest(req({ host: '127.0.0.1:4096', origin: 'http://evil.example' }), broken), {
    ok: false,
    status: 403,
    code: 'origin-mismatch',
  });
});

test('the older requestRejection shape still works', () => {
  assert.deepEqual(assessRequest(req(desktop), { requestRejection: () => undefined }), { ok: true });
  assert.deepEqual(assessRequest(req(desktop), { requestRejection: () => 403 }), {
    ok: false,
    status: 403,
    code: 'kernel-403',
  });
});

test('without a connection service the replica fence decides', () => {
  const cases = [
    [{ host: '127.0.0.1:4096' }, { ok: true }],
    [{ host: 'localhost:4096' }, { ok: true }],
    [{ host: '127.0.0.1:4096', 'sec-fetch-site': 'same-origin' }, { ok: true }],
    [{ host: '127.0.0.1:4096', 'sec-fetch-site': 'cross-site' }, { ok: false, status: 403, code: 'cross-site' }],
    [{ host: '127.0.0.1:4096', origin: 'http://127.0.0.1:4096' }, { ok: true }],
    [{ host: '127.0.0.1:4096', origin: 'http://127.0.0.1:9999' }, { ok: false, status: 403, code: 'origin-mismatch' }],
    [{ host: '127.0.0.1:4096', origin: 'dsh-app://app' }, { ok: false, status: 403, code: 'origin-invalid' }],
    [{ host: '127.0.0.1:4096', referer: 'http://127.0.0.1:4096/settings' }, { ok: true }],
    [{ host: '127.0.0.1:4096', referer: 'http://127.0.0.1:8080/' }, { ok: false, status: 403, code: 'referer-mismatch' }],
    [{}, { ok: false, status: 403, code: 'no-host' }],
    [{ host: '203.0.113.9:4096' }, { ok: false, status: 403, code: 'host-not-loopback' }],
  ];
  for (const [headers, expected] of cases) {
    assert.deepEqual(assessRequest(req(headers), undefined), expected, JSON.stringify(headers));
  }
});

test('a desktop relay Referer is not evidence of a cross-site request', () => {
  // Chromium 给同源请求一律加 Sec-Fetch-Site，桌面转发又会留下 dsh-app:// 的
  // Referer。曾经只要这两样同时出现就拒，等于把整个 Electron 窗口挡在门外。
  for (const site of ['same-origin', 'same-site', 'none']) {
    const headers = { host: '127.0.0.1:4096', referer: 'dsh-app://app/', 'sec-fetch-site': site };
    assert.deepEqual(assessRequest(req(headers), undefined), { ok: true }, site);
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
  assert.equal(rejectionFor(req(desktop), kernelAllows), undefined);
  assert.equal(rejectionFor(req(desktop), kernelRejects(401)), 401);
  assert.equal(rejectionFor(req({ host: '203.0.113.9:4096' }), undefined), 403);
});
