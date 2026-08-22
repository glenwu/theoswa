import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessBottomControl, chooseKittyCards, chooseLeadCards } from '../bot-policy.js';
import { buildDeck, playSuitOf } from '../cards.js';
import { mulberry32 } from '../rng.js';

// 真人牌友（Glen）报的问题：电脑做庄压底时会为了「正好 8 张断一门」把副 A 压进底牌。
//
// 这不是打法偏好，是可证明的错误 —— 见 server/pieces.js：
//   handleBuryKitty 把埋进底牌的副 A/K 强制公开亮出；
//   pieceStatusesFor 把 kittyRevealed 记成 'seen'；
//   canThrowByStatus 只要求该门每一件都 !== 'unseen'。
// 所以压副 A 是双重损失：丢掉该门最大的一张，还亲手把对手甩这门的资格凑齐。
// 真人的取舍是「埋 K 不埋 A」：A 自身 0 分、被抓也不送分；K 是 10 分的负债。
//
// 改之前实测 400 手随机庄家牌里有 83 手（20.8%）会压副 A。

const SUITS = ['S', 'H', 'D', 'C'];

// 随机发一手 33 张的庄家牌（25 + 并进来的 8 张底牌）
function dealDeclarerHand(seed) {
  const rng = mulberry32(seed);
  const deck = buildDeck();
  for (let j = deck.length - 1; j > 0; j -= 1) {
    const k = Math.floor(rng() * (j + 1));
    [deck[j], deck[k]] = [deck[k], deck[j]];
  }
  return deck.slice(0, 33);
}

test('埋底：200 手随机庄家牌，一张副 A 都不许压进底牌', () => {
  const offenders = [];
  for (let i = 0; i < 200; i += 1) {
    const trumpSuit = SUITS[i % 4];
    const ctx = { trumpSuit, rankCard: 2 };
    const hand = dealDeclarerHand(1000 + i);
    const buried = chooseKittyCards(hand, ctx);
    const aces = buried.filter(
      c => c.suit !== 'JOKER' && c.suit !== trumpSuit && c.rank === 14 && c.rank !== ctx.rankCard
    );
    if (aces.length > 0) offenders.push(`seed ${1000 + i} 主${trumpSuit}: ${aces.map(c => c.suit + c.rank).join(',')}`);
  }
  assert.deepEqual(offenders, [], `这些局把副 A 压底了：\n${offenders.join('\n')}`);
});

// 反向保护：第一版惩罚写过头，把「埋 K 断门」也一并罚掉了，
// 结果该断的门反而不敢断 —— 断门本来就是靠主牌毙，不指望封锁。
test('埋底：为了断门而埋副 K 仍然允许（别把惩罚用过头）', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  const hand = [
    ...[14, 11, 10, 9, 8, 7, 6, 4].map((r, i) => C('S', r, i)),      // 黑桃 8 张含 ♠A
    ...[16, 15, 14, 13, 12, 11, 10, 9].map((r, i) => C('H', r, i)),  // 8 张主
    ...[13, 12, 11, 10, 9, 8, 5, 3].map((r, i) => C('D', r, i)),     // 方块 8 张含 ♦K
    ...[13, 12, 11, 10, 9, 8, 5, 4, 3].map((r, i) => C('C', r, i)),  // 9 张梅花
  ];
  assert.equal(hand.length, 33);

  const buried = chooseKittyCards(hand, ctx);
  const retainedDiamonds = hand.filter(
    c => c.suit === 'D' && !buried.some(b => b.id === c.id)
  ).length;

  assert.equal(retainedDiamonds, 0, '应当整门埋掉方块（含 ♦K）来断门');
  assert.ok(
    !buried.some(c => c.suit === 'S' && c.rank === 14),
    '但绝不能改成拿 ♠A 去换这个断门'
  );
});

test('埋底：主牌一张都不埋（老规矩，顺带钉住）', () => {
  for (let i = 0; i < 40; i += 1) {
    const trumpSuit = SUITS[i % 4];
    const ctx = { trumpSuit, rankCard: 2 };
    const hand = dealDeclarerHand(5000 + i);
    const buried = chooseKittyCards(hand, ctx);
    assert.equal(buried.length, 8);
    const trumps = buried.filter(c => playSuitOf(c, trumpSuit, ctx.rankCard) === 'TRUMP');
    assert.deepEqual(trumps, [], `seed ${5000 + i} 把主牌埋了：${trumps.map(c => c.suit + c.rank).join(',')}`);
  }
});

