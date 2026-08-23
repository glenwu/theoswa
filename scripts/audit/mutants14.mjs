// 变异测试：跟多张时的「刚好够赢 + 垫最小」。
// 判牌只比最大那一张，所以毙一手两张只要一张够大的 + 一张凑数的。
// ⚠️ 锚点写的是源码原文，改代码时锚点会失效变成 SKIP —— 用 MUTATE_DRY=1 随时重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '    sets.push(...economical(trumps)); // 毙牌：一张够大的 + 最便宜的凑张数', '',
      '毙牌又回到只有「全大/全小/全分」三种形状'],
  [F, '    sets.push(...economical(leadSuitCards));', '',
      '同门跟多张不再考虑「刚好够赢」'],
  [F, '      if (led?.seat === view.you.seat) return [set];', '      return [set];',
      '不检查这组到底赢不赢得下来，拿最小的就交差'],
  [F, '      (a, b) => cardStrength(a, ctx) - cardStrength(b, ctx) || a.id.localeCompare(b.id)',
      '      (a, b) => cardStrength(b, ctx) - cardStrength(a, ctx) || a.id.localeCompare(b.id)',
      '从大往小试（第一组赢得下的就成了最大的那张）'],
  [F, '      const set = [winner, ...lowCards(rest, count - 1, ctx)];',
      '      const set = [winner, ...highCards(rest, count - 1, ctx)];',
      '凑张数的那几张挑最贵的'],

  // ---- 「砍下去就保不了底、而分还不到 80」→ 放走这一墩（Glen 给的判据）----
  [F, '    concededTotal < DEFENDER_TARGET_POINTS &&\n', '',
      '不看闲家离 80 还有多远，一律不砍（回到我第一版测负的写法）'],
  [F, '    you.team === declarerTeam &&\n', '',
      '闲家也套这本账（闲家让掉的分是被庄家跑掉，完全不同）'],
  [F, '    bottomControlOf(view, ctx).holdsTopTrump &&\n    !bottomControlAfter(view, ctx, cards).holdsTopTrump',
      'true', '不看这一毙到底有没有丢掉顶端，逢低分就不砍'],
  [F, '    !bottomControlAfter(view, ctx, cards).holdsTopTrump',
      '    !bottomControlOf(view, ctx).holdsTopTrump', '拿毙之前的状态当毙之后（等于永不触发）'],
  [F, 'const OVER_KILL_PENALTY = 1200;', 'const OVER_KILL_PENALTY = 120;',
      '罚得太轻，压不过接管加分'],
]);
