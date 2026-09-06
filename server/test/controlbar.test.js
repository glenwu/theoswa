import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(path.join(root, 'client/src/styles.css'), 'utf8');
const panel = readFileSync(path.join(root, 'client/src/components/TablePanel.jsx'), 'utf8');

// JSX 里写一个 styles.css 里不存在的按钮类，界面不报错 —— 只是变成一颗没有底色、
// 没有内边距的裸文字，很容易到真机上才发现。这条把两边钉在一起。
test('按钮配色：JSX 用到的 btn-* 类，styles.css 里都得有定义', () => {
  const used = [...new Set([...panel.matchAll(/className="([^"]*\bbtn-[\w-]+[^"]*)"/g)]
    .flatMap(m => m[1].split(/\s+/))
    .filter(cls => cls.startsWith('btn-')))];
  assert.ok(used.includes('btn-emerald'), '前提：亮主键用的是 btn-emerald');
  const missing = used.filter(cls => !css.includes(`.${cls} {`));
  assert.deepEqual(missing, [], `这些按钮类没有样式定义：${missing.join(', ')}`);
});

// 这个函数上面写着一条铁律：「每个有服务端兜底的『等一个人』的阶段都必须在这里
// 显示倒计时。看不见的超时是陷阱。」揭牌那 3 秒到点服务端会自动替他摸牌，
// 所以把揭牌键旁边那个表挪走的时候，中央这块必须接上 —— 不然就是净删了一块表。
test('倒计时：揭牌阶段必须落在牌桌中央的 timerSpecFor 里', () => {
  const spec = panel.slice(
    panel.indexOf('function timerSpecFor'),
    panel.indexOf('function CenterTurnTimer')
  );
  assert.ok(spec.includes("game.phase === 'REVEALING'"), '揭牌阶段没有接进中央倒计时');
  assert.ok(spec.includes('round.drawDeadline'), '接的必须是摸牌那个 deadline');
});

// ⚠️ 揭牌键右边那个 0.1 秒精度的小表已经删掉（Glen：「桌面中间有倒数就行了」）。
// 它一旦被谁顺手加回来，中央那块就成了重复显示。
test('倒计时：揭牌键旁边不再挂第二块表', () => {
  assert.ok(
    !/⏱ \{left\.toFixed/.test(panel),
    '控制栏里又出现了 ⏱ {left.toFixed(1)}s 那个小表'
  );
});

// 亮主：一个花色一个按钮，排在同一行（Glen 2026-09-06）。
// 抢亮是先按先得，原来那层「选择亮主花色」的对话框等于在抢的路上多加一次点击。
// 这条钉住的是【对话框没被谁顺手加回来】，以及按钮标签是「亮」+ 花色符号。
test('亮主：多花色时摆成一排按钮，不再弹选花色的对话框', () => {
  assert.ok(!panel.includes('DeclareModal'), '选花色的对话框又回来了');
  assert.ok(!panel.includes('onDeclareOptions'), '还留着往对话框里传选项的 prop');
  const bar = panel.slice(panel.indexOf('const options = declareOptions('), panel.indexOf("key=\"draw\""));
  assert.ok(/options\.map\(/.test(bar), '亮主按钮不是按 options 逐个摆出来的');
  assert.ok(/flex flex-wrap/.test(bar), '这排按钮没有排在同一行（flex-wrap）');
  assert.ok(/suitSymbol\(option\.suit\)/.test(bar), '按钮上没有显示花色符号（Glen 要的是「亮♠」）');
});

// 手牌上的可亮级牌角标、控制栏那排「亮♠」按钮、数字快捷键，三者必须是同一套编号。
// 角标原来是【按张】数 1..N：手上 ♠6 ♥6 ♠6 时角标 1/2/3，而选择只有 ♠=1 ♥=2 ——
// 按 3 什么也不会发生，按 2 亮的还是 ♥，跟角标对不上号。
test('亮主编号：角标、按钮、数字键都从同一份 declareOptions 来', () => {
  const uses = panel.match(/declareOptions\(/g) ?? [];
  assert.equal(uses.length, 3,
    `按钮 / 数字键 / 角标各用一次，共 3 处，实际 ${uses.length} 处`);
  const badges = panel.slice(
    panel.indexOf('const rankBadges = new Map();'),
    panel.indexOf('// groupIndex 为组内序号')
  );
  assert.ok(/declareOptions\(hand, game\.round\.rankCard\)/.test(badges),
    '角标又回去按张数了（没走 declareOptions）');
  assert.ok(!/rankIndex/.test(panel), '按张递增的旧编号还在');
});
