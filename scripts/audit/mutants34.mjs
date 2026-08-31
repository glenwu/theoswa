// 变异测试：Glen 2026-08-30「BOT 有大小鬼……倒数三轮二轮就把大小鬼打出来了，
//   导致给对手撬底」——保底的鬼组合要留到最后两轮。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '    score -= JOKER_EARLY_SPEND_PENALTY * bottomWeight * tuning.bottomControlWeight;',
      '', '整条「留到最后两轮」删掉'],
  // ⚠️ 「不看还剩几轮（写成 true）」那条【删了 —— 杀不掉，也构造不出来】：
  // 手上只剩两张而又是大小鬼时，鬼本来就是【唯一候选】，罚不罚都得出，
  // 边界两侧的行为一样。要有别的牌可打就至少三张，那已经不是「最后两轮」了。
  // 门槛的【数值】倒是测得出来（三张牌时 >2 成立、>3 不成立），就是下面这条。
  // ⚠️ JOKER_HOLD_LAST_TRICKS 的【数值】没有变异体 —— 钉不住，两头都试过：
  // 只剩两张而又是大小鬼时鬼是唯一候选（边界两侧一样），三张那档又被尾盘加分
  // 盖住（罚了也照样出鬼），中间没有能分开的窗口。上面那条 `true` 变异体
  // 同理，一并去掉了。行为由测试钉着（早了不出 / 该出就出）。
  [F, '    you.hand.filter(card => card.rank === 15 || card.rank === 16).length >= 2 &&',
      '    true &&',
      '手上只有一张鬼也按保底组合护着'],
  [F, '    afterDefenderPoints < DEFENDER_TARGET_POINTS &&\n    cards.some(card => card.rank === 15 || card.rank === 16) &&',
      '    cards.some(card => card.rank === 15 || card.rank === 16) &&',
      '漏掉「分到不了移庄线才罚」这个前提 —— 该砍的时候也不砍'],
  [F, '    cards.some(card => card.rank === 15 || card.rank === 16) &&',
      '    true &&',
      '不看这一手打的是不是鬼 —— 打什么都罚'],
]);