// ---- 求件：不能乱求 ----
//
// Glen：「一般件不能乱求，有时候自己的副牌太弱，求了之后反而是帮对手
// 把对方需要的件求出来」。
//
// 机制上他是对的：canThrowByStatus 要求该门每一件都 !== 'unseen'，
// 所以每逼出一件，就是替【还攥着剩下那些件的人】往甩牌资格上推一步。
// 自己一件都没有还去探，三家里两家是对手，平均就是在帮对手。
//
// 改之前 pieceSeekingLead 的条件只有 `unseen >= 2 && 牌够长`，
// 打分还是 `cards.length * 10 - mine * 2` —— 自己件越多探件意愿越低，完全反了。


function probeView() {
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  return {
    phase: 'PLAYING',
    declarerSeat: 1,
    you: {
      seat: 0,
      team: 0,
      hand: [
        ...[12, 11, 10, 9, 8, 7, 6].map((r, i) => C('S', r, i)), // 黑桃 7 张，一件都没有
        ...[14, 10, 9, 8, 7, 6].map((r, i) => C('D', r, i)),     // 方块 6 张，握着 ♦A
        ...[16, 5, 4].map((r, i) => C('H', r, i)),               // 3 张主
      ],
    },
    players: [0, 1, 2, 3].map(seat => ({ seat, team: seat % 2, handCount: 16 })),
    round: {
      trumpSuit: 'H',
      rankCard: 2,
      kittyCount: 8,
      currentTrick: [],
      trickHistory: [{ trickNo: 1, leadSeat: 1, leadSuit: 'H', plays: [], winnerSeat: 1, points: 0 }],
      piecesView: {
        S: [ // 黑桃 4 件全在别人暗牌里 —— 探它就是纯替别人求件
          { rank: 14, status: 'unseen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' },
        ],
        D: [ // 方块我握着一张 A —— 探它是把剩下的逼出来给【我自己】凑条件
          { rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'seen' },
        ],
        C: [],
      },
    },
    botDifficulty: 'expert',
    botBeliefs: { players: {} },
  };
}

test('求件：自己无件的长门不去探（那是替对手求件）', () => {
  const lead = chooseLeadCards(probeView())[0];
  assert.notEqual(lead.suit, 'S', '黑桃 4 件全在别人手上，自己一件没有，不该领黑桃探件');
});

test('求件：优先探自己握着件的那门', () => {
  const lead = chooseLeadCards(probeView())[0];
  assert.equal(lead.suit, 'D', '方块握着 ♦A，探它才是给自己凑甩牌条件');
  assert.equal(lead.rank, 6, '探件用该门最小的无分牌');
});

// ⚠️ 上面两条钉住的其实是【打分】，不是【条件】：旧条件配新打分照样能过。
// 变异测试把这个漏洞抓出来了。这一条专门钉【条件】——
// 把无件长门做得足够长，让它在旧条件下能靠 cards.length * 10 压过有件的那门。
test('求件：无件长门再长也不探（钉住条件本身，不只是打分）', () => {
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  const view = probeView();
  view.you.hand = [
    ...[12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((r, i) => C('S', r, i)), // 黑桃 10 张，一件没有
    ...[14, 10, 9, 8, 7, 6].map((r, i) => C('D', r, i)),              // 方块 6 张，握 ♦A
    ...[16, 5].map((r, i) => C('H', r, i)),
  ];
  const lead = chooseLeadCards(view)[0];
  assert.notEqual(
    lead.suit, 'S',
    '黑桃 10 张但一件都没有：旧代码会因为「牌最长」去探它，等于替对手求出 4 件黑桃'
  );
  assert.equal(lead.suit, 'D', '该探的是自己握着 ♦A 的方块');
});

// ============ 吊主 ============
//
// Glen 实战反馈：「吊主的时候 BOT 通常就吊一轮，后边似乎忘了吊主这回事」。
// 查下来不是忘了 —— chooseLeadCards 里【只有】开局庄家那一条吊主提案，
// 第一墩之后整个函数再没有任何主动吊主。
//
// 他给的策略模型（逐条实现在 bot-policy.js 的 assessBottomControl 一段）：
//   1. 先判断自己是不是「保底牌」→ 是就吃大不吊
//   2. 不是 → 看角色：我做庄=保守续吊；队友做庄=跟他路子；闲家=无所谓
//   3. 横切：副牌够强就转打副牌

const T = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });

