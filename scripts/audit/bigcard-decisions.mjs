// 复核大牌（大鬼 / 小鬼 / 主级牌 / 副件）的出牌质量。
//
// ⚠️ 关键是口径：只统计【候选里确实存在不含大牌的一组、却仍然把大牌交出去】的决策。
// 光看 trickHistory 会把「被规则逼的」也算进去 —— 首家领主牌、我手上只剩鬼，
// 必须跟，那不是判断问题。第一版粗口径量出「小鬼白打 12%、主级牌 16%」，
// 换成这个口径之后纯亏只有 4 次 / 300 局，差了两个数量级。
//
// 在两个决策出口插桩：领牌和跟牌，各自对比「选中的那组」和「候选里有没有不含大牌的一组」。
// 用 mutate.mjs 同款的「内存存原文 + finally 还原」，不碰任何手写备份文件。
//
//   node scripts/audit/bigcard-decisions.mjs 2>&1 | grep '^BIG ' | sed 's/^BIG //' > big.jsonl
//
// 每行一条决策：{ where, kinds, hadAlt, points, won, hand }，自己按需聚合。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/bot-policy.js';
const src = fs.readFileSync(F, 'utf8');
const N = process.env.N ?? '300';
const restore = () => fs.writeFileSync(F, src);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const HELPER = `
function __bigKind(card, ctx) {
  if (card.rank === 16) return '大鬼';
  if (card.rank === 15) return '小鬼';
  if (card.rank === ctx.rankCard && card.suit === ctx.trumpSuit) return '主级牌';
  if (isSidePiece(card, ctx)) return '副件';
  return null;
}
`;
const LEAD_OLD = `    )[0]?.cards ?? [];
}

function followCandidates(view, ctx) {`;
const LEAD_NEW = `    );
  const __w = __ranked[0];
  if (__w) {
    const kinds = __w.cards.map(c => __bigKind(c, ctx)).filter(Boolean);
    if (kinds.length > 0) {
      const alt = __ranked.some(p => p.cards.every(c => !__bigKind(c, ctx)));
      console.error('BIG ' + JSON.stringify({ where: '领牌', kinds, hadAlt: alt,
        points: 0, won: true, hand: hand.length }));
    }
  }
  return __w?.cards ?? [];
}
${HELPER}
function followCandidates(view, ctx) {`;

const FOLLOW_OLD = `  return choices
    .sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id)
    )[0].cards;
}`;
const FOLLOW_NEW = `  const __r = choices.sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id));
  const __picked = __r[0].cards;
  const __kinds = __picked.map(c => __bigKind(c, ctx)).filter(Boolean);
  if (__kinds.length > 0) {
    const alt = __r.some(ch => ch.cards.every(c => !__bigKind(c, ctx)));
    const pts = round.currentTrick.flatMap(p => p.cards).reduce((s, c) => s + cardPoints(c), 0) +
      __picked.reduce((s, c) => s + cardPoints(c), 0);
    const win = trickLeader([...round.currentTrick, { seat: view.you.seat, cards: __picked }], ctx);
    console.error('BIG ' + JSON.stringify({ where: '跟牌', kinds: __kinds, hadAlt: alt,
      points: pts, won: win?.seat === view.you.seat, hand: view.you.hand.length }));
  }
  return __picked;
}`;
if (!src.includes(LEAD_OLD) || !src.includes(FOLLOW_OLD)) { console.error('锚点失效'); process.exit(1); }
fs.writeFileSync(F, src
  .replace('  return [...proposals.values()]', '  const __ranked = [...proposals.values()]')
  .replace(LEAD_OLD, LEAD_NEW).replace(FOLLOW_OLD, FOLLOW_NEW));
try {
  execFileSync('node', ['scripts/audit/bigcard-run.mjs'], {
    stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 1 << 28, env: { ...process.env, N },
  });
} finally { restore(); }
