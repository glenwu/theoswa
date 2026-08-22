
import { runMutants } from './mutate.mjs';

runMutants([
  ['server/rotation.js', 'return (seat + 3) % SEAT_COUNT;', 'return (seat + 1) % SEAT_COUNT;', '逆时针轮转方向反了'],
  ['server/rotation.js', 'order.push((seat + 3 * i) % SEAT_COUNT);', 'order.push((seat + i) % SEAT_COUNT);', 'seatOrderFrom 方向反了'],
  ['server/reveal.js', 'const n = rank === 14 ? 1 : rank;', 'const n = rank;', '翻牌定起揭人：A 不再算 1'],
  ['server/reveal.js', 'if (r === 3) return oppositeSeat(flipperSeat);', 'if (r === 3) return prevSeat(flipperSeat);', '余 3 → 对家 写成上家'],
  ['server/level.js', 'return (levelIndex % 13) + 2;', 'return (levelIndex % 14) + 2;', '级别绕回 A 之后回 2 的模数'],
  ['server/level.js', 'return levelIndex >= 14;', 'return levelIndex >= 13;', '胜利门槛（第二圈的 2 上再升一级）'],
  ['server/cards.js', 'if (card.rank === 10 || card.rank === 13) return 10;', 'if (card.rank === 10) return 10;', 'K 不算 10 分了'],
  ['server/cards.js', 'return deck.splice(deck.length - 8, 8);', 'return deck.splice(0, 8);', '底牌从牌堆头部取（与 pop 撞车）'],
  ['server/reveal.js', 'if (c.suit !== \'JOKER\' && fallbackSuit === null) fallbackSuit = c.suit;', 'if (c.suit !== \'JOKER\') fallbackSuit = c.suit;', '揭底定主取「最后一张」非王而非第一张'],
  ['server/scoring.js', 'return defenderTrickPoints + runAwayPoints + kittyPoints === 200;', 'return true;', '守恒校验形同虚设'],
  // ---- 保密：白名单前缀太粗，挂在白名单路径下的任何东西都放行 ----
  ['server/viewer.js', 'trickHistory: round.trickHistory,', 'trickHistory: round.trickHistory,\n    __spy: { trickHistory: null },', '（对照组：不泄露，只加字段）'],
  ['server/viewer.js',
   '    round: state.round\n      ? { ...clipRound(state.round, you.seat), kittyRevealed, allHandsRevealed }\n      : null,',
   '    round: state.round\n      ? { ...clipRound(state.round, you.seat), kittyRevealed, allHandsRevealed,\n          trickHistory: [...(state.round.trickHistory ?? []), { spy: state.players.map(p => p.hand) }] }\n      : null,',
   '把四家手牌挂进 round.trickHistory（白名单路径下 → 扫描器放行）'],
  // ---- 安全底线本身 ----
  ['server/security.js', "typeof node.id === 'string' &&", '', '扫描器放宽：不再要求 id（对照：应该更严，不该变松也没人管）'],
]);