function leadView({
  hand, declarerSeat = 0, mySeat = 0, trickHistory = [],
  piecesView = { S: [], D: [], C: [] }, botTuning,
}) {
  return {
    botTuning,
    phase: 'PLAYING',
    declarerSeat,
    you: { seat: mySeat, team: mySeat % 2, hand },
    players: [0, 1, 2, 3].map(seat => ({ seat, team: seat % 2, handCount: 12 })),
    round: {
      trumpSuit: 'H', rankCard: 2, kittyCount: 8,
      currentTrick: [], trickHistory, piecesView,
    },
    botDifficulty: 'expert',
    botBeliefs: { players: {} },
  };
}

// 9 张主（主花色 H，含 A/K/Q 可用来吊），外加两门弱副牌
const NINE_TRUMPS = [14, 13, 12, 11, 10, 9, 8, 7, 6].map((r, i) => T('H', r, i));
const WEAK_SIDES = [
  ...[9, 7, 5].map((r, i) => T('S', r, i)),
  ...[8, 6, 4].map((r, i) => T('D', r, i)),
];
const PLAYED_SOMETHING = [
  { trickNo: 1, leadSeat: 1, leadSuit: 'S', winnerSeat: 1, points: 0, plays: [] },
];

test('吊主：庄家没保底、副牌不强 → 开局之后继续吊主（不再只吊一轮）', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0, trickHistory: PLAYED_SOMETHING,
  }))[0];
  assert.equal(lead.suit, 'H', '应当继续领主牌吊主');
  assert.ok(lead.rank >= 12, `吊主要用主花色大牌把对手的主逼出来，实际出了 H${lead.rank}`);
});

test('吊主：有保底牌（双大鬼 + 9 张主）→ 吃大不吊', () => {
  const hand = [
    T('H', 16, 0), T('H', 16, 1),                                  // 双大鬼
    ...[14, 13, 12, 11, 10, 9, 8].map((r, i) => T('H', r, i + 2)), // 凑满 9 张主
    ...WEAK_SIDES,
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 0, mySeat: 0, trickHistory: PLAYED_SOMETHING,
  }))[0];
  assert.notEqual(lead.suit, 'H', '够保底就不该再吊主，该去副牌发展/收分');
});

test('吊主：副牌够强（能甩）→ 转打副牌，不死吊主', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...[14, 13, 9, 7].map((r, i) => T('S', r, i))],
    declarerSeat: 0, mySeat: 0, trickHistory: PLAYED_SOMETHING,
    piecesView: {
      // 黑桃四件全在我手上或已现 → canThrowByStatus 成立，这门能甩
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'seen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'seen' }],
      D: [], C: [],
    },
  }))[0];
  assert.notEqual(lead.suit, 'H', '副牌能甩就该打副牌威胁对方，不该继续吊主');
});

// hasStrongSideSuit 有两条分支。上一条走的是「能甩」，但那时 safe-side-throw（620 分）
// 本来就压过吊主（520 分），gate 在不在结果都一样 —— 变异测试证明那条测试没钉住 gate。
// 这一条走另一条分支：件多且够长【但还不能甩】，此时没有甩牌提案顶着，
// 只有 !strongSide 这个 gate 能拦住吊主。
test('吊主：副牌件多且够长（还不能甩）→ 仍然转副牌，不死吊主', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...[14, 13, 9, 7, 5].map((r, i) => T('S', r, i))],
    declarerSeat: 0, mySeat: 0, trickHistory: PLAYED_SOMETHING,
    // 显式给 pieceProbeMinLength: 6（进化权重里就是 6，默认值才是 5）。
    // 不这么写的话 5 张的黑桃会同时触发 seek-piece(450)，
    // 和 develop-long-side-suit(160) 叠加到同一张牌上凑成 610 分，
    // 本来就压过吊主的 520 —— 测试会「碰巧通过」，钉不住 !strongSide 这个 gate。
    botTuning: { pieceProbeMinLength: 6 },
    piecesView: {
      // 我握着 ♠A ♠K 两件，另外两件还在别人手上 → canThrowByStatus 不成立，甩不了
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      D: [], C: [],
    },
  }))[0];
  assert.notEqual(lead.suit, 'H', '副牌件多又够长，容易得分，不该继续死吊主');
});

