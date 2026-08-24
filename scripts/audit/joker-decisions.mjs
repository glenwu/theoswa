// 复核 Glen 的实战反馈③：「鬼还是有乱出的情况。」
//
// ⚠️ 口径要比 bigcard-decisions.mjs 严：那边的「有替代选项」要求替代项
// 【一张大牌都不含】，于是「拿大鬼去顶、其实可以拿主级牌顶」这种被算成没得选。
// 这里只问一件事：候选里有没有【不含鬼】的一组？有就是自己选的。
// 在领牌和跟牌两个出口各插一次桩，用 mutate.mjs 同款的内存还原。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/bot-policy.js';
const src = fs.readFileSync(F, 'utf8');
const N = process.env.N ?? '400';
const restore = () => fs.writeFileSync(F, src);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const HELPER = `
const __jk = c => c.rank === 15 || c.rank === 16;
const __log = (where, cards, ranked, view, ctx, pts, won, scored) => {
  const mine = cards.filter(__jk);
  if (mine.length === 0) return;
  const free = ranked.filter(set => !set.some(__jk));
  // 「不含鬼、而且照样赢得下这一墩」的选项 —— 有这个还打鬼，才是真浪费
  let best = null;
  const freeWins = where === '跟牌' && free.some((set, i) => {
    const led = trickLeader([...view.round.currentTrick, { seat: view.you.seat, cards: set }], ctx);
    if (led?.seat !== view.you.seat) return false;
    if (best === null) best = i;
    return true;
  });
  // 一次交两只鬼：候选里有没有【最大牌力一模一样、但鬼更少】的一组？
  // 判牌只比最大那一张，所以牌力相同 = 安全性完全相同，鬼少的那组严格更优。
  let cheaper = null;
  if (mine.length > 1 && where === '跟牌') {
    const strongest = Math.max(...cards.map(c => cardStrength(c, ctx)));
    for (const set of ranked) {
      if (set.filter(__jk).length >= mine.length) continue;
      if (Math.max(...set.map(c => cardStrength(c, ctx))) !== strongest) continue;
      cheaper = set.map(c => c.suit + c.rank);
      break;
    }
  }
  // 不只看候选生成器给了什么，直接看手牌本身允不允许更省的打法：
  // 毙/跟主都要满额 N 张主牌，手上非鬼的主牌够不够凑出 N-1 张？
  const handTrumps = mine.length > 1 && where === '跟牌'
    ? cardsOfSuit(view.you.hand, 'TRUMP', ctx).filter(c => !__jk(c)).length
    : null;
  const cands = mine.length > 1 && where === '跟牌'
    ? ranked.slice(0, 12).map(set => set.map(c => c.suit + c.rank).join('+'))
    : null;
  const scores = mine.length > 1 && where === '跟牌' && scored ? scored.all : null;
  const hand12 = mine.length > 1 && where === '跟牌'
    ? view.you.hand.map(c => c.suit + c.rank) : null;
  const lead12 = mine.length > 1 && where === '跟牌'
    ? view.round.currentTrick.map(p => p.seat + ':' + p.cards.map(c => c.suit + c.rank).join('+')) : null;
  console.error('JK ' + JSON.stringify({
    cheaper, handTrumps, cands, hand12, lead12, trump: ctx.trumpSuit, rc: ctx.rankCard, scores,
    defPts: view.round.defenderTrickPoints, hist: (view.round.trickHistory ?? []).length,
    where, n: mine.length, big: mine.some(c => c.rank === 16),
    alt: free.length > 0, freeWins,
    pts, won, hand: view.you.hand.length,
    trick: (view.round.trickHistory ?? []).length,
    leadN: view.round.currentTrick[0]?.cards.length ?? 0,
    leadSuit: view.round.currentTrick[0]?.playSuit ?? null,
    seat: view.you.seat, dec: view.declarerSeat,
    behind: 3 - view.round.currentTrick.length,
    played: cards.map(c => c.suit + c.rank),
    freeBest: freeWins ? free[best].map(c => c.suit + c.rank) : null,
    gap: scored ? Math.round(scored.pick - scored.free) : null,
  }));
};
`;
const LEAD_OLD = `    )[0]?.cards ?? [];
}`;
const LEAD_NEW = `    );
  const __w = __ranked[0]?.cards ?? [];
  __log('领牌', __w, __ranked.map(p => p.cards), view, ctx, 0, true);
  return __w;
}
${HELPER}`;
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
  const __pts = round.currentTrick.flatMap(p => p.cards).reduce((s, c) => s + cardPoints(c), 0) +
    __picked.reduce((s, c) => s + cardPoints(c), 0);
  const __win = trickLeader([...round.currentTrick, { seat: view.you.seat, cards: __picked }], ctx);
  const __freeScored = __r.filter(c => !c.cards.some(__jk));
  __log('跟牌', __picked, __r.map(c => c.cards), view, ctx, __pts,
    __win?.seat % 2 === view.you.team,
    __r.length
      ? { pick: __r[0].score + (priorBonus.get(__r[0]) ?? 0),
          free: Math.max(...__freeScored.map(c => c.score + (priorBonus.get(c) ?? 0))),
          all: __r.slice(0, 12).map(c => Math.round(c.score + (priorBonus.get(c) ?? 0))) }
      : null);
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
