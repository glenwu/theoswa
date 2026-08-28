// 变异测试：Glen 第 4 条「求完件要甩」—— 甩得出去的那一门，不许再一张一张领。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
const BLOCK = `  if (throwableSuits.length > 0) {
    const throwSuits = new Set(throwableSuits);
    const victims = [...proposals].filter(([, proposal]) =>
      proposal.cards.length === 1 && throwSuits.has(suitOf(proposal.cards[0], ctx))
    );
    // 兜底：全删光了就没牌可领了（chooseLeadCards 会返回空数组）。
    // ⚠️ 扩到「所有甩得出去的门」之后这一行【真的会为假】——
    // 手上两门副牌都甩得出去、又一张主都没有时，单张提案会被删干净。
    // 那种局面下这条规矩本来就让不出位置：总得领一张，真人也一样。
    if (victims.length < proposals.size) {
      for (const [key] of victims) proposals.delete(key);
    }
  }`;

runMutants([
  // ---- 让位本身 ----
  [F, BLOCK, '', '整段让位删掉 —— 退回「甩得出去却一张一张领」'],
  [F, '      proposal.cards.length === 1 && throwSuits.has(suitOf(proposal.cards[0], ctx))',
      '      proposal.cards.length === 1',
      '不看花色，把【所有】单张提案都删掉（别的门也不许领了）'],

  // ---- 挂钩点 ----
  // 计划性压住不甩的那一门也要让位 —— 这是「整门是一件武器」那一档。
  // ⚠️ 判据现在【不看 safeSideThrow 挑中哪一门】了（Glen 2026-08-29 裁定，
  // 见 mutants26），所以这里改成直接把「计划挂起的那门」从集合里剔掉，
  // 才还原得出老写法的漏洞。
  [F, '  const throwableSuits = SUITS.filter(suit =>',
      `  const throwableSuits = SUITS.filter(suit =>
    !(plan !== null && suit === plan.suit && !plan.ready) &&`,
      '留着甩尾巴的那门照拆不误（计划挂起时不再护它）'],
]);
