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
import { settleRound } from '../scoring.js';

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

// 【队友交过来的主牌，庄家埋进底不受罚】—— Glen 2026-09-06 裁定：
//   「队友把 3 张主过河给庄家之后，庄家可不可以把这几张主埋进底？可以。
//     过河惩罚只针对庄家自己发起，和队友无关，这时埋主不受罚。」
//
// ⚠️ 这条【是过河挪到埋底之前才新造出来的局面】：老顺序（先埋底再过河）下，
// 队友给的主牌根本来不及埋。所以它必须单独钉住 —— 判据是 from.seat（发起人），
// 不是 from.team，一字之差就把这条裁定推翻了。
test('过河惩罚：队友发起、庄家把交来的主牌埋进底 → 不算庄家过河，不受罚', () => {
  const state = dealtState({ partnerTrumps: 3 });
  completeDeal(state);
  const declarerSeat = state.declarerSeat;
  const partner = playerBySeat(state, oppositeSeat(declarerSeat));
  const declarer = playerBySeat(state, declarerSeat);

  // 交出【全部】主牌，副牌补足到 3 张（这里主牌正好 3 张，一张都不用补）
  const givenTrumpIds = partner.hand.filter(c => c.suit === 'H').map(c => c.id);
  const give = [
    ...givenTrumpIds,
    ...partner.hand.filter(c => c.suit === 'D').slice(0, 3 - givenTrumpIds.length).map(c => c.id),
  ];
  assert.equal(applyAction(state, { type: 'initiateCrossRiver', cardIds: give }, partner.id).ok, true);
  const back = declarer.hand.filter(c => c.suit === 'S').slice(0, 3).map(c => c.id);
  assert.equal(applyAction(state, { type: 'respondCrossRiver', cardIds: back }, declarer.id).ok, true);
  assert.equal(state.round.declarerCrossedRiver, false,
    '发起人是队友，不是庄家 —— 这一笔不该点亮「庄家过河」');

  // 庄家把队友刚交过来的那 3 张主牌【原样埋进底】，再凑够 8 张
  const hand = playerBySeat(state, declarerSeat).hand;
  const rest = hand.filter(c => !givenTrumpIds.includes(c.id)).slice(0, 8 - givenTrumpIds.length);
  const bury = [...givenTrumpIds, ...rest.map(c => c.id)];
  assert.equal(applyAction(state, { type: 'buryKitty', cardIds: bury }, declarer.id).ok, true);
  for (const id of givenTrumpIds) {
    assert.ok(state.round.kitty.some(c => c.id === id), `队友交来的 ${id} 应当能埋进底`);
  }
  assert.equal(state.round.declarerCrossedRiver, false, '埋了也还是不算庄家过河');

  // 结算口径：底里有主牌，但没触发「庄家过河」→ 惩罚为 0
  const trumpsInKitty = state.round.kitty.filter(c => c.suit === 'H').length;
  assert.ok(trumpsInKitty >= givenTrumpIds.length, '底牌里确实埋进了主牌');
  const settled = settleRound({
    defenderTrickPoints: 90, kittyPoints: 0, kittyGrab: true,
    declarerTeam: declarer.team,
    declarerCrossedRiver: state.round.declarerCrossedRiver,
    trumpsInKitty,
  });
  assert.equal(settled.crossRiverPenalty, 0, '队友发起的那一笔不带惩罚（Glen 裁定）');
});
