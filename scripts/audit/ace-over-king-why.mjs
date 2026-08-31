// 「对手已经打了 K，我跟牌用 A 去砍」—— 最终【选中】那一手是怎么出来的？
// 在 chooseFollowCards 的返回处插桩：只记那些真的打出了同门 A、
// 而且我这门还有别的牌（不是被逼的）的决策，看护件硬闸有没有挡过它。
import fs from 'node:fs';
const F = 'server/bot-policy.js';
const src = fs.readFileSync(F, 'utf8');
const restore = () => fs.writeFileSync(F, src);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const OLD = `  return pool
    .sort((a, b) =>`;
const NEW = `  if (globalThis.__why) {
    const picked = pool.slice().sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id))[0];
    const ace = picked?.cards.find(c => isSidePiece(c, ctx) && c.rank === 14);
    if (ace) {
      const suit = suitOf(ace, ctx);
      const before = (view.round.currentTrick ?? []).some(p =>
        (p.seat % 2) !== (view.you.seat % 2) &&
        (p.cards ?? []).some(c => isSidePiece(c, ctx) && c.rank === 13 && suitOf(c, ctx) === suit));
      const spent = picked.cards.filter(x => suitOf(x, ctx) === suit).length;
      const left = cardsOfSuit(view.you.hand ?? [], suit, ctx).length - spent;
      if (before && left > 0) {
        const items = view.round?.piecesView?.[suit] ?? [];
        globalThis.__why.push({
          blocked: pieceOwedToOpponentAsk(view, ctx, picked.cards),
          fellBack: sparing.length === 0,
          onlyChoice: choices.length === 1,
          unseen: items.filter(x => x.status === 'unseen').length,
          held: items.filter(x => x.status === 'mine').length,
          signal: suitAskSignal(view, ctx, suit),
          left, pts: (view.round?.currentTrick ?? []).flatMap(p => p.cards ?? [])
            .reduce((s, c) => s + cardPoints(c), 0),
          bar: pieceAskPointsFor(view, ctx, suit),
          suitTotal: sideSuitTotalPoints(ctx),
          oppLen: maxOpponentSuitEstimate(view, ctx, suit),
          myTrumps: cardsOfSuit(view.you.hand ?? [], 'TRUMP', ctx).length,
        });
      }
    }
  }
  return pool
    .sort((a, b) =>`;
if (!src.includes(OLD)) { console.error('锚点失效'); process.exit(1); }
fs.writeFileSync(F, src.replace(OLD, NEW));
try {
  globalThis.__why = [];
  const { simulateRound } = await import('../../server/simulate-bots.js');
  const N = Number(process.env.N ?? 200);
  for (let i = 0; i < N; i++) await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const rows = globalThis.__why;
  console.log(`${N} 局：真的打出了「同门 A 砍对手的 K」而且这门还有别的牌 —— ${rows.length} 次`);
  console.log(`  闸挡过它但还是打了（全部候选都得交件，兜底）  ${rows.filter(r => r.blocked).length}`);
  console.log(`  闸放行的                                      ${rows.filter(r => !r.blocked).length}`);
  const why = new Map();
  for (const r of rows.filter(r => !r.blocked)) {
    const k = r.unseen === 0 ? `闸第一条：件已全现（我手上还有 ${r.held} 支）`
      : r.signal === 'partner' ? '队友在求这门'
      : r.held >= 2 ? '我有两件'
      : r.suitTotal <= 30 ? '打10/打K，这门天生少分'
      : r.left <= 2 ? `打完只剩 ${r.left} 支`
      : r.pts >= r.bar ? `桌上到线（${r.pts} ≥ ${r.bar}）`
      : '其它';
    why.set(k, (why.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...why.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(v).padStart(4)}  ${k}`);
  const est = rows.map(r => r.oppLen).sort((a, b) => a - b);
  const q = f => est.length ? est[Math.floor(est.length * f)].toFixed(1) : '--';
  console.log(`\n  当时对手这门的【估算】长度：中位 ${q(.5)}，四分位 ${q(.25)} ~ ${q(.75)}，最大 ${Math.max(...est).toFixed(1)}`);
  const myT = rows.map(r => r.myTrumps ?? 0);
  console.log(`  「估算 ≤ 我的主牌数」成立的：${rows.filter(r => r.oppLen <= (r.myTrumps ?? 0)).length}/${rows.length}`);
} finally { restore(); }
