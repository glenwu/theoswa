import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { THEMES, DEFAULT_THEME, isTheme } from '../../client/src/theme.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(path.join(root, 'client/src/styles.css'), 'utf8');

// 换肤靠 data-theme 挂到 <html> 上、由 CSS 变量接管颜色。
// 最容易犯的错是「theme.js 里加了一套，styles.css 忘了写规则」——
// 界面不会报错，只会变成一片裸色（变量取不到值）。所以这条必须自动查。
test('配色：每套方案都要有对应的 CSS 规则', () => {
  for (const t of THEMES) {
    if (t.id === DEFAULT_THEME) continue; // 默认那套写在 :root
    assert.ok(
      css.includes(`[data-theme='${t.id}']`),
      `theme.js 里有「${t.name}」(${t.id})，styles.css 里却没有对应规则`
    );
  }
});

test('配色：每套都要把氛围色变量配齐', () => {
  const VARS = ['--felt-deep', '--felt-mid', '--felt-rise', '--felt-glow',
                '--spot-glow', '--back-from', '--back-to'];
  const blocks = new Map();
  // :root 那一块 + 各 [data-theme] 块
  for (const m of css.matchAll(/(:root|\[data-theme='([a-z]+)'\])\s*\{([^}]*)\}/g)) {
    blocks.set(m[2] ?? DEFAULT_THEME, m[3]);
  }
  for (const t of THEMES) {
    const body = blocks.get(t.id);
    assert.ok(body, `找不到「${t.name}」的样式块`);
    for (const v of VARS) {
      assert.ok(body.includes(`${v}:`), `「${t.name}」缺少 ${v}`);
    }
  }
});

test('配色：默认那套必须是合法 id，swatch 三个色', () => {
  assert.ok(isTheme(DEFAULT_THEME));
  assert.equal(isTheme('不存在的方案'), false);
  assert.equal(isTheme(null), false);
  for (const t of THEMES) {
    assert.equal(t.swatch.length, 3, `${t.name} 的 swatch 应该是 底色/聚光/强调 三个`);
    assert.match(t.id, /^[a-z]+$/, 'id 要能直接写进 CSS 选择器');
  }
});
