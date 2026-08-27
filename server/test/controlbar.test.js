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
