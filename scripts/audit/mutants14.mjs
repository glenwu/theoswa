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
  // ⚠️ 「去掉这个判断、赢不赢都收下」在新写法下【观察不到】：多出来的那些组
  // 全是「一张牌 + 最便宜的凑张数」，赢不下来，和 selections 里的 lowCards 重合，
  // 评分器本来就不会选。所以这里钉的是【把判断反过来】—— 阶梯整条消失。
  [F, '      if (led?.seat === view.you.seat) out.push(set);',
      '      if (led?.seat !== view.you.seat) out.push(set);',
      '「刚好够赢」的整条阶梯反了 —— 只收赢不下来的那些组'],
  [F, '      if (led?.seat === view.you.seat) out.push(set);',
      '      if (led?.seat === view.you.seat) return [set];',
      '回到「第一组赢得下就收工」—— 中间那档「一支够大的 + 一支最便宜的」根本生成不出来'],
  // ⚠️ 「从大往小试」这条已删：economical 改成收集整条阶梯之后，
  // 试的顺序不再影响结果（所有赢得下的组都进候选，再交给评分器），
  // 这个变异体恒等无害，留着只会是个永远杀不掉的假红。
  [F, '      const set = [winner, ...lowCards(rest, count - 1, ctx)];',
      '      const set = [winner, ...highCards(rest, count - 1, ctx)];',
      '凑张数的那几张挑最贵的'],

  // ---- 「砍下去就保不了底、而分还不到 80」→ 放走这一墩（Glen 给的判据）----
  [F, '    afterDefenderPoints < DEFENDER_TARGET_POINTS &&\n', '',
      '不看离 80 还有多远，一律不砍（回到我第一版测负的写法）'],
  [F, '    afterDefenderPoints < DEFENDER_TARGET_POINTS &&',
      '    afterDefenderPoints < DEFENDER_TARGET_POINTS && you.team === declarerTeam &&',
      '只算庄家那一半的账，闲家照砍（我第一版就写窄了）'],
  [F, 'const afterDefenderPoints = (round.defenderTrickPoints ?? 0) + totalPoints;',
      'const afterDefenderPoints = totalPoints;',
      '只看这一墩的分，不看闲家已经吃了多少'],
  [F, '    bottomControlOf(view, ctx).holdsTopTrump &&\n    !bottomControlAfter(view, ctx, cards).holdsTopTrump',
      'true', '不看这一毙到底有没有丢掉顶端，逢低分就不砍'],
  [F, '    !bottomControlAfter(view, ctx, cards).holdsTopTrump',
      '    !bottomControlOf(view, ctx).holdsTopTrump', '拿毙之前的状态当毙之后（等于永不触发）'],
  [F, 'const OVER_KILL_PENALTY = 1200;', 'const OVER_KILL_PENALTY = 120;',
      '罚得太轻，压不过接管加分'],
]);
