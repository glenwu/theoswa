// 变异测试：Glen 2026-09-19「自己没有件一般不能打 5 及 5 以下，队友一般会认为
// 要求件，已经发生很多次让队友把件打出来让其它人甩的问题了。」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '  return holdsPiece && suitThrowAmbition(view, ctx, suit, tuning);',
      '  return suitThrowAmbition(view, ctx, suit, tuning);',
      '一件都没有、只凭长度也照喊（改之前的口径）'],
  [F, '  return holdsPiece && suitThrowAmbition(view, ctx, suit, tuning);',
      '  return holdsPiece;',
      '手上有件就喊，不管这门强不强'],
  [F, '      !askSignalWorthy(view, ctx, suit, tuning)\n    );',
      '      !suitThrowAmbition(view, ctx, suit, tuning)\n    );',
      'quietLead 不换牌：无件长门照打最小那张'],
  [F, '  if (askSignalWorthy(view, ctx, suit, tuning)) return false;',
      '  if (suitThrowAmbition(view, ctx, suit, tuning)) return false;',
      'straySignal 放行无件长门（没 6~9 可换时照喊）'],
]);
