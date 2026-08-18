import { buildDeck, playSuitOf, SUITS } from './cards.js';

const cardKey = card => `${card.suit}:${card.rank}`;

function publicCards(view) {
  return [
    ...(view.you?.hand ?? []),
    ...(view.round?.currentTrick ?? []).flatMap(play => play.cards ?? []),
    ...(view.round?.trickHistory ?? []).flatMap(trick =>
      (trick.plays ?? []).flatMap(play => play.cards ?? [])
    ),
  ];
}

function hiddenInventory(view) {
  const counts = new Map();
  for (const card of buildDeck()) counts.set(cardKey(card), (counts.get(cardKey(card)) ?? 0) + 1);
  for (const card of publicCards(view)) {
    const key = cardKey(card);
    counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
  }
  const cards = [];
  for (const [key, count] of counts) {
    const [suit, rawRank] = key.split(':');
    for (let index = 0; index < count; index += 1) {
      cards.push({ suit, rank: Number(rawRank) });
    }
  }
  return cards;
}

function observedTricks(view) {
  const complete = view.round?.trickHistory ?? [];
  const current = view.round?.currentTrick ?? [];
  return current.length > 0
    ? [...complete, { plays: current, leadSuit: current[0].playSuit }]
    : complete;
}

function voidsForSeat(view, seat, ctx) {
  const voids = new Set();
  for (const trick of observedTricks(view)) {
    const plays = trick.plays ?? [];
    if (plays.length === 0) continue;
    const leadSuit = trick.leadSuit ?? plays[0].playSuit;
    const leadCount = plays[0].cards?.length ?? 0;
    const play = plays.find(item => item.seat === seat);
    if (!play || leadCount === 0) continue;
    const followed = (play.cards ?? []).filter(
      card => playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === leadSuit
    ).length;
    // 跟牌不足时规则要求把该门全部打出，因此这手之后该玩家已确定断门。
    if (followed < leadCount) voids.add(leadSuit);
  }
  return voids;
}

function logChoose(n, k) {
  if (k < 0 || n < k) return -Infinity;
  const m = Math.min(k, n - k);
  let value = 0;
  for (let index = 1; index <= m; index += 1) {
    value += Math.log(n - m + index) - Math.log(index);
  }
  return value;
}

function allTrumpProbability({ handCount, hiddenCards, voids, ctx }) {
  if (handCount === 0) return 0;
  if (voids.has('TRUMP')) return 0;
  const sideVoids = SUITS.filter(suit => suit !== ctx.trumpSuit && voids.has(suit));
  if (sideVoids.length === 3) return 1;

  const eligible = hiddenCards.filter(card => {
    const suit = playSuitOf(card, ctx.trumpSuit, ctx.rankCard);
    return suit === 'TRUMP' || !voids.has(suit);
  });
  const hiddenTrumps = eligible.filter(
    card => playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === 'TRUMP'
  ).length;
  if (hiddenTrumps < handCount || eligible.length < handCount) return 0;
  const probability = Math.exp(
    logChoose(hiddenTrumps, handCount) - logChoose(eligible.length, handCount)
  );
  return Math.max(0, Math.min(1, probability));
}

// 纯公开信息的影子牌势快照。底牌始终作为独立的未知槽位保留，绝不把所有
// 未现牌都错误分给三家。概率目前只供策略保护和复盘，不包含任何服务端暗牌。
export function inferPublicBeliefs(view) {
  if (!view?.round?.trumpSuit || !view?.you) {
    return { kittySlots: view?.round?.kittyCount ?? 8, hiddenSlots: 0, players: {} };
  }
  const ctx = { trumpSuit: view.round.trumpSuit, rankCard: view.round.rankCard };
  const hiddenCards = hiddenInventory(view);
  const kittySlots = view.round.kittyCount ?? 8;
  const players = {};

  for (const player of view.players ?? []) {
    if (player.seat === view.you.seat) continue;
    const voids = voidsForSeat(view, player.seat, ctx);
    const sideVoids = SUITS.filter(suit => suit !== ctx.trumpSuit && voids.has(suit));
    const probability = allTrumpProbability({
      handCount: player.handCount,
      hiddenCards,
      voids,
      ctx,
    });
    players[player.seat] = {
      seat: player.seat,
      team: player.team,
      handCount: player.handCount,
      voidSuits: [...voids].sort(),
      allTrumpConfirmed: probability === 1,
      allTrumpProbability: Number(probability.toFixed(4)),
      evidence: [
        ...sideVoids.map(suit => `已确定断 ${suit}`),
        ...(voids.has('TRUMP') ? ['已确定无主'] : []),
        ...(player.seat === view.declarerSeat && sideVoids.length > 0
          ? ['庄家可能通过8张埋底主动埋断']
          : []),
      ],
    };
  }

  return {
    kittySlots,
    hiddenSlots: hiddenCards.length,
    players,
  };
}
