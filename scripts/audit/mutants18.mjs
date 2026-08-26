// 变异测试：Glen 第 4 条「求完件要甩」—— 甩得出去的那一门，不许再一张一张领。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
const BLOCK = `  if (throwSuit) {
    const victims = [...proposals].filter(([, proposal]) =>
      proposal.cards.length === 1 && suitOf(proposal.cards[0], ctx) === throwSuit
    );
    // 兜底：全删光了就没牌可领了（chooseLeadCards 会返回空数组）。
    // ⚠️ 现在【推得出】这一行永远为真，但它留着：
    //   · 提了甩牌案时，那个多张提案自己不在 victims 里，必然剩一个；
    //   · 计划性压住不甩时 plan 一定存在 → control.holdsTopTrump → 我手上
    //     至少有一张主，主牌的单张提案花色是 TRUMP，也不在 victims 里。
    // 第二条撑在 holdsTopTrump 的内部实现上，隔着两个函数。真塌了的代价是
    // 电脑领牌返回空数组（真人正在打的局里直接卡死），而代价只是一次比较。
    if (victims.length < proposals.size) {
      for (const [key] of victims) proposals.delete(key);
    }
  }`;

runMutants([
  // ---- 让位本身 ----
  [F, BLOCK, '', '整段让位删掉 —— 退回「甩得出去却一张一张领」'],
  [F, '      proposal.cards.length === 1 && suitOf(proposal.cards[0], ctx) === throwSuit',
      '      proposal.cards.length === 1',
      '不看花色，把【所有】单张提案都删掉（别的门也不许领了）'],
  [F, '      proposal.cards.length === 1 && suitOf(proposal.cards[0], ctx) === throwSuit',
      '      suitOf(proposal.cards[0], ctx) === throwSuit',
      '连甩牌提案自己也一起删（它的花色也等于 throwSuit）'],

  // ---- 挂钩点 ----
  // 计划性压住不甩的那一门也要让位 —— 这是「整门是一件武器」那一档
  [F, '  const throwSuit = throwCards ? suitOf(throwCards[0], ctx) : null;',
      `  const throwSuit =
    throwCards && !(plan !== null && suitOf(throwCards[0], ctx) === plan.suit && !plan.ready)
      ? suitOf(throwCards[0], ctx) : null;`,
      '只保护「现在就能甩」的那一门，留着甩尾巴的那门照拆不误'],
]);
