// 「清顶」到底是帮了忙还是帮了倒忙？总量对比会被「两边用同一套策略」搅浑，
// 所以这里按【同一批种子】逐局配对，只看清顶真正改变了打法的那些局。
// 用法：node scripts/audit/clearing-paired.mjs > 某个文件，两个版本各跑一次再 diff。
import { simulateRound } from '../../server/simulate-bots.js';

const N = Number(process.env.N ?? 400);
for (let i = 0; i < N; i++) {
  const seed = 4200 + i * 977;
  const { state, summary } = await simulateRound({ seed, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  const dec = round?.trumpEvent?.declarerSeat ?? round?.declarerSeat;
  // 庄家一方在【非尾三墩】领了鬼或主级牌来吊主 —— 清顶的外在表现
  const bigMidLead = hist.some((t, k) => {
    if (t.leadSuit !== 'TRUMP' || hist.length - k <= 3) return false;
    if (dec === null || dec === undefined || t.leadSeat % 2 !== dec % 2) return false;
    return (t.plays?.[0]?.cards ?? []).some(c =>
      c.rank === 15 || c.rank === 16 ||
      (c.rank === round.rankCard && c.suit === round.trumpSuit));
  });
  console.log(JSON.stringify({ seed, grab: !!summary?.kittyGrab, bigMidLead }));
}
