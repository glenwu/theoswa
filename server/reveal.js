import { nextSeat, oppositeSeat, prevSeat } from './rotation.js';
import { pushLog } from './state.js';
import { SUIT_NAMES } from './constants.js';

// 翻牌定起揭人（仅第一局）：A=1，2..10 面值，J=11，Q=12，K=13。
// 点数 n % 4：1 = 翻牌人自己，2 = 下家，3 = 对家，0 = 上家。
// 调用方保证 rank 不是大小王（大小王作废重翻）。
export function starterFromFlip(rank, flipperSeat) {
  const n = rank === 14 ? 1 : rank; // A = 1
  const r = n % 4;
  if (r === 1) return flipperSeat;
  if (r === 2) return nextSeat(flipperSeat);
  if (r === 3) return oppositeSeat(flipperSeat);
  return prevSeat(flipperSeat); // r === 0
}

// 揭底定主（第2局起无人亮牌）：
// fallbackSuit = 第一张非大小王的牌的花色（遇王跳过）；
// 底牌中出现级牌 → 以第一个级牌的花色为主牌；否则用 fallbackSuit。
export function fallbackTrumpOf(cards, rankCard) {
  let fallbackSuit = null;
  for (const c of cards) {
    if (c.suit !== 'JOKER' && fallbackSuit === null) fallbackSuit = c.suit;
  }
  let trump = null;
  for (const c of cards) {
    if (c.rank === rankCard) {
      trump = c.suit;
      break;
    }
  }
  return { fallbackSuit, trumpSuit: trump ?? fallbackSuit };
}

// 底牌 8 张全部公开摊开后定主，庄家不变 → 进入 DEALING
export function settleFallbackTrump(state) {
  const r = state.round;
  const { fallbackSuit, trumpSuit } = fallbackTrumpOf(r.fallbackRevealed, r.rankCard);
  r.fallbackSuit = fallbackSuit;
  r.trumpSuit = trumpSuit;
  // 定主的那张底牌（客户端大图展示：级牌定主 → 那张级牌；否则首张非王）
  const trumpCard =
    r.fallbackRevealed.find(c => c.rank === r.rankCard) ??
    r.fallbackRevealed.find(c => c.suit !== 'JOKER') ??
    null;
  r.fallbackTrumpCard = trumpCard;
  state.phase = 'DEALING';
  pushLog(state, `无人亮主，揭底定主：主牌为 ${SUIT_NAMES[trumpSuit]}（庄家不变）`);
  return trumpSuit;
}
