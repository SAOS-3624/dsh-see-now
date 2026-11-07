import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultGlassEnv } from '../src/window.js';

function homeWith(cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'see-now-glass-'));
  if (cfg !== undefined) writeFileSync(join(dir, 'watch-window.json'), JSON.stringify(cfg));
  return dir;
}

test('Windows 上不给任何默认样式（live 是它的主场景）', () => {
  assert.deepEqual(defaultGlassEnv({ platform: 'win32', home: homeWith(undefined) }), {});
});

test('Linux/macOS 没配置过样式 → 默认 frost，别去抓屏', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(defaultGlassEnv({ platform, home: homeWith(undefined) }), { DSH_GLASS_FROST: '1' });
  }
});

test('用户显式选过 glass（含空串以外的值）→ 尊重他，不加环境变量', () => {
  for (const glass of ['live', 'solid', 'frost']) {
    assert.deepEqual(defaultGlassEnv({ platform: 'linux', home: homeWith({ glass }) }), {});
  }
});

test('配置里 glass 是空串 / 空白 → 当成没选过', () => {
  assert.deepEqual(defaultGlassEnv({ platform: 'linux', home: homeWith({ glass: '   ' }) }), { DSH_GLASS_FROST: '1' });
});

test('配置坏了也不影响：按没选过处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'see-now-glass-'));
  writeFileSync(join(dir, 'watch-window.json'), '{不是 json');
  assert.deepEqual(defaultGlassEnv({ platform: 'linux', home: dir }), { DSH_GLASS_FROST: '1' });
});
