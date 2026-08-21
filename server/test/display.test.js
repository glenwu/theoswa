import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handGroups, groupBadgeCount, needWideGap, partitionByWidth } from '../../client/src/handGroups.js';
import { tiaoZhuActive } from '../../client/src/tiaozhu.js';
import { tapToggle, dragAdd, selectionCapFor } from '../../client/src/selection.js';

const c = (id, suit, rank) => ({ id, suit, rank });

test('handGroups：按有效花色聚合，主牌组在前', () => {
  const hand = [
    c('1', 'H', 14), c('2', 'H', 13), c('3', 'S', 2), // 主牌组（主红桃打2：♥A ♥K ♠2副级牌）
    c('4', 'S', 9), c('5', 'S', 8),
    c('6', 'D', 7),
    c('7', 'C', 6),
  ];
  const groups = handGroups(hand, 'H', 2);
  assert.deepEqual(
    groups.map(g => [g.suit, g.count]),
    [['TRUMP', 3], ['S', 2], ['D', 1], ['C', 1]]
  );
  assert.equal(groups[0].color, null);
  assert.equal(groups[1].color, 'black');
  assert.equal(groups[2].color, 'red');
  assert.equal(groups[3].color, 'black');
});

// 门槛从 >5 改为 >=5：角标同时是「整组全选」按钮，一次点 5 张也值得
test('组张数角标：4 张不显示、5 张起显示', () => {
  assert.equal(groupBadgeCount({ count: 4 }), null);
  assert.equal(groupBadgeCount({ count: 5 }), 5);
  assert.equal(groupBadgeCount({ count: 6 }), 6);
  assert.equal(groupBadgeCount({ count: 7 }), 7);
});

test('同色相邻副牌组需要明显间隔；异色不需要', () => {
  assert.equal(needWideGap({ color: 'red' }, { color: 'red' }), true);
  assert.equal(needWideGap({ color: 'black' }, { color: 'black' }), true);
  assert.equal(needWideGap({ color: 'red' }, { color: 'black' }), false);
  assert.equal(needWideGap({ color: null }, { color: 'red' }), false, '主牌组不走此判定');
});

test('吊主：首家出主牌且上一轮非主牌 → 触发（第一轮也触发）', () => {
  assert.equal(tiaoZhuActive([{ seat: 0, playSuit: 'TRUMP', cards: [c('x', 'H', 5)] }], []), true);
  assert.equal(
    tiaoZhuActive(
      [{ seat: 0, playSuit: 'TRUMP', cards: [c('x', 'H', 5)] }],
      [{ leadSuit: 'S' }]
    ),
    true,
    '副牌 → 主牌 触发'
  );
});

test('吊主：连续两轮主牌领出只弹一次', () => {
  assert.equal(
    tiaoZhuActive(
      [{ seat: 0, playSuit: 'TRUMP', cards: [c('x', 'H', 5)] }],
      [{ leadSuit: 'TRUMP' }]
    ),
    false
  );
});

test('吊主：副→主→副→主 弹两次', () => {
  const history = (arr) => arr.map(leadSuit => ({ leadSuit }));
  const lead = (suit) => [{ seat: 0, playSuit: suit, cards: [c('x', 'H', 5)] }];
  // 第一次主牌领出（历史：副）→ 触发
  assert.equal(tiaoZhuActive(lead('TRUMP'), history(['S'])), true);
  // 第二次主牌领出（历史：主）→ 不触发
  assert.equal(tiaoZhuActive(lead('TRUMP'), history(['S', 'TRUMP'])), false);
  // 副牌领出（历史末尾主）→ 不触发
  assert.equal(tiaoZhuActive(lead('S'), history(['S', 'TRUMP'])), false);
  // 再主牌领出（历史：…副）→ 再次触发
  assert.equal(tiaoZhuActive(lead('TRUMP'), history(['S', 'TRUMP', 'S'])), true);
});

test('吊主：非首家出牌阶段（currentTrick 长度不为 1）不触发', () => {
  assert.equal(tiaoZhuActive([], []), false);
  assert.equal(tiaoZhuActive(null, []), false);
  assert.equal(
    tiaoZhuActive(
      [
        { seat: 0, playSuit: 'TRUMP', cards: [c('x', 'H', 5)] },
        { seat: 3, playSuit: 'TRUMP', cards: [c('y', 'H', 7)] },
      ],
      []
    ),
    false
  );
});

