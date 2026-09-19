// 尾盘（手上剩 2~3 张）单张大鬼、另一张没现身时，它实际在谁手上？
// 对手的吊主习惯（Glen：无甩牌目的地吊主 → 大牌少；避免吊主 → 大牌多）能不能预测？
//
// 2026-09-19（300 局，181 个样本）：队友 36% / 对手 64% / 底里 0%（庄家不埋大鬼）；
// 我方坐庄时在对手手上 53%、做闲时 77%。吊主习惯在 BOT 对局里是反的：
// 对手从不吊主 → 在对手手上 47%，乱吊两次以上 → 68%。
// 用在 bot-policy.js 的 TWIN_WITH_OPPONENT（取 2/3）。
// ⚠️ 碾压收尾的局还原不出手牌，整局跳过。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';
const N = Number(process.env.N ?? 300);
const t = {}; const bump = (k, d = 1) => { t[k] = (t[k] ?? 0) + d; };
for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const r = state.round; const hist = r.trickHistory;
  if (!hist.length || hist.some(x => x.virtual)) continue;
  const ps = c => playSuitOf(c, r.trumpSuit, r.rankCard);
  const start = new Map(state.players.map(p => [p.seat, [...p.hand, ...hist.flatMap(tr => tr.plays.filter(x => x.seat === p.seat).flatMap(x => x.cards))]]));
  const handAt = (seat, ti) => { const gone = new Set(); for (let k = 0; k < ti; k++) for (const p of hist[k].plays) if (p.seat === seat) for (const c of p.cards) gone.add(c.id); return start.get(seat).filter(c => !gone.has(c.id)); };
  const bjOwner = new Map(); for (const [seat, cards] of start) for (const c of cards) if (c.rank === 16) bjOwner.set(c.id, seat);
  for (const c of r.kitty) if (c.rank === 16) bjOwner.set(c.id, 'kitty');
  for (let ti = 0; ti < hist.length; ti++) {
    for (const seat of [0, 1, 2, 3]) {
      const h = handAt(seat, ti);
      if (h.length < 2 || h.length > 3) continue;
      const bjs = h.filter(c => c.rank === 16);
      if (bjs.length !== 1) continue;
      const seen = hist.slice(0, ti).flatMap(tr => tr.plays.flatMap(p => p.cards));
      if (seen.some(c => c.rank === 16)) continue;
      const twinId = [...bjOwner.keys()].find(id => id !== bjs[0].id);
      const owner = bjOwner.get(twinId);
      const where = owner === 'kitty' ? 'kitty' : owner === (seat + 2) % 4 ? 'partner' : 'opp';
      // 对手吊主习惯
      const opps = [(seat + 1) % 4, (seat + 3) % 4];
      let draws = 0, purposeless = 0, leads = 0;
      for (const [k, tr] of hist.slice(0, ti).entries()) {
        const l = tr.plays[0]; if (!opps.includes(l.seat)) continue;
        leads++;
        if (ps(l.cards[0]) !== 'TRUMP') continue;
        draws++;
        const threwLater = hist.slice(k + 1, ti).some(t2 => t2.plays[0].seat === l.seat && t2.plays[0].cards.length > 1 && ps(t2.plays[0].cards[0]) !== 'TRUMP');
        if (!threwLater) purposeless++;
      }
      const style = leads === 0 ? 'noLeads' : purposeless >= 2 ? 'aimless≥2' : draws === 0 ? 'avoid' : 'mixed';
      bump(`all|${where}`); bump(`${style}|${where}`); bump(`${style}`);
      const role = seat % 2 === state.declarerSeat % 2 ? 'decl' : 'def';
      bump(`${role}|${where}`); bump(role);
      break;   // 每墩只取一个座位，避免重复
    }
  }
}
const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '--';
const total = ['partner', 'opp', 'kitty'].reduce((s, w) => s + (t[`all|${w}`] ?? 0), 0);
console.log(`样本 ${total}：另一张大鬼在 队友 ${pct(t['all|partner'] ?? 0, total)} / 对手 ${pct(t['all|opp'] ?? 0, total)} / 底里 ${pct(t['all|kitty'] ?? 0, total)}`);
for (const role of ['decl', 'def']) console.log(`  我方${role === 'decl' ? '坐庄' : '做闲'} (${t[role] ?? 0})：对手 ${pct(t[`${role}|opp`] ?? 0, t[role])}`);
for (const style of ['aimless≥2', 'mixed', 'avoid', 'noLeads']) console.log(`  对手吊主习惯 ${style} (${t[style] ?? 0})：在对手手上 ${pct(t[`${style}|opp`] ?? 0, t[style])}`);
