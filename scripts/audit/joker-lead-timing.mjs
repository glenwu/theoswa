// 鬼（15/16）是在第几轮被【领出】的 —— 那是留给中后期的优势牌，
// 一开局就领出去等于白送。Glen 实战反馈的正是这个。
import { simulateRound } from '../../server/simulate-bots.js';
let rows = [];
for (let i = 0; i < 14; i++) {
  const { state } = await simulateRound({ seed: 7777 + i * 613, difficulty: 'expert' });
  const h = (state?.round?.trickHistory ?? []).filter(t => !t.virtual);
  h.forEach((t, idx) => {
    const lead = (t.plays ?? [])[0];
    if (!lead) return;
    const j = (lead.cards ?? []).filter(c => c.rank === 15 || c.rank === 16);
    if (j.length === 0) return;
    rows.push({ 局: i, 第几轮: idx + 1, 共几轮: h.length,
      牌: j.map(c => c.rank === 16 ? '大鬼' : '小鬼').join('+'),
      剩余轮数: h.length - idx });
  });
}
console.log('领出鬼的时机分布：');
for (const r of rows) console.log(`  第${String(r.第几轮).padStart(2)}轮/共${r.共几轮}轮  ${r.牌}  （还剩 ${r.剩余轮数} 轮）`);
const early = rows.filter(r => r.第几轮 <= 3);
console.log(`\n共 ${rows.length} 次领鬼，其中前三轮 ${early.length} 次`);