test('拖选只加选：出牌阶段（无上限）拖回已选牌不清除，未选牌加选', () => {
  const cap = selectionCapFor('PLAYING');
  assert.equal(cap, Infinity);
  let sel = ['a'];
  sel = dragAdd(sel, 'a', cap); // 拖回已选牌 → 不变（不清除）
  assert.deepEqual(sel, ['a']);
  sel = dragAdd(sel, 'b', cap);
  sel = dragAdd(sel, 'c', cap);
  assert.deepEqual(sel, ['a', 'b', 'c']);
});

test('拖选只加选：换底阶段上限 8，第 9 张加不进去', () => {
  const cap = selectionCapFor('KITTY_EXCHANGE');
  assert.equal(cap, 8);
  let sel = ['1', '2', '3', '4', '5', '6', '7', '8'];
  sel = dragAdd(sel, '9', cap);
  assert.deepEqual(sel, ['1', '2', '3', '4', '5', '6', '7', '8']);
  sel = dragAdd(sel, '5', cap); // 已选牌拖过仍不清除
  assert.equal(sel.length, 8);
});

test('单击切换：未选加选、已选取消（换底同样受 8 张上限）', () => {
  const cap = selectionCapFor('PLAYING');
  let sel = tapToggle([], 'a', cap);
  assert.deepEqual(sel, ['a']);
  sel = tapToggle(sel, 'a', cap);
  assert.deepEqual(sel, []);
  const buryCap = selectionCapFor('KITTY_EXCHANGE');
  sel = ['1', '2', '3', '4', '5', '6', '7', '8'];
  assert.deepEqual(tapToggle(sel, '9', buryCap), sel, '第 9 张加不进去');
  assert.equal(tapToggle(sel, '1', buryCap).length, 7, '已选可取消');
});

// ---- 手牌分行：以花色组为最小单位的最优划分 ----

const spans = (widths, rows) =>
  partitionByWidth(widths, rows).map(([a, b]) => widths.slice(a, b).reduce((x, y) => x + y, 0));

test('分行：最宽的一行尽可能窄（不是贪心）', () => {
  // 真实回归场景：主牌117 / ♥183 / ♠103 / ♦137，两行。
  // 贪心（超过总宽一半就换行）会切成 117 / 423 —— 第二行远超可用宽度，溢出到屏幕两侧。
  // 最优划分应为 300 / 240。
  assert.deepEqual(spans([117, 183, 103, 137], 2), [300, 240]);
});

test('分行：组是最小单位，绝不拦腰截断', () => {
  const ranges = partitionByWidth([117, 183, 103, 137], 2);
  // 区间必须首尾相接且覆盖全部组，没有任何组被拆到两个区间里
  assert.deepEqual(ranges, [[0, 2], [2, 4]]);
  assert.equal(ranges[0][1], ranges[1][0], '区间首尾相接');
  assert.equal(ranges.at(-1)[1], 4, '覆盖到最后一组');
});

test('分行：单行时原样返回', () => {
  assert.deepEqual(partitionByWidth([50, 60, 70], 1), [[0, 3]]);
});

test('分行：组数少于行数时不产生空行', () => {
  const ranges = partitionByWidth([100, 100], 3);
  assert.equal(ranges.length, 2, '只有 2 组就只排 2 行');
  assert.ok(ranges.every(([a, b]) => b > a), '没有空区间');
});

test('分行：空输入不炸', () => {
  assert.deepEqual(partitionByWidth([], 2), []);
});

test('分行：极端不均也要挑最优切点', () => {
  // 一个超大组 + 若干小组：大组只能自己占一行
  assert.deepEqual(spans([500, 10, 10, 10], 2), [500, 30]);
  // 均匀四组两行 → 对半
  assert.deepEqual(spans([100, 100, 100, 100], 2), [200, 200]);
});

test('分行：三行时同样最优', () => {
  assert.deepEqual(spans([100, 100, 100, 100, 100, 100], 3), [200, 200, 200]);
});
