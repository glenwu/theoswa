// 变异测试：Glen 2026-09-06「三主过河如果是庄家的队友要给庄家，应该先过河之后再埋底」。
// 过河拆成两轮：发牌完 → 过河①（只开给庄家队友）→ 换底 → 过河②（其余）→ 出牌。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const R = 'server/round.js';
const C = 'server/crossriver.js';
const A = 'server/actions.js';
runMutants([
  // ---- 埋底前那一轮开不开 ----
  [R, "  state.phase = 'CROSS_RIVER';\n  if (crossRiverCandidates(state).length === 0) {",
      "  state.phase = 'KITTY_EXCHANGE';\n  if (true) {",
      '整条去掉 —— 发牌完直接换底，回到「先埋底再过河」'],

  // ---- 埋底前只开给庄家的队友 ----
  [C, '    if (beforeBury && p.seat !== partnerOfDeclarer) continue;',
      '',
      '埋底前那一轮对所有人开放（闲家、庄家自己也能在这时候过河）'],

  // ---- 走完之后去哪 ----
  [A, "  if (r.crossRiver.stage === 'before-bury') {\n    enterKittyExchange(state);\n    return;\n  }",
      '',
      '埋底前那一轮走完直接跳去出牌 —— 庄家的底根本没埋'],

  // ---- 名额跨两轮继承 ----
  [A, "  r.crossRiver.stage = 'after-bury';\n  r.crossRiver.active = [];",
      "  r.crossRiver.stage = 'after-bury';\n  r.crossRiver.doneTeams = [];\n  r.crossRiver.passedSeats = [];\n  r.crossRiver.active = [];",
      '埋底后把名额清空 —— 庄家一方一局能过两次河'],

  // ---- 过河惩罚只认「庄家自己发起」（Glen 2026-09-06 裁定）----
  [C, '  if (from.seat === state.declarerSeat) r.declarerCrossedRiver = true;',
      '  if (from.seat % 2 === state.declarerSeat % 2) r.declarerCrossedRiver = true;',
      '队友发起也算成「庄家过河」—— 他把交来的主牌埋进底就要挨罚了'],

  // ⚠️ 「不再校验 3 换 3 两边张数不变」那条变异体【删了 —— 钉不住，也不该钉】：
  // executeCrossRiver 是【先各删 3 张再各推 3 张】，两边张数按构造就不会变，
  // 那句 throw 是防御性断言（防的是以后有人改坏 executeCrossRiver），
  // 正确的代码里永远不成立，任何测试都杀不掉它。留一条永远存活的变异体
  // 只会让整套的杀伤率失真。它替换掉的那句 assertEqualHandCounts 才是有行为的 ——
  // 埋底前四家手牌数本来就不相等（33/25/25/25），那条断言会把合法的过河判成崩溃，
  // 由「队友的主牌先到庄家手上，庄家【再】埋底」那条测试钉着。
]);
