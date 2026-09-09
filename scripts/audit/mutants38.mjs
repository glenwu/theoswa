// 变异测试：Glen 2026-09-09 第三家那条 ——
//   「第三个出牌的时候经常没有打大过 10 的牌，很容易放第四家的 10 吃分……
//     QJ 或是主牌的副 2 及以下最好是尽力拦一下，当然不要乱出大牌（主 2 及以上）和件。」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 「无分墩」的口径：第四家还能塞分就不算无分 ----
  [F, '    if (isKill && totalPoints === 0 && early && !blockingWithSmallTrump) {',
      '    if (isKill && totalPoints === 0 && early) {',
      '退回只看桌面分 —— 第四家的 10 还没出，这一墩就被当成无分墩让掉'],

  // ---- 只放行「副 2 及以下」的小主 ----
  [F, '      cards.every(card => isSmallTrump(card, ctx)) && lastSeatPointInjection(view, ctx) > 0;',
      "      cards.every(card => suitOf(card, ctx) === 'TRUMP') && lastSeatPointInjection(view, ctx) > 0;",
      '鬼和主级牌也一起放行 —— 为拦一张分花掉保底的本钱'],

  // ---- 第四家已知断门就塞不进分 ----
  [F, '  if (knownVoidInSuit(view, lastSeat, lead.playSuit, ctx)) return 0;  // 他断了，只会毙不会塞分',
      '  if (false) return 0;',
      '不看第四家断没断 —— 他明明只会毙，还去毙一墩真的无分墩'],

  // ⚠️ 「连压不过牌面的分牌也算成威胁」那条变异体【删了 —— 钉不住】：
  // 一门里几乎总还有未现的、压得过当前牌面的 10 或 K，两种写法算出来都是 >0。
  // 只有「当前牌面已经压过这门所有未现的分牌」时才分得开 —— 实测 200 局
  // （scripts/audit/third-hand-ruff.mjs）这条件只改变 1 次决策（毙 95 → 94）。
  // 判据本身是对的（压不过就拿不走，塞进来等于送分给我方），留着；
  // 但为它留一条几乎永远存活的变异体只会让整套的杀伤率失真。
]);
