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
      // ⚠️ 提案对象上没有 tag，理由存在 reasons 数组里（addProposal 对同一张牌
      // 是累加的，所以一张牌可能挂着好几条理由）。第一版写成 p.tag，
      // 于是 winner 全是 null、drawScore 全是 null —— 「压根没提」的结论是假的。
      return { tags: p.reasons ?? [], score: p.bonus + generic, suit: suitOf(p.cards[0], ctx) };
    }).sort((a, b) => b.score - a.score);
    globalThis.__draw.push({
      role, guaranteed: !!control.guaranteed, strongSide, planPending,
      outstandingTrumps, drawPool: drawPool.length, strategy,
      helpingOpponentDraw,
      opening,
      partnerLine: partnerLine(view, ctx),
      partnerLeads: (view.round?.trickHistory ?? [])
        .filter(t => !t.virtual && t.leadSeat === partnerSeatOf(view.you.seat))
        .map(t => t.leadSuit + (t.winnerSeat === partnerSeatOf(view.you.seat) ? '*' : ''))
        .join(','),
      strongSideNow: strongSide,
      guaranteedNow: control.guaranteed,
      trumpCount: trumps.length,
      oppTrumpEst: maxOpponentTrumpEstimate(view, ctx),
      openedSide: declarerOpenedSide(view),
      answeredSignal: hasBigJoker && declarerTrumpPointSignal(view, ctx),
      signalAnswered: role === 'declarer' && trumpSignalAnswered(view, ctx),
      winner: (ranked[0]?.tags ?? []).join('+') || null,
      winnerSuit: ranked[0]?.suit ?? null,
      drawScore: ranked.find(r => r.tags.includes('continue-trump-draw'))?.score ?? null,
      winnerScore: ranked[0]?.score ?? null,
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

  // 主家 = 有明确可行的保底/撬底策略的一家（Glen 2026-08-30）——
  // 对上代码里的 roundStrategy：不是 points-first 就算有策略。
  const all = globalThis.__draw;
  const byRole = new Map();
  for (const r of all) {
    const k = `${r.role}｜${r.strategy === 'points-first' ? '不是主家' : '主家'}`;
    const row = byRole.get(k) ?? { n: 0, drew: 0 };
    row.n += 1;
    if (r.winnerSuit === 'TRUMP') row.drew += 1;
    byRole.set(k, row);
  }
  const defs = all.filter(r => r.role === 'defender');
  const pl = defs.filter(r => r.partnerLine === 'trump');
  console.log(`【闲家领牌 ${defs.length} 次，其中「队友走吊主这条线」${pl.length} 次】`);
  const shapes = new Map();
  for (const r of defs) shapes.set(r.partnerLeads, (shapes.get(r.partnerLeads) ?? 0) + 1);
  console.log(`  队友领牌里含 TRUMP 的样本：${defs.filter(r => r.partnerLeads.includes('TRUMP')).length}`);
  console.log(`  队友领过 >=2 次的样本：${defs.filter(r => r.partnerLeads.split(',').filter(Boolean).length >= 2).length}`);
  console.log('  队友领牌的线路（* = 他赢下这一墩），出现最多的 12 种：');
  for (const [k, v] of [...shapes.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 12))
    console.log(`    ${String(v).padStart(4)}  ${k === '' ? '（他还没领过牌）' : k}`);
  if (pl.length) {
    console.log(`  这 ${pl.length} 次里：吊了主 ${pl.filter(r => r.winnerSuit === 'TRUMP').length}`);
    console.log(`  被外层门挡住的：够保底 ${pl.filter(r => r.guaranteedNow).length}` +
      `，副牌强 ${pl.filter(r => r.strongSideNow && !r.planPending).length}` +
      `，开局 ${pl.filter(r => r.opening).length}` +
      `，不帮对手吊 ${pl.filter(r => r.helpingOpponentDraw).length}` +
      `，没主可吊 ${pl.filter(r => r.drawPool === 0).length}`);
  }
  console.log('');
  console.log('【按「是不是主家」拆的领牌与吊主率】');
  for (const [k, v] of [...byRole.entries()].sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${k.padEnd(24)} 领牌 ${String(v.n).padStart(5)}  吊主 ${String(v.drew).padStart(4)}  ${(v.drew*100/v.n).toFixed(1)}%`);
  console.log('');

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
  const lost = miss.filter(r => r.drawScore !== null);
  if (lost.length) {
    console.log('\n【提了但输了】的 ' + lost.length + ' 次，差距多少：');
    const gaps = lost.map(r => r.winnerScore - r.drawScore).sort((a, b) => a - b);
    const q = p2 => gaps[Math.floor(gaps.length * p2)];
    console.log(`  中位差 ${q(.5).toFixed(0)}，四分位 ${q(.25).toFixed(0)} ~ ${q(.75).toFixed(0)}，最大 ${gaps[gaps.length-1].toFixed(0)}`);
    console.log(`  吊主提案的最终得分：中位 ${lost.map(r=>r.drawScore).sort((a,b)=>a-b)[Math.floor(lost.length/2)].toFixed(0)}`);
    const has = tag => lost.filter(r => (r.winner ?? '').includes(tag)).length;
    console.log('  赢它的那条提案里含有：');
    for (const t of ['return-partner-suit','develop-long-side-suit','seek-piece',
                     'compress-after-giving-piece','attack-opponent-long-suit',
                     'continue-contributed-piece','safe-side-throw','tail-throw'])
      if (has(t)) console.log(`    ${String(has(t)).padStart(4)}  ${t}`);
  }
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
        : r.opening ? '这是开局首领（走 dealer-opening 那条）'
        : r.role === 'declarer' && r.trumpCount <= r.oppTrumpEst ? '庄家：我的主已经不比对手长'
        : r.strategy === 'points-first' ? '策略已转跑分为主'
        : '其它';
      w.set(k, (w.get(k) ?? 0) + 1);
    }
    console.log(`  ${role}（${sub.length} 次没提）`);
    for (const [k, v] of [...w.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`      ${String(v).padStart(4)}  ${k}`);
  }
} finally { restore(); }
