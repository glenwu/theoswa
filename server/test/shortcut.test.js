import { test } from 'node:test';
import assert from 'node:assert/strict';
// 测试客户端快捷键纯判定模块（无 DOM 依赖，node 可直接跑）
import { isTypingTarget, shortcutAction } from '../../client/src/shortcut.js';

test('输入框聚焦时全部快捷键失效（打字按空格绝不触发抓牌/出牌）', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
  assert.equal(isTypingTarget(null), false);

  const revealCtx = { phase: 'REVEALING', myRevealTurn: true, myPlayTurn: false, selectedIds: [], rankCardIds: ['x1'] };
  const playCtx = { phase: 'PLAYING', myRevealTurn: false, myPlayTurn: true, selectedIds: ['c1'], rankCardIds: [] };
  // 在聊天输入框里按空格：什么都不发生
  assert.equal(shortcutAction({ key: ' ', target: { tagName: 'INPUT' } }, revealCtx), null);
  assert.equal(shortcutAction({ key: ' ', target: { tagName: 'TEXTAREA' } }, playCtx), null);
  // 数字键同理失效
  assert.equal(shortcutAction({ key: '1', target: { tagName: 'INPUT' } }, revealCtx), null);
});

test('空格：轮到自己揭牌 → drawCard；出牌阶段已选牌 → play（携带选中牌）', () => {
  const body = { tagName: 'BODY' };
  const reveal = shortcutAction(
    { key: ' ', target: body },
    { phase: 'REVEALING', myRevealTurn: true, myPlayTurn: false, selectedIds: [], rankCardIds: [] }
  );
  assert.equal(reveal.type, 'drawCard');
  assert.equal(reveal.preventDefault, true, '必须拦截空格滚动');

  const play = shortcutAction(
    { key: ' ', target: body },
    { phase: 'PLAYING', myRevealTurn: false, myPlayTurn: true, selectedIds: ['c1', 'c2'], rankCardIds: [] }
  );
  assert.deepEqual(play, { preventDefault: true, type: 'play', cardIds: ['c1', 'c2'] });
});

test('空格：不是自己回合 / 没选牌 → 只拦截滚动，不触发动作', () => {
  const body = { tagName: 'BODY' };
  const notMyTurn = shortcutAction(
    { key: ' ', target: body },
    { phase: 'REVEALING', myRevealTurn: false, myPlayTurn: false, selectedIds: [], rankCardIds: [] }
  );
  assert.equal(notMyTurn.type, null);
  assert.equal(notMyTurn.preventDefault, true);

  const noSelection = shortcutAction(
    { key: ' ', target: body },
    { phase: 'PLAYING', myRevealTurn: false, myPlayTurn: true, selectedIds: [], rankCardIds: [] }
  );
  assert.equal(noSelection.type, null);
  assert.equal(noSelection.preventDefault, true);
});

test('数字键 1-9：立即亮出第 N 张可亮级牌，编号与角标对应；超出范围无效', () => {
  const ctx = {
    phase: 'REVEALING',
    myRevealTurn: false,
    myPlayTurn: false,
    selectedIds: [],
    rankCardIds: ['r1', 'r2', 'r3'],
  };
  const body = { tagName: 'BODY' };
  assert.deepEqual(shortcutAction({ key: '1', target: body }, ctx), { type: 'declareTrump', cardId: 'r1', preventDefault: false });
  assert.deepEqual(shortcutAction({ key: '3', target: body }, ctx), { type: 'declareTrump', cardId: 'r3', preventDefault: false });
  assert.equal(shortcutAction({ key: '4', target: body }, ctx), null, '超出可亮张数无效');
  assert.equal(shortcutAction({ key: '9', target: body }, ctx), null);
});

test('数字键只在揭牌阶段生效', () => {
  const playCtx = { phase: 'PLAYING', myRevealTurn: false, myPlayTurn: true, selectedIds: ['c1'], rankCardIds: ['r1'] };
  assert.equal(shortcutAction({ key: '1', target: { tagName: 'BODY' } }, playCtx), null);
});
