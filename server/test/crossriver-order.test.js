// 三主过河的【顺序】—— Glen 2026-09-06：
//   「三主过河如果是庄家的队友要给庄家，应该先过河之后再埋底。」
//
// 队友把主牌交给庄家之后庄家才埋底，庄家才是拿【最终的手牌】在埋。
// 原来是「埋底 → 过河」：庄家埋完 8 张才收到 3 张主，还得倒贴 3 张副牌出去，
// 那 8 张等于白埋了。
//
// 现在拆成两轮：发牌完 → 过河①（只开给庄家的队友）→ 换底 → 过河②（其余）→ 出牌。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction, expireCrossRiverDecision } from '../actions.js';
import { completeDeal } from '../round.js';
import { crossRiverCandidates } from '../crossriver.js';
import { countTrump } from '../cards.js';
import { oppositeSeat } from '../rotation.js';

const card = (id, suit, rank) => ({ id, suit, rank });

// 发牌刚完、底牌已并进庄家手牌的那一刻。
// partnerTrumps 控制庄家【队友】手上有几张主（主花色 H），过河资格就看它。
function dealtState({ partnerTrumps }) {
  const state = createInitialState(() => 0.42);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  const declarerSeat = state.seatsByPlayer.T;
  state.declarerSeat = declarerSeat;
  state.round = createRoundState(1, declarerSeat);
  const r = state.round;
  r.trumpSuit = 'H';
  r.rankCard = 2;
  r.deck = [];
  r.revealTurnSeat = declarerSeat;
  r.kitty = Array.from({ length: 8 }, (unused, i) => card(`kitty-${i}`, 'C', 3 + i));

  const partnerSeat = oppositeSeat(declarerSeat);
  for (const p of state.players) {
    if (p.seat === declarerSeat) {
      // 庄家：25 张，主牌很多（他自己绝不该够格发起过河）
      p.hand = [
        ...Array.from({ length: 10 }, (unused, i) => card(`d-h-${i}`, 'H', 3 + i)),
        ...Array.from({ length: 15 }, (unused, i) => card(`d-s-${i}`, 'S', 3 + (i % 10))),
      ];
    } else if (p.seat === partnerSeat) {
      // 队友：主牌张数由参数控制，其余全副牌
      p.hand = [
        ...Array.from({ length: partnerTrumps }, (unused, i) => card(`p-h-${i}`, 'H', 5 + i)),
        ...Array.from({ length: 25 - partnerTrumps }, (unused, i) =>
          card(`p-d-${i}`, 'D', 3 + (i % 10))),
      ];
    } else {
      // 两个闲家：主牌一张都没有 —— 他们【也够格】发起过河，
      // 正好用来验「埋底前那一轮不开给他们」。
      p.hand = Array.from({ length: 25 }, (unused, i) => card(`o${p.seat}-${i}`, 'C', 3 + (i % 10)));
    }
  }
  state.phase = 'DEALING';
  return state;
}

test('过河顺序：庄家队友主牌 ≤3 → 发牌完先开过河，而且只开给他一个人', () => {
  const state = dealtState({ partnerTrumps: 3 });
  completeDeal(state);

  assert.equal(state.phase, 'CROSS_RIVER', '发牌完应当先进过河，而不是直接换底');
  assert.equal(state.round.crossRiver.stage, 'before-bury');
  const partnerSeat = oppositeSeat(state.declarerSeat);
  assert.deepEqual(crossRiverCandidates(state), [partnerSeat],
    '埋底前这一轮只有庄家的队友能发起（两个闲家主牌为 0，同样够格，但不该出现在这里）');
  // 庄家手上还是 33 张：底牌已并进来，还没埋
  assert.equal(playerBySeat(state, state.declarerSeat).hand.length, 33);
});

test('过河顺序：庄家队友主牌 >3 → 没人够格，照旧直接进换底', () => {
  const state = dealtState({ partnerTrumps: 4 });
  completeDeal(state);
  assert.equal(state.phase, 'KITTY_EXCHANGE');
  assert.equal(state.round.crossRiver.stage, 'after-bury', '没开成的那一轮要把 stage 还原');
  assert.equal(state.round.kittyDeadline, null, '换底的倒计时由引擎重新起算');
});

