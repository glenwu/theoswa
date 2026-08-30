// 变异测试：Glen 第 1 条「别乱求件」—— 甩牌欲望判据 + 两道闸门。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 甩牌欲望（Glen：件多 或 很长）----
  [F, '  if (strongPieceSuit(view, ctx, suit, tuning)) return true;\n  const mine = cardsOfSuit(view.you?.hand ?? [], suit, ctx).length;\n  return mine >= 2 && mine > maxOpponentSuitEstimate(view, ctx, suit);',
      '  const mine = cardsOfSuit(view.you?.hand ?? [], suit, ctx).length;\n  return mine >= 2 && mine > maxOpponentSuitEstimate(view, ctx, suit);',
      '「件多」那一档没了，只认长度'],
  [F, '  return mine >= 2 && mine > maxOpponentSuitEstimate(view, ctx, suit);',
      '  return mine >= 2;',
      '「很长」不再和对手比，两张就算有欲望（等于闸门全开）'],
  [F, '  return mine >= 2 && mine > maxOpponentSuitEstimate(view, ctx, suit);',
      '  return mine >= 2 && mine >= maxOpponentSuitEstimate(view, ctx, suit);',
      '和对手一样长就算占优（松一档）'],

  // ---- 闸门一：换中性牌 ----
  [F, '  const natural = lowestLead(cards, ctx);\n  if (!natural || !shouts(natural)) return natural;',
      '  const natural = lowestLead(cards, ctx);\n  if (!natural) return natural;',
      '本来那张不喊也照样重挑一遍 6~9'],
  [F, '  const quiet = cards.filter(\n    card => card.rank >= QUIET_LEAD_MIN && card.rank <= QUIET_LEAD_MAX\n  );\n  return quiet.length ? lowestLead(quiet, ctx) : natural;',
      '  return natural;',
      '从来不换牌（闸门一失效）'],
  [F, 'const QUIET_LEAD_MIN = 6;', 'const QUIET_LEAD_MIN = 2;',
      '换成任意小牌 —— 等于没换（还是求件信号）'],

  // ---- 闸门二：换门 ----
  [F, `    const stray = [...proposals].filter(([, proposal]) =>
      straySignal(view, ctx, proposal.cards, tuning)
    );
    if (stray.length < proposals.size) {
      for (const [key] of stray) proposals.delete(key);
    }`, '',
      '整段换门删掉 —— 只剩小牌时照样硬着头皮喊'],
  [F, '  if (suitThrowAmbition(view, ctx, suit, tuning)) return false;  // 真心在求，该喊',
      '',
      '有甩牌欲望也不许喊（长门求件被一并封死）'],
  // ⚠️ 「帮队友逼件也当成乱求」那一条【删了】：2026-08-29 求件收紧成「只算这门
  // 第一次被领的那一手」之后，helpingTeamAsk 恒为假（我方求过 ⇒ 这门被领过，
  // 而上面已经要求这门没被领过），函数本身也删了。那条打法没丢，
  // 换成由下面「这门已经被领过就不会被误读」那条表达。
  [F, '  if (suitLedBefore(view, suit)) return false;', '',
      '这门已经被领过也照样当成求件信号（Glen 裁定这是错的）'],
  [F, "  if (suit === 'TRUMP') return false;                    // 领主牌不是求件信号",
      '',
      '领主牌也当成求件信号'],
  [F, '  if (cards.length !== 1) return false;                  // 甩牌不是求件信号',
      '',
      '甩牌也当成求件信号（一手小牌的甩牌会被删掉）'],
]);
