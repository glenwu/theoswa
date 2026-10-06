import { playSuitOf, SUITS } from '../../server/cards.js';
import { canThrowByStatus } from '../../server/pieces.js';

// 哪几门副牌【现在就甩得出去】—— 手牌区给这几门套一圈呼吸光（Glen 2026-10-06）。
//
// 判据和服务端裁甩牌用的是同一份纯函数（trick.js 的 validateLeadPlay → canThrowByStatus）：
// 这门的每一支件都不再「未现」。全凭公开信息，不涉及任何暗牌。
//
// ⚠️ 只算副牌。主牌甩牌是另一套判定（比最小一张大的主牌还在不在别人暗牌里），
// 它不看件，也不是「件出完了就成立」，不能一起亮灯。
// ⚠️ 手上只剩 1 张的门不亮：那是普通领牌，没有「甩」这回事（服务端也只按单张走）。
export function throwReadySuits(game) {
  const round = game?.round;
  if (game?.phase !== 'PLAYING' || !round?.trumpSuit) return new Set();
  const hand = game.you?.hand ?? [];
  const ready = new Set();
  for (const suit of SUITS) {
    if (suit === round.trumpSuit) continue;
    if (!canThrowByStatus(round.piecesView?.[suit])) continue;
    const mine = hand.filter(
      card => playSuitOf(card, round.trumpSuit, round.rankCard) === suit
    ).length;
    if (mine >= 2) ready.add(suit);
  }
  return ready;
}
