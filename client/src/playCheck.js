import { validateLeadPlay, validateFollowPlay } from '../../server/trick.js';

// 客户端本地出牌校验（与服务端共用同一份纯函数）。
// 只用于按钮禁用与提示文案；服务端仍是唯一权威。

export function checkSelection(game, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) {
    return { ok: false, reason: '请选择要出的牌' };
  }
  const you = game.you;
  const round = game.round;
  if (!round) return { ok: false, reason: '未开局' };
  const isLead = !round.currentTrick || round.currentTrick.length === 0;
  if (isLead) {
    return validateLeadPlay(
      {
        hand: you.hand,
        piecesView: round.piecesView,
        trumpSuit: round.trumpSuit,
        rankCard: round.rankCard,
      },
      selectedIds
    );
  }
  const lead = round.currentTrick[0];
  return validateFollowPlay(
    {
      hand: you.hand,
      leadSuit: lead.playSuit,
      leadCount: lead.cards.length,
      trumpSuit: round.trumpSuit,
      rankCard: round.rankCard,
    },
    selectedIds
  );
}