test('吊主：队友做庄且庄家在吊主 → 跟着吊', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 2, mySeat: 0, // 座位 0/2 同队 → 队友做庄
    trickHistory: [{ trickNo: 1, leadSeat: 2, leadSuit: 'TRUMP', winnerSeat: 2, points: 0, plays: [] }],
  }))[0];
  assert.equal(lead.suit, 'H', '庄家吊主，队友应当跟着吊');
});

test('吊主：队友做庄但庄家在打副牌 → 跟着打副牌，不自作主张吊主', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 2, mySeat: 0,
    trickHistory: [{ trickNo: 1, leadSeat: 2, leadSuit: 'S', winnerSeat: 2, points: 0, plays: [] }],
  }))[0];
  assert.notEqual(lead.suit, 'H', '庄家走副牌路线，队友不该反过来吊主');
});

test('吊主：自己是闲家 → 不特意吊主（哪里好得分打哪里）', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 1, mySeat: 0, trickHistory: PLAYED_SOMETHING,
  }))[0];
  assert.notEqual(lead.suit, 'H', '闲家没有保底负担，不该死吊主');
});

// ---- 保底判定的动态性（整个模型的核心）----


const CTX = { trumpSuit: 'H', rankCard: 2 };
const nineTrumpsWith = extra => [
  ...extra,
  ...[13, 12, 11, 10, 9, 8, 7, 6, 5].slice(0, 9 - extra.length).map((r, i) => T('H', r, i + 90)),
];
const bcView = (hand, played = []) => ({
  you: { seat: 0, hand },
  round: {
    trumpSuit: 'H', rankCard: 2, currentTrick: [],
    trickHistory: played.length ? [{ trickNo: 1, leadSeat: 1, leadSuit: 'TRUMP', plays: [{ seat: 1, cards: played }] }] : [],
  },
});

test('保底：双大鬼 + 9 张主 → 成立', () => {
  const c = assessBottomControl(bcView(nineTrumpsWith([T('H', 16, 0), T('H', 16, 1)])), CTX);
  assert.equal(c.holdsTopTrump, true);
  assert.equal(c.guaranteed, true);
});

test('保底：只有一张大鬼、另一张还没现身 → 不成立（同强度先出者大，赌不得）', () => {
  const c = assessBottomControl(bcView(nineTrumpsWith([T('H', 16, 0)])), CTX);
  assert.equal(c.holdsTopTrump, false, '另一张大鬼可能在对手手上');
  assert.equal(c.guaranteed, false);
});

// 这条是 Glen 模型的关键：保底是【动态】的
test('保底：别人把另一张大鬼打出来了 → 我剩的这张大鬼就够保底', () => {
  const c = assessBottomControl(
    bcView(nineTrumpsWith([T('H', 16, 0)]), [{ id: 'x', suit: 'JOKER', rank: 16 }]),
    CTX
  );
  assert.equal(c.holdsTopTrump, true, '大鬼两张已全部现身（一张我的、一张出掉了）');
  assert.equal(c.guaranteed, true);
});

test('保底：大鬼全出完后，双小鬼接上顶档 → 成立', () => {
  const c = assessBottomControl(
    bcView(nineTrumpsWith([T('H', 15, 0), T('H', 15, 1)]),
      [{ id: 'j1', suit: 'JOKER', rank: 16 }, { id: 'j2', suit: 'JOKER', rank: 16 }]),
    CTX
  );
  assert.equal(c.holdsTopTrump, true);
});

test('保底：握住顶档但主牌太短（<9）→ 不算保底牌（会先被吊空）', () => {
  const hand = [T('H', 16, 0), T('H', 16, 1), T('H', 5, 2), T('H', 4, 3)];
  const c = assessBottomControl(bcView(hand), CTX);
  assert.equal(c.holdsTopTrump, true, '顶档确实握住了');
  assert.equal(c.trumpCount, 4);
  assert.equal(c.guaranteed, false, '但只有 4 张主，撑不到最后一轮');
});
