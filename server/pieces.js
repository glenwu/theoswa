import { SUITS, SUIT_SYMBOL, rankLabel, cardStrength, playSuitOf } from './cards.js';

// 牌去向表（card whereabouts）——甩牌资格的唯一依据（纯公开信息判定，绝不遍历他人手牌内容）。
// 同一套表结构服务两种查询（共用实现，只是查询范围不同）：
// - 件（副牌 A/K）：查询“该花色最高的那 2~4 张”的去向 → 副牌甩牌资格（有面板提示、服务端提前拒绝）
// - 主牌：查询“主牌序列中某张以上部分”的去向 → 主牌甩牌资格（无提示、算错收缩为最小一张）
// 每张表项 { cardId, suit, rank, location }：
//   location = { kind: 'hand', seat } 暗牌 | { kind: 'kittyRevealed' } 底牌已公开亮出
//            | { kind: 'kitty' } 底牌未公开（主牌表用） | { kind: 'played' } 已打出

// 件 = 某副牌花色中“仍是副牌”的 A 和 K：
// - 主牌花色的 A/K 不是件；
// - 级牌占用该点数时也不是件：打 A 时 A 升主（只剩 K×2），打 K 时 K 升主（只剩 A×2）。
export function isPieceCard(card, trumpSuit, rankCard) {
  return (
    card.suit !== 'JOKER' &&
    card.suit !== trumpSuit &&
    (card.rank === 13 || card.rank === 14) &&
    card.rank !== rankCard
  );
}

// 是否主牌（大小王/主级牌/副级牌/主花色牌）
export function isTrumpCard(card, trumpSuit, rankCard) {
  return playSuitOf(card, trumpSuit, rankCard) === 'TRUMP';
}

// 共用的建表器：把当前所有满足 isTracked 的牌登记去向（手上 = 暗牌；底牌 = kittyKind）
function buildCardTable(state, isTracked, kittyKind) {
  const r = state.round;
  const table = [];
  for (const p of state.players) {
    for (const c of p.hand) {
      if (isTracked(c, r.trumpSuit, r.rankCard)) {
        table.push({ cardId: c.id, suit: c.suit, rank: c.rank, location: { kind: 'hand', seat: p.seat } });
      }
    }
  }
  for (const c of r.kitty) {
    if (isTracked(c, r.trumpSuit, r.rankCard)) {
      table.push({ cardId: c.id, suit: c.suit, rank: c.rank, location: { kind: kittyKind } });
    }
  }
  table.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || b.rank - a.rank);
  return table;
}

// 换底完成后重建两张去向表：件表（底牌中的件已公开亮出）+ 主牌表（底牌中的主牌未公开）。
// 供庄家换底后调用；三主过河时由 relocateTableCards 同步更新。
export function rebuildPieces(state) {
  const r = state.round;
  r.pieces = buildCardTable(state, isPieceCard, 'kittyRevealed');
  r.trumpCards = buildCardTable(state, isTrumpCard, 'kitty');
  return r.pieces;
}

// 服务端件表 → 公开状态视图（与 viewer 下发格式一致：按花色分组 {rank, status}）。
// status：'mine'（在我手上）/ 'seen'（已打出或底牌亮出）/ 'unseen'（在别人暗牌里）。
// 注意：只给副牌 A/K（件）——主牌去向不进面板（主牌甩牌由玩家自己心算，有意为之）。
export function pieceStatusesFor(pieces, trumpSuit, seat) {
  const view = {};
  for (const suit of SUITS) {
    if (suit !== trumpSuit) view[suit] = [];
  }
  for (const p of pieces) {
    const status =
      p.location.kind === 'hand'
        ? p.location.seat === seat ? 'mine' : 'unseen'
        : 'seen';
    view[p.suit].push({ rank: p.rank, status });
  }
  return view;
}

// 副牌甩牌资格：该花色每一件都满足（在我手上 || 已打出 || 底牌亮出）。
// 纯查状态表：绝不遍历任何人的手牌。
export function canThrowByStatus(items) {
  return Array.isArray(items) && items.length > 0 && items.every(x => x.status !== 'unseen');
}

// 还差哪些件（用于错误提示：如“甩牌不成立，还差 ♠K”）
export function missingPieceLabels(suit, items) {
  return (items ?? [])
    .filter(x => x.status === 'unseen')
    .map(x => `${SUIT_SYMBOL[suit]}${rankLabel(x.rank)}`);
}

// 主牌甩牌资格（公开信息判定，服务端在玩家出牌后裁决）：
// 设甩出 N 张主牌，最小一张为 c —— 资格成立 ⇔ 没有任何一张比 c 大的主牌
// 还留在其他三家的暗牌里（已打出 / 在我手上 / 在底牌里都不挡）。
// 平手不挡：别人有和 c 一样大的牌不影响（首家先出者为大）。不检查张数。
// 返回 { eligible, minCard }；eligible=false 时调用方收缩为只出 minCard。
export function trumpDumpVerdict({ trumpCards, mySeat, trumpSuit, rankCard }, cards) {
  const ctx = { trumpSuit, rankCard };
  let minCard = cards[0];
  for (const c of cards.slice(1)) {
    const d = cardStrength(c, ctx) - cardStrength(minCard, ctx);
    if (d < 0 || (d === 0 && SUITS.indexOf(c.suit) < SUITS.indexOf(minCard.suit))) {
      minCard = c;
    }
  }
  const minStrength = cardStrength(minCard, ctx);
  const blocked = (trumpCards ?? []).some(
    t =>
      t.location.kind === 'hand' &&
      t.location.seat !== mySeat &&
      cardStrength({ suit: t.suit, rank: t.rank }, ctx) > minStrength
  );
  return { eligible: !blocked, minCard };
}

// 一轮结算后统一迁移：本轮打出的牌标记为 played（件表与主牌表通用）。
// 注意：必须在整轮结束后迁移，不能在单张出牌时迁移——
// 否则同一轮里后出牌的人会看到不该看到的资格变化。
export function migratePlayedPieces(table, trickResult) {
  if (!Array.isArray(table)) return table;
  const played = new Set(trickResult.plays.flatMap(p => p.cards.map(c => c.id)));
  for (const entry of table) {
    if (played.has(entry.cardId)) entry.location = { kind: 'played' };
  }
  return table;
}

// 三主过河 / 任何换手：把指定牌的持有者改到 toSeat（件表与主牌表同步更新）。
// 对对手而言仍是暗牌（kind:'hand' 不变，只是换了个 seat）——不泄密。
export function relocateTableCards(state, moves) {
  if (!Array.isArray(moves) || moves.length === 0) return;
  const byId = new Map(moves.map(m => [m.cardId, m.toSeat]));
  for (const tableName of ['pieces', 'trumpCards']) {
    const table = state.round?.[tableName];
    if (!Array.isArray(table)) continue;
    for (const entry of table) {
      if (byId.has(entry.cardId)) {
        entry.location = { kind: 'hand', seat: byId.get(entry.cardId) };
      }
    }
  }
}