test('过河顺序：队友跳过 → 立刻进换底（不用干等满决定窗口）', () => {
  const state = dealtState({ partnerTrumps: 2 });
  completeDeal(state);
  const partnerSeat = oppositeSeat(state.declarerSeat);
  const partnerId = state.players.find(p => p.seat === partnerSeat).id;
  assert.equal(applyAction(state, { type: 'skipCrossRiver' }, partnerId).ok, true);
  assert.equal(state.phase, 'KITTY_EXCHANGE');
});

test('过河顺序：队友的主牌先到庄家手上，庄家【再】埋底', () => {
  const state = dealtState({ partnerTrumps: 2 });
  completeDeal(state);
  const declarerSeat = state.declarerSeat;
  const partnerSeat = oppositeSeat(declarerSeat);
  const partner = playerBySeat(state, partnerSeat);
  const declarer = playerBySeat(state, declarerSeat);
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const before = countTrump(declarer.hand, ctx);

  // 队友交出全部主牌（2 张）+ 1 张副牌补足 3 张
  const give = [...partner.hand.filter(c => c.suit === 'H'), partner.hand.find(c => c.suit === 'D')];
  assert.equal(
    applyAction(state, { type: 'initiateCrossRiver', cardIds: give.map(c => c.id) }, partner.id).ok,
    true
  );
  // 庄家回 3 张副牌
  const back = declarer.hand.filter(c => c.suit === 'S').slice(0, 3);
  assert.equal(
    applyAction(state, { type: 'respondCrossRiver', cardIds: back.map(c => c.id) }, declarer.id).ok,
    true
  );

  assert.equal(state.phase, 'KITTY_EXCHANGE', '过河走完才轮到换底');
  assert.equal(playerBySeat(state, declarerSeat).hand.length, 33, '庄家手上仍是 33 张，还没埋');
  assert.equal(countTrump(playerBySeat(state, declarerSeat).hand, ctx), before + 2,
    '队友那 2 张主牌应当在【埋底之前】就到了庄家手上');
  assert.equal(countTrump(playerBySeat(state, partnerSeat).hand, ctx), 0, '队友的主牌全交出去了');
});

test('过河顺序：庄家一方埋底前过完河，埋底后不能再过一次（每队每局一次）', () => {
  const state = dealtState({ partnerTrumps: 2 });
  completeDeal(state);
  const declarerSeat = state.declarerSeat;
  const partner = playerBySeat(state, oppositeSeat(declarerSeat));
  const declarer = playerBySeat(state, declarerSeat);

  const give = [...partner.hand.filter(c => c.suit === 'H'), partner.hand.find(c => c.suit === 'D')];
  applyAction(state, { type: 'initiateCrossRiver', cardIds: give.map(c => c.id) }, partner.id);
  const back = declarer.hand.filter(c => c.suit === 'S').slice(0, 3);
  applyAction(state, { type: 'respondCrossRiver', cardIds: back.map(c => c.id) }, declarer.id);
  assert.deepEqual(state.round.crossRiver.doneTeams, [declarer.team]);

  // 庄家埋 8 张
  const bury = playerBySeat(state, declarerSeat).hand.slice(0, 8).map(c => c.id);
  assert.equal(applyAction(state, { type: 'buryKitty', cardIds: bury }, declarer.id).ok, true);
  assert.equal(state.phase, 'CROSS_RIVER');
  assert.equal(state.round.crossRiver.stage, 'after-bury');
  // ⚠️ 这一条是第一版真踩过的坑：handleBuryKitty 原来会把 doneTeams 清空，
  // 于是庄家一方埋底前刚过完河，埋底后名额又刷新了 —— 一局过两次。
  assert.deepEqual(state.round.crossRiver.doneTeams, [declarer.team], '名额必须跨两轮继承');
  assert.ok(
    !crossRiverCandidates(state).some(seat => seat % 2 === declarer.team),
    '庄家一方本局的过河名额已经用掉了'
  );

  expireCrossRiverDecision(state);
  assert.ok(['PLAYING', 'DOMINANCE'].includes(state.phase), `过河② 走完应当进出牌，实际 ${state.phase}`);
});
