// Glen 2026-08-29：「BOT 做庄时开始吊主，后来还是容易忘记，打成副牌了，
//   特别是庄家队友，也是容易打成副牌，这个时候还没保底牌，吊主还是必要的，
//   除非副牌比较强，有可能可以保底。」
//
// 在 chooseLeadCards 的出口插桩，把每一次领牌的判据一起打出来：
//   role / 有没有保底牌 / 副牌强不强 / 甩尾计划挂着没 / 吊主提案给了多少分 /
//   最后胜出的是哪条提案。
// 「该吊没吊」= 角色是庄家一方 + 没保底 + 副牌不强 + 外面还有主 + 手上有可吊的主，
// 结果领的却是副牌。
import fs from 'node:fs';
const F = 'server/bot-policy.js';
const src = fs.readFileSync(F, 'utf8');
const restore = () => fs.writeFileSync(F, src);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const OLD = `  const early = hand.length > 8;
  return [...proposals.values()]`;
const NEW = `  const early = hand.length > 8;
  if (globalThis.__draw) {
    const ranked = [...proposals.values()].map(p => {
      const pointValue = p.cards.reduce((s, c) => s + cardPoints(c), 0);
      const preserveCost = p.cards.reduce((s, c) => s + keepValue(c, ctx), 0);
      const generic =
        -preserveCost * 0.25 * tuning.preserveWeight -
        (hand.length > 8 ? pointValue * 8 * tuning.pointExposureWeight : 0) +
        (p.cards.length > 1 ? p.cards.length * 12 : 0);
      return { tag: p.tag, score: p.bonus + generic, suit: suitOf(p.cards[0], ctx) };
    }).sort((a, b) => b.score - a.score);
    globalThis.__draw.push({
      role, guaranteed: !!control.guaranteed, strongSide, planPending,
      outstandingTrumps, drawPool: drawPool.length, strategy,
      helpingOpponentDraw,
      openedSide: declarerOpenedSide(view),
      answeredSignal: hasBigJoker && declarerTrumpPointSignal(view, ctx),
      signalAnswered: role === 'declarer' && trumpSignalAnswered(view, ctx),
      winner: ranked[0]?.tag ?? null, winnerSuit: ranked[0]?.suit ?? null,
      drawScore: ranked.find(r => r.tag === 'continue-trump-draw')?.score ?? null,
      runnerUp: ranked[1]?.tag ?? null,
    });
  }
  return [...proposals.values()]`;
if (!src.includes(OLD)) { console.error('锚点失效'); process.exit(1); }
fs.writeFileSync(F, src.replace(OLD, NEW));

try {
  globalThis.__draw = [];
  const { simulateRound } = await import('../../server/simulate-bots.js');
  const N = Number(process.env.N ?? 200);
  for (let i = 0; i < N; i++) await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });

  const rows = globalThis.__draw.filter(r =>
    (r.role === 'declarer' || r.role === 'declarerPartner') &&
    !r.guaranteed && !r.strongSide && r.outstandingTrumps > 0 && r.drawPool > 0
  );
  const led = r => r.winnerSuit === 'TRUMP';
  const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
  console.log(`${N} 局：「庄家一方 + 没保底 + 副牌不强 + 外面还有主 + 手上有主可吊」的领牌 ${rows.length} 次`);
  for (const role of ['declarer', 'declarerPartner']) {
    const sub = rows.filter(r => r.role === role);
    const ok = sub.filter(led).length;
    console.log(`  ${role.padEnd(16)} 吊了 ${ok}/${sub.length}\t${pct(ok, sub.length)}`);
  }
  console.log('\n没吊的时候，是谁赢了提案：');
  const miss = rows.filter(r => !led(r));
  const by = new Map();
  for (const r of miss) by.set(r.winner, (by.get(r.winner) ?? 0) + 1);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log('\n没吊的时候，吊主提案本身有没有被提出来：');
  console.log(`  提了但输了 ${miss.filter(r => r.drawScore !== null).length}`);
  console.log(`  压根没提   ${miss.filter(r => r.drawScore === null).length}`);
  const notProposed = miss.filter(r => r.drawScore === null);
  const why = new Map();
  for (const r of notProposed) {
    const k = r.helpingOpponentDraw ? '不帮对手吊主'
      : r.role === 'declarerPartner' && r.openedSide ? '队友：庄家首出打的就是副牌（他说够保底）'
      : r.role === 'declarerPartner' && r.answeredSignal ? '队友：我有大鬼，转副牌就是应答'
      : r.role === 'declarer' && r.signalAnswered ? '庄家：队友已应答「不用吊主」'
      : r.strategy === 'points-first' ? '策略已转跑分为主'
      : '其它';
    why.set(k, (why.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...why.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(v).padStart(4)}  ${k}`);
  console.log('\n按角色拆：');
  for (const role of ['declarer', 'declarerPartner']) {
    const sub = notProposed.filter(r => r.role === role);
    const w = new Map();
    for (const r of sub) {
      const k = r.helpingOpponentDraw ? '不帮对手吊主'
        : r.role === 'declarerPartner' && r.openedSide ? '庄家首出打的就是副牌'
        : r.role === 'declarerPartner' && r.answeredSignal ? '我有大鬼，转副牌就是应答'
        : r.role === 'declarer' && r.signalAnswered ? '队友已应答「不用吊主」'
        : r.strategy === 'points-first' ? '策略已转跑分为主'
        : '其它';
      w.set(k, (w.get(k) ?? 0) + 1);
    }
    console.log(`  ${role}（${sub.length} 次没提）`);
    for (const [k, v] of [...w.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`      ${String(v).padStart(4)}  ${k}`);
  }
} finally { restore(); }
