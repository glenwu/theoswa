import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../state.js';
import { applyAction } from '../actions.js';
import { flipCardForRevealFirst, drawOneCard } from '../round.js';
import { viewerState } from '../viewer.js';
import { collectLeakedCards, isCardLike } from '../security.js';
import { startRevealing } from '../flow.js';

const seeded = () => 0.42;

// 走真实流程到 REVEALING（座位→准备→抢按→翻牌定起揭人）
function setupRevealing() {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'ready' }, p.id);
  assert.equal(state.phase, 'REVEAL_FIRST');
  applyAction(state, { type: 'claimFlipper' }, 'T');
  let guard = 0;
  while (!state.round.flipDone && guard++ < 5) {
    flipCardForRevealFirst(state); // 大小王作废重翻，直到点数牌
  }
  startRevealing(state); // 跳过 10 秒停留
  assert.equal(state.phase, 'REVEALING');
  return state;
}

test('揭牌过程中（第 1/13/37/100 张）四家 payload 均不含他人牌面', () => {
  const state = setupRevealing();
  const drawnBySeat = new Map([[0, []], [1, []], [2, []], [3, []]]);
  const targets = [1, 13, 37, 100];

  for (let k = 1; k <= 100; k++) {
    const seat = state.round.revealTurnSeat;
    const card = drawOneCard(state, seat);
    drawnBySeat.get(seat).push(card.id);

    if (targets.includes(k)) {
      for (const p of state.players) {
        // viewerState 内置扫描：出现非公开牌面会直接抛错
        const view = viewerState(state, p.id);
        const ownIds = drawnBySeat.get(p.seat);
        assert.equal(view.you.hand.length, ownIds.length, `第${k}张：${p.id} 手牌张数`);
        assert.deepEqual(
          new Set(view.you.hand.map(c => c.id)),
          new Set(ownIds),
          `第${k}张：${p.id} 只含自己摸到的牌`
        );
        for (const q of view.players) {
          assert.equal('hand' in q, false, '其他玩家只给 handCount');
          assert.equal(typeof q.handCount, 'number');
        }
        // 全 payload 序列化后不应出现别人的牌 id（按 JSON 字符串值精确匹配，避免 c10 误中 c100 之类子串）。
        // 例外：关键节点大图事件里的牌是当时公开亮出的（翻牌定起揭人那张牌放回重洗后仍可能被他人摸走，
        // 但牌面人人见过，事件字段带 id 不算泄密）——白名单路径已由 viewer 扫描器兜底。
        const json = JSON.stringify(view);
        const publicEventIds = new Set(
          [view.round?.flipEvent?.card?.id, view.round?.trumpEvent?.card?.id, view.round?.fallbackTrumpCard?.id].filter(Boolean)
        );
        for (const other of state.players) {
          if (other.id === p.id) continue;
          for (const cid of drawnBySeat.get(other.seat)) {
            if (publicEventIds.has(cid)) continue;
            assert.ok(
              !json.includes(`"${cid}"`),
              `第${k}张：${p.id} 的 payload 含 ${other.id} 的牌 ${cid}`
            );
          }
        }
      }
    }
  }
});

test('扫描器按 Card 形状递归（不靠字段名）：改名/嵌套都能抓住', () => {
  const card = { id: 'x', suit: 'S', rank: 7 };
  assert.ok(isCardLike(card));
  assert.equal(isCardLike({ id: 'x', suit: 'S' }), false, '缺 rank 不是牌');
  assert.equal(isCardLike({ suit: 'S', rank: 7 }), false, '缺 id 不是牌');
  // 改字段名绕不过去：Card 形状对象出现在任何非白名单位置都算泄露
  assert.equal(collectLeakedCards({ seat: 1, mystery: [card] }, ['you.hand']).length, 1);
  assert.equal(collectLeakedCards({ players: [{ seat: 1, cards: [card] }] }, ['you.hand']).length, 1);
  assert.equal(collectLeakedCards({ deep: { nested: { anywhere: card } } }, []).length, 1);
  // 白名单路径放行
  assert.equal(collectLeakedCards({ you: { hand: [card] } }, ['you.hand']).length, 0);
  assert.equal(collectLeakedCards({ round: { flipShown: [card] } }, ['round.flipShown']).length, 0);
  // 非牌对象不误伤（聊天文本里的“黑桃7”只是字符串）
  assert.equal(collectLeakedCards({ chat: [{ from: 'T', text: '黑桃7' }] }, []).length, 0);
});

test('公开牌（翻牌/揭底摊开）在白名单内，不触发扫描报错', () => {
  const state = setupRevealing();
  // 翻牌阶段公开的牌
  state.round.flipShown = [{ id: 'pub1', suit: 'S', rank: 9 }];
  // 揭底定主摊开的牌
  state.round.fallbackRevealed = [{ id: 'pub2', suit: 'D', rank: 13 }];
  for (const p of state.players) {
    const view = viewerState(state, p.id); // 不抛错即通过
    assert.equal(view.round.flipShown.length, 1);
    assert.equal(view.round.fallbackRevealed.length, 1);
  }
});

test('换底期间：底牌已并进庄家手牌（33 张），其他人完全看不到这些牌面', () => {
  const state = setupRevealing();
  // 构造换底状态：庄家手牌 33 张（含原底牌 k0..k7），其余三家看不到
  const declarerSeat = state.seatsByPlayer.T;
  state.declarerSeat = declarerSeat;
  state.round.trumpSuit = 'H';
  state.round.kitty = [];
  const kittyCards = Array.from({ length: 8 }, (_, i) => ({ id: `k${i}`, suit: 'C', rank: 3 + i }));
  const declarer = state.players.find(p => p.id === 'T');
  const baseHand = Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, suit: 'S', rank: 3 + (i % 10) }));
  declarer.hand = [...baseHand, ...kittyCards];
  state.phase = 'KITTY_EXCHANGE';

  const declarerView = viewerState(state, 'T'); // 扫描抛错即失败
  assert.equal(declarerView.you.hand.length, 33, '庄家 33 张（底牌并入）');
  for (const other of state.players.filter(p => p.id !== 'T')) {
    const view = viewerState(state, other.id);
    const json = JSON.stringify(view);
    for (const k of kittyCards) {
      assert.ok(!json.includes(`"${k.id}"`), `非庄家 payload 含底牌 ${k.id}`);
    }
    assert.equal(view.round.kittyCount, 0);
  }
});
