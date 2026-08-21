import {
  buildDeck,
  separateKitty,
  sortHand,
  sortHandForReveal,
  cardLabel,
} from './cards.js';
import {
  shuffleArray,
  createRoundState,
  playerBySeat,
  pushLog,
} from './state.js';
import { rankOfLevel } from './level.js';
import { nextSeat } from './rotation.js';
import { starterFromFlip } from './reveal.js';

// 开局：整体重建 RoundState（杜绝跨局状态污染），建牌组、洗牌，
// 按庄家是否已定走两条路：
// - 庄家未定（第一局）：完整 108 张用于翻牌定起揭人，此时尚未分离底牌；
// - 庄家已定（第二局起）：先分离 8 张底牌，剩余 100 张揭牌，起揭人 = 庄家。
// 局号 = 已完成局数 + 1（流局不产生摘要，故流局后局号不变）。
export function beginRound(state) {
  const roundNumber = state.rounds.length + 1;
  const rankCard =
    state.declarerSeat === null
      ? 2
      : rankOfLevel(state.teamLevels[state.declarerSeat % 2]); // 升级已生效后的级别
  state.round = createRoundState(roundNumber, state.declarerSeat);
  state.round.rankCard = rankCard;

  const deck = shuffleArray(buildDeck(), state.rng);
  if (state.declarerSeat === null) {
    state.round.deck = deck; // 108 张
  } else {
    state.round.kitty = separateKitty(deck);
    state.round.deck = deck; // 100 张
    state.round.revealTurnSeat = state.declarerSeat;
  }
  return state.round;
}

// 揭牌一次：给 seat 摸一张（调用方保证合法性），逆时针轮转到下家。
// 揭牌阶段每摸一张就重排一次手牌（鬼最左 + 固定花色顺序，级牌提到本组最前），
// 否则手牌是摸牌顺序 = 随机顺序，看着很乱、也没法快速数某门有几张。
// 第一局与第二局起走的都是 REVEALING，所以两种情况都会整理。
// completeDeal 的补发在 DEALING 阶段进行，那时主牌已定，由 sortHand 按主/副重排。
export function drawOneCard(state, seat) {
  const r = state.round;
  const card = r.deck.pop();
  const player = playerBySeat(state, seat);
  player.hand.push(card);
  if (state.phase === 'REVEALING') {
    player.hand = sortHandForReveal(player.hand, r.rankCard);
  }
  r.drawnCount += 1;
  r.revealTurnSeat = nextSeat(seat);
  return card;
}

// REVEAL_FIRST 翻一张牌：
// - 大小王 → 作废重翻（该牌保留在 flipShown 供全员可见）；
// - 点数牌 → 定起揭人，随后点数牌与所有作废王全部放回牌堆重洗，再分离 8 张底牌。
// 每次翻牌都写入 flipEvent（客户端中央大图展示：作废王也要逐张展示，不静默重翻）。
// 返回 { kind: 'JOKER' } 或 { kind: 'STARTER', starterSeat }。
export function flipCardForRevealFirst(state) {
  const r = state.round;
  const card = r.deck.pop();
  r.flipShown.push(card);
  r.flipEvent = { kind: card.suit === 'JOKER' ? 'JOKER' : 'STARTER', card, ts: Date.now() };

  if (card.suit === 'JOKER') {
    pushLog(state, `翻出${cardLabel(card)}，作废重翻`);
    return { kind: 'JOKER', card };
  }

  const starter = starterFromFlip(card.rank, state.flipperSeat);
  r.flipEvent.starterSeat = starter;
  pushLog(state, `翻出${cardLabel(card)}，起揭人：${playerBySeat(state, starter).nickname}`);

  // 翻出的点数牌 + 作废的大小王全部放回重洗，然后分离底牌
  r.deck = shuffleArray([...r.deck, ...r.flipShown], state.rng);
  r.flipShown = [];
  r.kitty = separateKitty(r.deck);
  r.flipDone = true;
  r.revealTurnSeat = starter;
  state.phase = 'REVEALING';
  pushLog(state, '开始揭牌：逆时针逐张揭牌');
  return { kind: 'STARTER', card, starterSeat: starter };
}

// 发牌收尾（DEALING）：亮主提前停止时剩余牌一次性发完（逆时针连续轮转，
// 100 张总量保证四家最终各 25 张），手牌自动排序。
// 然后把 8 张底牌并进庄家手牌（33 张统一排序），庄家换底时从中点选 8 张压回。
export function completeDeal(state) {
  const r = state.round;
  while (r.deck.length > 0) {
    drawOneCard(state, r.revealTurnSeat);
  }
  const ctx = { trumpSuit: r.trumpSuit, rankCard: r.rankCard };
  for (const p of state.players) {
    p.hand = sortHand(p.hand, ctx);
  }
  const declarer = playerBySeat(state, state.declarerSeat);
  declarer.hand = sortHand([...declarer.hand, ...r.kitty], ctx);
  r.kitty = [];
  state.phase = 'KITTY_EXCHANGE';
  pushLog(state, '发牌完成，底牌已并进庄家手牌，请点选 8 张埋回');
  return state;
}
