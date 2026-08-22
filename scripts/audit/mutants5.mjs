
import { runMutants } from './mutate.mjs';

// 「吊主候选里不含鬼」「不挑主级牌」这两条已经移到 mutants4（和吊主的其它开关放一起）。
const F = 'server/bot-policy.js';
runMutants([
  [F, "if (mode === 'low') return lowestLead(trumps, ctx);", 'if (false) return lowestLead(trumps, ctx);', '一律吊大牌（回到实战踩到的 bug）'],
  [F, 'return highCards(drawable.length ? drawable : trumps, 1, ctx)[0];',
      'return lowestLead(drawable.length ? drawable : trumps, ctx);', '该吊大牌时反而吊小牌'],
  [F, "mode: clearing ? 'clearing' : planPending ? 'tier' : 'low',",
      "mode: clearing ? 'clearing' : 'tier',", '开局之后一律吊大牌（不看甩尾手计划挂没挂起）'],
  [F, 'card => card.rank === missingRank && card.rank !== ctx.rankCard', 'card => card.rank === 13 && card.rank !== ctx.rankCard', '三件求件回到写死打 K'],
  [F, 'options.push({ card: probe, score: 300 + cards.length });', 'options.push({ card: probe, score: 100 + cards.length });', '三件规则分数被通用探件盖过'],
  [F, "if (!last || last.leadSuit === 'TRUMP') return null;", 'if (!last) return null;', '队友改吊主了还回他副牌'],
  [F, '  const last = leads[leads.length - 1];\n  if (!last || last.leadSuit', '  const last = leads[0];\n  if (!last || last.leadSuit', '只认队友第一次领牌（信号不过期）'],
  [F, 'const request = continuationPiece ? null : partnerRequest(view, ctx);', 'const request = partnerRequest(view, ctx);', '续件时仍提「回队友门」，把续件盖掉'],
]);
