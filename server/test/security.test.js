import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../state.js';
import { applyAction } from '../actions.js';
import { flipCardForRevealFirst, drawOneCard } from '../round.js';
import { viewerState } from '../viewer.js';
import { collectLeakedCards, isCardLike } from '../security.js';
import { mulberry32 } from '../rng.js';
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

// ---- 扫描器提速后的【等价性】测试 ----
//
// collectLeakedCards 是全项目的安全底线，为了性能改写它必须证明语义没变，
// 不能只靠「现有几条测试还是绿的」。这里把【改之前的实现】原样留作基准，
// 拿随机生成的 payload 逐个比对两者的输出。
//
// 改写做了两件事：进入白名单子树就整棵跳过；路径字符串只在真找到泄露时才拼。
function referenceCollect(payload, allowedPrefixes) {
  const leaks = [];
  const walk = (node, path) => {
    if (isCardLike(node)) {
      const allowed = allowedPrefixes.some(p => path === p || path.startsWith(p + '.'));
      if (!allowed) leaks.push({ path, card: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : String(k));
      }
    }
  };
  walk(payload, '');
  return leaks;
}

test('扫描器提速：与改写前的实现在随机 payload 上逐条等价', () => {
  const rng = mulberry32(20260824);
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const KEYS = ['you', 'hand', 'round', 'trickHistory', 'players', 'cards', 'log', 'deep', 'x'];
  const PREFIX_SETS = [
    [],
    ['you.hand'],
    ['you.hand', 'round.trickHistory'],
    ['round'],
    ['you.hand', 'round.currentTrick', 'round.flipShown'],
    ['a.b.c'],
  ];
  const makeCard = i => ({ id: `c${i}`, suit: pick(['S', 'H', 'D', 'C']), rank: 3 + (i % 12) });
  let n = 0;
  const build = depth => {
    if (depth <= 0 || rng() < 0.25) {
      const r = rng();
      if (r < 0.45) return makeCard(n++);
      if (r < 0.6) return `牌名 ♠7 这种字符串不该被当成牌`;
      if (r < 0.75) return 7;
      return null;
    }
    if (rng() < 0.4) return Array.from({ length: 1 + Math.floor(rng() * 3) }, () => build(depth - 1));
    const obj = {};
    for (let i = 0; i < 1 + Math.floor(rng() * 4); i += 1) obj[pick(KEYS)] = build(depth - 1);
    return obj;
  };

  let compared = 0;
  for (let i = 0; i < 400; i += 1) {
    const payload = build(4);
    const prefixes = pick(PREFIX_SETS);
    const mine = collectLeakedCards(payload, prefixes);
    const ref = referenceCollect(payload, prefixes);
    assert.deepEqual(
      mine.map(l => `${l.path}|${l.card.id}`).sort(),
      ref.map(l => `${l.path}|${l.card.id}`).sort(),
      `第 ${i} 个 payload 上两个实现结果不同（白名单 ${JSON.stringify(prefixes)}）`
    );
    compared += ref.length;
  }
  assert.ok(compared > 200, `随机 payload 里得真的出现过泄露才有意义，实际只有 ${compared} 条`);
});
