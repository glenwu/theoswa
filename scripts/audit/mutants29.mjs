// 变异测试：Glen 2026-08-29「吊主吊着吊着就忘了，打成副牌了，特别是庄家队友」。
// 判据从「庄家/队友【最近一次】领的是什么」换成【明确的信号】：
//   · 庄家首出打副牌 = 他说自己够保底（declarerOpenedSide）
//   · 队友第一次拿到牌权就领副牌 = 应答「不用吊主」（trumpSignalAnswered）
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 庄家队友 ----
  [F, `        ? (declarerOpenedSide(view) ||
           (hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 0 : 480)`,
      `        ? (lastLeadStyle(view, view.declarerSeat) === 'trump' &&
           !(hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 480 : 0)`,
      '退回旧判据：庄家最近打了副牌，队友就不吊了'],
  [F, `        ? (declarerOpenedSide(view) ||
           (hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 0 : 480)`,
      '        ? 480',
      '队友无条件吊主 —— 庄家首出副牌说了「够保底」也不听'],
  [F, `        ? (declarerOpenedSide(view) ||
           (hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 0 : 480)`,
      '        ? (declarerOpenedSide(view) ? 0 : 480)',
      '「我有大鬼、转副牌就是应答」那条豁免删掉'],

  // ---- declarerOpenedSide 的判据 ----
  [F, `  const first = (view.round?.trickHistory ?? [])[0];
  if (!first || first.leadSeat !== view.declarerSeat) return false;
  return first.leadSuit !== 'TRUMP';`,
      `  const first = (view.round?.trickHistory ?? []).slice(-1)[0];
  if (!first || first.leadSeat !== view.declarerSeat) return false;
  return first.leadSuit !== 'TRUMP';`,
      '看的是最后一墩而不是首墩 —— 等于退回旧写法'],

  // ---- 庄家：应答是一次性的 ----
  [F, `  const firstPartnerLead = history.slice(1).find(trick => trick.leadSeat === partner);
  return !!firstPartnerLead && firstPartnerLead.leadSuit !== 'TRUMP';`,
      `  return history.slice(1).some(
    trick => trick.leadSeat === partner && trick.leadSuit !== 'TRUMP'
  );`,
      '退回旧判据：队友此后【曾经】领过副牌就算应答'],
  [F, `  const firstPartnerLead = history.slice(1).find(trick => trick.leadSeat === partner);
  return !!firstPartnerLead && firstPartnerLead.leadSuit !== 'TRUMP';`,
      '  return false;',
      '队友怎么表示都不算应答 —— 庄家一路吊到只剩两个鬼'],

  // ---- 庄家：停吊的判据是「我的主已经不比对手长」，不是「保底不现实」 ----
  [F, `        ? (trumpSignalAnswered(view, ctx) ||
           trumps.length <= maxOpponentTrumpEstimate(view, ctx) ? 0 : 520)`,
      `        ? (trumpSignalAnswered(view, ctx) || strategy === 'points-first' ? 0 : 520)`,
      '退回旧判据：保底不现实就停吊（7、8 张主也被判死）'],
  [F, `        ? (trumpSignalAnswered(view, ctx) ||
           trumps.length <= maxOpponentTrumpEstimate(view, ctx) ? 0 : 520)`,
      '        ? (trumpSignalAnswered(view, ctx) ? 0 : 520)',
      '主已经比对手短了还接着吊 —— 那是替对手削我自己'],

  // ---- 该吊主时，「发展长副牌」和兜底让位 ----
  [F, '  if (sideGroups.length > 0 && !drawWarranted) {',
      '  if (sideGroups.length > 0) {',
      '发展长副牌不让位 —— 叠加起来照旧压过吊主'],
  // 注：兜底（low-card-fallback）那一半【试过让位，撤了】—— 200 局实测
  // 76.5%→76.4%、51.1%→50.1%，是噪声，而且构造不出能钉住它的 fixture
  //（20 分只在平局边缘起作用）。理由写在源码和测试里。
]);
