// 变异测试：Glen「对手在求的那门不主动去领，让他们出，我方最后下」。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, `    const helping = [...proposals].filter(([, proposal]) => {
      if (proposal.cards.length !== 1) return false;
      const suit = suitOf(proposal.cards[0], ctx);
      if (suit === 'TRUMP') return false;
      return opponentAskOpen(view, ctx, suit) && !suitThrowAmbition(view, ctx, suit, tuning);
    });
    if (helping.length < proposals.size) {
      for (const [key] of helping) proposals.delete(key);
    }`, '',
      '整段删掉 —— 照旧替对手把他求的那门逼出来'],
  [F, '      return opponentAskOpen(view, ctx, suit) && !suitThrowAmbition(view, ctx, suit, tuning);',
      '      return opponentAskOpen(view, ctx, suit);',
      '这门是我自己的武器也不许领（例外没了）'],
  [F, '      return opponentAskOpen(view, ctx, suit) && !suitThrowAmbition(view, ctx, suit, tuning);',
      '      return !suitThrowAmbition(view, ctx, suit, tuning);',
      '不看对手有没有求过 —— 凡是自己不强的门都不许领'],
  [F, `    suitAskSignal(view, ctx, suit) === 'opponent' &&
    (view.round?.piecesView?.[suit] ?? []).some(item => item.status === 'unseen')`,
      "    suitAskSignal(view, ctx, suit) === 'opponent'",
      '件已经逼完了还躲着这门不领'],
  [F, `    suitAskSignal(view, ctx, suit) === 'opponent' &&`,
      `    suitAskSignal(view, ctx, suit) === 'partner' &&`,
      '判反：躲的是队友求的那门（那门恰恰该去帮）'],
]);
