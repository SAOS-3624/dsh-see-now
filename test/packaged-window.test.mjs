// 包内那份 window.py 的守卫。
//
// ## 为什么需要这一组
//
// `window.py` 的主副本在 `dsh-watch-together` 里（3000 多行，还在改）。
// see-now 包里那份是 `scripts/sync-window.mjs` 从上游生成的**产物**，
// 靠 `prepack` 自动刷新。这条链一旦断了，就会发一个"装上去开不了窗"的包 ——
// 而且**在开发机上完全看不出来**（开发机有兄弟仓库、有 profile 里的副本，
// 回退链总能在别处找到 window.py）。
//
// 所以这里守三件事：
//   1. 包内那份**真的存在**（`files` 里漏了 `examples` 就发不出去）
//   2. 它是**能解析的 Python**（同步半个文件 / 编码坏了要知道）
//   3. 回退链的**顺序**不会被无意改掉

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PACKAGED = join(ROOT, 'examples', 'floating-chat', 'window.py');
const REL = join('examples', 'floating-chat', 'window.py');

const home = mkdtempSync(join(tmpdir(), 'dsh-see-sync-'));
process.env.DSH_HOME = home;
delete process.env.DSH_SEE_WINDOW;

const { resolveScript, PACKAGED: EXPORTED } = await import('../src/window.js');

test('包里必须自带 window.py（发版兜底，不能只靠兄弟仓库）', () => {
  assert.ok(existsSync(PACKAGED), `缺了 ${PACKAGED}；跑 npm run sync:window`);
  assert.equal(EXPORTED, PACKAGED, '导出的路径要和实际文件对上');

  const text = readFileSync(PACKAGED, 'utf8');
  assert.ok(text.length > 50_000, `文件太小了（${text.length} 字符），像是同步坏了`);
  assert.match(text, /^#!.*python/, '得保留 shebang');
  assert.match(text, /生成的|sync-window\.mjs/, '要带 GENERATED 标记，防止有人手改这份');
});

test('包内那份是合法的 Python（语法能过）', (t) => {
  let probe;
  for (const python of ['python3', 'python']) {
    probe = spawnSync(python, ['-c',
      'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read());print("ok")',
      PACKAGED], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (!probe.error && probe.status !== null) break;
  }
  if (probe.error || probe.status === null) return t.skip('未找到可运行的 Python');
  assert.equal(probe.status, 0, `语法检查失败：${probe.stderr || probe.stdout}`);
  assert.match(probe.stdout, /ok/);
});

test('macOS 独立入口只用标准库，不导入 Windows 窗口', (t) => {
  const entry = join(ROOT, 'examples', 'floating-chat', 'macos-window.py');
  const ui = join(ROOT, 'examples', 'floating-chat', 'macos.py');
  const text = readFileSync(entry, 'utf8');
  assert.match(text, /DSH_SEE_WINDOW_PROTOCOL = 1/);
  assert.match(text, /DSH_SEE_WINDOW_COMMANDS = 1/);
  assert.doesNotMatch(text, /from window|import window|PIL|ctypes|mss/);
  let py = null;
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (!probe.error && probe.status === 0) { py = candidate; break; }
  }
  if (!py) return t.skip('未找到可运行的 Python');
  for (const path of [entry, ui]) {
    const result = spawnSync(py, ['-c',
      'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', path],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('回退链：显式指定 > 配置 > 已安装 > 开发仓库 > 包内', () => {
  // 用 env 注入，不动 process.env，也不去真开窗
  const fakeEnv = mkHome({
    'see-window.json': null,          // 故意不写，走到下一层
  });

  // 1. 显式指定
  const explicit = join(fakeEnv.root, 'custom.py');
  writeFileSync(explicit, 'print(1)\n', 'utf8');
  assert.equal(
    resolveScript({ platform: 'win32', env: { ...fakeEnv.env, DSH_SEE_WINDOW: explicit } }).from,
    'DSH_SEE_WINDOW',
  );

  // 2. ~/.dsh/see-window.json
  writeJson(join(fakeEnv.home, 'see-window.json'), { script: explicit });
  assert.equal(
    resolveScript({ platform: 'win32', env: fakeEnv.env }).from,
    '~/.dsh/see-window.json',
    '配置文件该比已安装的包优先',
  );

  // 3. ~/.dsh/watch-window.json
  writeJson(join(fakeEnv.home, 'see-window.json'), {});
  writeJson(join(fakeEnv.home, 'watch-window.json'), { script: explicit });
  assert.equal(resolveScript({ platform: 'win32', env: fakeEnv.env }).from, '~/.dsh/watch-window.json');

  // 4. 已安装的包（要能扫到 web 这种非 desktop 的 profile）
  writeJson(join(fakeEnv.home, 'watch-window.json'), {});
  const inst = join(fakeEnv.home, 'profiles', 'web', 'node_modules', 'dsh-watch-together', REL);
  mkdirSync(dirname(inst), { recursive: true });
  writeFileSync(inst, 'print(2)\n', 'utf8');
  const found = resolveScript({ platform: 'win32', env: fakeEnv.env });
  assert.equal(found.from, '已安装的 watch-together');
  assert.equal(found.script, inst, 'profile 名不能硬编码成 desktop');

  // 5. 都没有 → 包内（开发机上就是这一层兜底）
  const bare = mkHome({});
  const last = resolveScript({ platform: 'win32', env: bare.env });
  if (last.from === '开发仓库') {
    // 开发机上有兄弟仓库，它排在包内前面，这是对的
    assert.equal(last.script, join(ROOT, '..', 'dsh-watch-together', REL));
  } else {
    assert.equal(last.from, '包内');
    assert.equal(last.script, PACKAGED);
  }
});

test('空环境里 resolveScript 不会抛异常', () => {
  const bare = mkHome({});
  const r = resolveScript({ env: bare.env });
  assert.ok(r.from === '包内' || r.from === '开发仓库' || r.from === 'macOS 独立窗口', `意外的来源：${r.from}`);
  assert.ok(existsSync(r.script), 'resolve 出来的路径必须真的存在');
});

/** 造一个隔离的 DSH_HOME，返回 {home, root, env} */
function mkHome(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-see-chain-'));
  for (const [name, value] of Object.entries(extra)) {
    if (value !== null) writeJson(join(dir, name), value);
  }
  return { home: dir, root: dir, env: { DSH_HOME: dir } };
}

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
