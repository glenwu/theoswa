import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessBottomControl, chooseFollowCards, chooseKittyCards, chooseLeadCards,
  evaluateFollowChoices, roundStrategy,
} from '../bot-policy.js';
import { cardPoints as cardPointsOf } from '../cards.js';
import { buildDeck, playSuitOf } from '../cards.js';
import { mulberry32 } from '../rng.js';
import { trickLeader } from '../trick.js';

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
      // ⚠️ 方块从 6 张改成 8 张，是因为 Glen 后来给了「求件方资格」的门槛：
      // 两件以上要 ≥6 支，【只有一件要 8 支 9 支以上】。原来的 6 张单件不够格 ——
      // 那门其实不强，逼出来的件多半是喂给对手。
      // 这几条测试要钉的是「探有件的那门、不探无件的长门」，意图没变，只是把
      // fixture 抬到新门槛之上，否则它钉住的是一条 Glen 明确否掉的打法。
      hand: [
        ...[12, 11, 10, 9, 8, 7, 6].map((r, i) => C('S', r, i)),    // 黑桃 7 张，一件都没有
        ...[14, 10, 9, 8, 7, 6, 5, 3].map((r, i) => C('D', r, i)),  // 方块 8 张，握着 ♦A
        ...[16, 5, 4].map((r, i) => C('H', r, i)),                  // 3 张主
      ],
    },
    players: [0, 1, 2, 3].map(seat => ({ seat, team: seat % 2, handCount: 18 })),
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
  assert.equal(lead.rank, 3, '探件用该门最小的无分牌（方块补长后最小的无分牌是 ♦3）');
});

// ⚠️ 上面两条钉住的其实是【打分】，不是【条件】：旧条件配新打分照样能过。
// 变异测试把这个漏洞抓出来了。这一条专门钉【条件】——
// 把无件长门做得足够长，让它在旧条件下能靠 cards.length * 10 压过有件的那门。
test('求件：无件长门再长也不探（钉住条件本身，不只是打分）', () => {
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  const view = probeView();
  view.you.hand = [
    ...[12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((r, i) => C('S', r, i)), // 黑桃 10 张，一件没有
    ...[14, 10, 9, 8, 7, 6, 5, 3].map((r, i) => C('D', r, i)),        // 方块 8 张，握 ♦A（够求件资格）
    ...[16, 5].map((r, i) => C('H', r, i)),
  ];
  for (const p of view.players) p.handCount = 20;
  const lead = chooseLeadCards(view)[0];
  assert.notEqual(
    lead.suit, 'S',
    '黑桃 10 张但一件都没有：旧代码会因为「牌最长」去探它，等于替对手求出 4 件黑桃'
  );
  assert.equal(lead.suit, 'D', '该探的是自己握着 ♦A 的方块');
});

// Glen 给的「求件方资格」门槛分两档：两件以上 ≥6 支，【只有一件要 8 支 9 支以上】。
// 上面几条走的是单件 8 支那一档；这一条钉住【单件不够长就不去求】——
// 少了它，把 SINGLE_PIECE_MIN_LENGTH 改回 6 也照样绿。
// ⚠️ 黑桃必须是【最长的门】，否则 develop-long-side-suit 自己就会挑中 ♦3，
// 求件分支在不在结果都一样 —— 被测的分支根本没参与决策（第一版就栽在这里）。
// 黑桃 8 张无件（develop 会选它）vs 方块 6 张单件（只有求件分支才会选它）。
test('求件：只有一件而且这门不够长（6 支）→ 不去求件', () => {
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  const view = probeView();
  view.you.hand = [
    ...[12, 11, 10, 9, 8, 7, 6, 4].map((r, i) => C('S', r, i)), // 黑桃 8 张，一件没有
    ...[14, 10, 9, 8, 7, 3].map((r, i) => C('D', r, i)),        // 方块只有 6 张，握 ♦A
    ...[16, 5].map((r, i) => C('H', r, i)),
  ];
  for (const p of view.players) p.handCount = 16;
  const lead = chooseLeadCards(view)[0];
  assert.equal(lead.suit, 'S',
    `一件配六张不算强，不该去求方块，实际领了 ${lead.suit}${lead.rank}`);
});

// 两件那一档仍然是 6 支就够 —— 两条一起才钉得住「分两档」这件事本身。
test('求件：两件而且这门有 6 支 → 够格，去求件', () => {
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  const view = probeView();
  view.you.hand = [
    ...[12, 11, 10, 9, 8, 7, 6, 4].map((r, i) => C('S', r, i)), // 同上：黑桃 8 张无件
    ...[14, 13, 9, 8, 7, 3].map((r, i) => C('D', r, i)),        // 方块 6 张，握 ♦A ♦K 两件
    ...[16, 5].map((r, i) => C('H', r, i)),
  ];
  view.round.piecesView.D = [
    { rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
    { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' },
  ];
  for (const p of view.players) p.handCount = 16;
  const lead = chooseLeadCards(view)[0];
  assert.equal(lead.suit, 'D', '两件配六张够格，该探方块（黑桃更长，但一件都没有）');
  assert.equal(lead.rank, 3, '探件用该门最小的无分牌');
});

// 两件那一档也要看牌长（≥6 支）。少了这条，把它写成「有两件就够」也照样绿。
test('求件：两件但这门只有 4 支 → 太短，不去求件', () => {
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  const view = probeView();
  view.you.hand = [
    ...[12, 11, 10, 9, 8, 7, 6, 4].map((r, i) => C('S', r, i)), // 黑桃 8 张无件（develop 会选它）
    ...[14, 13, 9, 3].map((r, i) => C('D', r, i)),              // 方块只有 4 张，但握两件
    ...[16, 5].map((r, i) => C('H', r, i)),
  ];
  view.round.piecesView.D = [
    { rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
    { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' },
  ];
  for (const p of view.players) p.handCount = 14;
  const lead = chooseLeadCards(view)[0];
  assert.equal(lead.suit, 'S',
    `两件配四张太短，逼出来的件多半喂给对手，实际领了 ${lead.suit}${lead.rank}`);
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
  // 这手是弱势主（没有鬼、没有级牌，顶档一张都没有）→ 该吊小牌，
  // 逼对手用大牌来杀，拿我的小牌换他的大牌。
  assert.equal(lead.rank, 6, `弱势主该吊最小的那张，实际出了 H${lead.rank}`);
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

// ---- 庄家「带分吊主」求大鬼，收到应答就该收手（Glen 实战）----
//
// 这条约定原来只实现了应答的一半：队友收到信号会转副牌，庄家自己却从不回头看
// 队友答没答，于是一路吊下去 —— Glen 用小鬼应了，它还在吊，吊到只剩两个鬼。
//
// 首墩带分的领牌 = 求大鬼。队友这一墩必须跟主，能表达的只有【出不出顶张】；
// 他之后拿到牌权【领副牌】是同一个意思。
const signalTrick = (answer, winnerSeat = 0) => ({
  trickNo: 1, leadSeat: 0, leadSuit: 'TRUMP', winnerSeat, points: 5,
  plays: [
    { seat: 0, cards: [T('H', 5, 80)] },  // 庄家自己：带分的主牌 = 求大鬼
    { seat: 3, cards: [T('H', 4, 81)] },
    { seat: 2, cards: answer },           // 队友（座位 0/2 同队）
    { seat: 1, cards: [T('H', 3, 82)] },
  ],
});

test('吊主：庄家求大鬼，队友用小鬼应答 → 收手转副牌，不再吊', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0,
    trickHistory: [signalTrick([{ id: 'sj1', suit: 'JOKER', rank: 15 }], 2)],
  }))[0];
  assert.notEqual(lead.suit, 'H', '队友已经表示顶端有人管，庄家该去跑副牌保底');
});

// 对照：同一个信号，队友只跟了一张小主 = 没有大牌可表示 → 照旧接着吊。
// 少了这条，把 trumpSignalAnswered 写成恒真也能过上面那条。
test('吊主：庄家求大鬼，队友只垫了张小主 → 没收到应答，继续吊', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0,
    trickHistory: [signalTrick([T('H', 6, 83)])],
  }))[0];
  assert.equal(lead.suit, 'H', '队友没表示，庄家保不了底，还得接着吊');
});

// 第二种应答形态：队友吃下这一墩之后自己【领副牌】。
// ⚠️ 让他领的是【我一张都没有】的梅花 —— 否则 return-partner-suit 会替我
// 挑一张副牌出来，测试就算 gate 失效也照样领副牌（碰巧通过）。
test('吊主：庄家求大鬼，队友吃下后转领副牌 → 同样算应答，收手', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],   // 只有黑桃和方块，没有梅花
    declarerSeat: 0, mySeat: 0,
    trickHistory: [
      signalTrick([T('H', 14, 84)], 2),
      { trickNo: 2, leadSeat: 2, leadSuit: 'C', winnerSeat: 2, points: 0, plays: [] },
    ],
  }))[0];
  assert.notEqual(lead.suit, 'H', '队友转副牌就是「不用吊主」的表达');
});

// 「收手」只对【带分】那一墩负责：庄家吊了一张不带分的小主不是求大鬼，
// 队友之后领副牌也就不是应答，该吊还得接着吊。
test('吊主：庄家首墩吊的是不带分的小主 → 队友领副牌不算应答，继续吊', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0,
    trickHistory: [
      { trickNo: 1, leadSeat: 0, leadSuit: 'TRUMP', winnerSeat: 2, points: 0,
        plays: [{ seat: 0, cards: [T('H', 3, 85)] }, { seat: 2, cards: [T('H', 14, 86)] }] },
      { trickNo: 2, leadSeat: 2, leadSuit: 'C', winnerSeat: 2, points: 0, plays: [] },
    ],
  }))[0];
  assert.equal(lead.suit, 'H', '没发过求大鬼的信号，就没有「应答」可收');
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

// 上一条其实没隔离住「跟庄家路子」这个 gate：那个局面里 return-partner-suit(400)
// 叠上 develop-long-side-suit(160) 已经压过吊主，gate 在不在都领副牌。
// 这一条让【队友求的那门我一张都没有】，partnerRequest 直接返回 null，
// 就只剩 declarerLeadStyle 这一个决定因素了。
test('吊主：队友做庄在打副牌、而那门我没有牌 → 仍然不吊主（钉住「跟庄家路子」）', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],   // 只有黑桃和方块，没有梅花
    declarerSeat: 2, mySeat: 0,
    trickHistory: [{ trickNo: 1, leadSeat: 2, leadSuit: 'C', winnerSeat: 2, points: 0, plays: [] }],
  }))[0];
  assert.notEqual(lead.suit, 'H', '庄家走的是副牌路线，队友不该自作主张吊主');
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

// ---- 张数对比（Glen 实战：「出了小鬼他就有了」）----
//
// 手上大鬼 + 小鬼，另一张大鬼始终没现身。按「独占顶档」判永远不保底，
// 电脑就一路吊主吊到只剩两个鬼。但外面只剩一张大鬼时，它只能换掉我一张顶牌，
// 我还剩一张 —— 保底其实已经成立。
const JOKER_HAND = [T('H', 16, 0), T('H', 15, 1)];

test('保底：大鬼+小鬼，外面只剩一张大鬼没现身 → 成立（他那张只能换我一张）', () => {
  const c = assessBottomControl(
    bcView(nineTrumpsWith(JOKER_HAND), [{ id: 'sj', suit: 'JOKER', rank: 15 }]),
    CTX
  );
  assert.equal(c.holdsTopTrump, true, '我两张顶牌 > 对手一张威胁');
  assert.equal(c.guaranteed, true);
});

// 上一条的对照：同一手牌，小鬼还没出来的时候【不】成立。
// 两条一起才钉得住「动态」——单看成立那条，判据写成恒真也能过。
test('保底：同一手牌，另一张小鬼还没现身 → 不成立（两张威胁对两张顶牌）', () => {
  const c = assessBottomControl(bcView(nineTrumpsWith(JOKER_HAND)), CTX);
  assert.equal(c.holdsTopTrump, false, '大鬼+小鬼各一张在外，正好换得完');
});

// 同强度必须算成威胁：同强度先出者大，我不能指望最后一轮由我先出。
// 若把同档的 outstanding 漏加，这一手会被误判成保底。
test('保底：双小鬼但两张大鬼都没现身 → 不成立（同强度也算别人能压我）', () => {
  const c = assessBottomControl(
    bcView(nineTrumpsWith([T('H', 15, 0), T('H', 15, 1)])), CTX
  );
  assert.equal(c.holdsTopTrump, false, '外面两张大鬼，我两张小鬼，换得完');
});

// ---- 吊主出哪张：弱吊小、强吊大（Glen 纠正）----
//
// 打 2 时主牌阶梯：大鬼 > 小鬼 > 主2 > 副2 > 主花色 A > K > Q > …
// 主花色的 A/K/Q 是主牌里偏小的几档，级牌和鬼才是大牌。
// 曾经这里写成「用主花色 A/K/Q 去吊」，两头不靠。

// ⚠️ 本条原来断言「强势主 → 吊大牌」，已由 Glen 纠正：
// 吊大牌是为了抢主动权，只在【明确需要】时才做；手上主牌强不构成理由。
// 没有明确理由时一律吊小牌 —— 打 7 时级牌恰好是主7/副7，
// 「强势就吊级牌」在牌桌上看着就是「第一墩吊了个 7」。
test('吊主：手上主牌再强，没有明确理由也只吊小牌', () => {
  const hand = [
    T('H', 15, 0),                                    // 小鬼
    T('H', 2, 1), T('S', 2, 2), T('D', 2, 3),         // 主2 + 两张副2（都是主牌）
    ...[14, 13, 12, 11, 10].map((r, i) => T('H', r, i + 4)),
    ...[9, 7, 5].map((r, i) => T('S', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 0, mySeat: 0, trickHistory: PLAYED_SOMETHING,
  }))[0];
  assert.equal(lead.suit, 'H', '仍然吊主');
  assert.equal(lead.rank, 10, `该吊最小的那张主，实际出了 H${lead.rank}`);
});

test('吊主：弱势主（顶档一张都没有）→ 吊最小的那张', () => {
  const lead = chooseLeadCards(leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0, trickHistory: PLAYED_SOMETHING,
  }))[0];
  assert.equal(lead.suit, 'H');
  assert.equal(lead.rank, 6, '弱势主吊小牌，逼对手用大牌来杀');
});

// ---- 三件求件：缺什么打什么 ----

function threePieceView(myPieces, unseenRank) {
  const hand = [
    ...myPieces.map((r, i) => T('S', r, i)),
    ...[9, 7, 5].map((r, i) => T('S', r, i + 10)),
    ...[8, 6].map((r, i) => T('D', r, i + 20)),
    T('H', 9, 30), T('H', 8, 31),
  ];
  const items = [
    { rank: 14, status: myPieces.filter(r => r === 14).length >= 1 ? 'mine' : 'unseen' },
    { rank: 14, status: myPieces.filter(r => r === 14).length >= 2 ? 'mine' : 'unseen' },
    { rank: 13, status: myPieces.filter(r => r === 13).length >= 1 ? 'mine' : 'unseen' },
    { rank: 13, status: myPieces.filter(r => r === 13).length >= 2 ? 'mine' : 'unseen' },
  ];
  assert.equal(items.filter(i => i.status === 'unseen').length, 1, 'fixture 应当只差一支');
  assert.equal(items.find(i => i.status === 'unseen').rank, unseenRank);
  return leadView({
    hand, declarerSeat: 1, mySeat: 0, trickHistory: PLAYED_SOMETHING,
    piecesView: { S: items, D: [], C: [] },
  });
}

test('求件：AAK（差一支 K）→ 打 K', () => {
  const lead = chooseLeadCards(threePieceView([14, 14, 13], 13))[0];
  assert.equal(lead.suit, 'S');
  assert.equal(lead.rank, 13, '差 K 就打 K，队友若有另一张 K，四件到齐立刻能甩');
});

test('求件：AKK（差一支 A）→ 打 A（不是打 K）', () => {
  const lead = chooseLeadCards(threePieceView([14, 13, 13], 14))[0];
  assert.equal(lead.suit, 'S');
  assert.equal(lead.rank, 14, '差 A 就打 A；原来写死出 K，差 A 时求不到那张 A，白丢 10 分');
});

// 三件只差一支是【确定打法】，必须压过另一门的通用探件。
// 同门内已经用 continue 挡住了通用分支，所以这条只有【跨门】才测得出来。
test('求件：三件只差一支的那门，优先级高于另一门更长的通用探件', () => {
  const hand = [
    ...[14, 14, 13, 7].map((r, i) => T('S', r, i)),                   // 黑桃 AAK+7，差一支 K
    ...[14, 13, 10, 9, 8, 7, 6, 5, 4].map((r, i) => T('D', r, i + 10)), // 方块 9 张、握两件
    T('H', 9, 30), T('H', 8, 31),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 1, mySeat: 0, trickHistory: PLAYED_SOMETHING,
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'mine' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      D: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      C: [],
    },
  }))[0];
  assert.equal(lead.suit, 'S', '黑桃只差一支 K，是确定打法，不该被方块那门的通用探件抢走');
  assert.equal(lead.rank, 13, '差 K 就打 K');
});

// ---- 帮队友求件是【动态】的 ----
//
// Glen：「如果判断对家是很想要求件（比如对家是庄）通常要帮助他把件逼出来，
// 当然这个也是动态的，如果对家吃大，然后打其它牌，证明他有其它安排了，
// 这时候就不再帮他求件了」。
//
// 原来 preferredPartnerSuit 把队友【整局】的领牌一路累加进 scores、永不过期 ——
// 他早改打别的门了，这边还在死心塌地回他第一门。

const partnerLead = (trickNo, leadSuit, rank) => ({
  trickNo, leadSeat: 2, leadSuit, winnerSeat: 2, points: 0,
  plays: [{ seat: 2, playSuit: leadSuit, cards: [T(leadSuit, rank, 900 + trickNo)] }],
});

// 我在座位 0，队友在座位 2；手里黑桃方块都有，回哪门取决于队友要什么
const bothSuits = [
  ...[11, 9, 7, 4].map((r, i) => T('S', r, i)),
  ...[12, 10, 8, 3].map((r, i) => T('D', r, i + 10)),
  ...[9, 8].map((r, i) => T('H', r, i + 20)),
];

test('帮队友求件：队友打 5 以下求黑桃 → 回黑桃', () => {
  const lead = chooseLeadCards(leadView({
    hand: bothSuits, declarerSeat: 2, mySeat: 0,
    trickHistory: [partnerLead(1, 'S', 3)],
  }))[0];
  assert.equal(lead.suit, 'S', '队友打 ♠3 是明确的求件信号，该回黑桃');
});

test('帮队友求件：队友后来改打方块 → 不再回黑桃（信号会过期）', () => {
  const lead = chooseLeadCards(leadView({
    hand: bothSuits, declarerSeat: 2, mySeat: 0,
    trickHistory: [partnerLead(1, 'S', 3), partnerLead(2, 'D', 3)],
  }))[0];
  assert.equal(lead.suit, 'D', '队友改打方块了，说明他有别的安排，黑桃那条请求作废');
});

// 用【闲家】视角测：队友做庄时「跟着庄家吊主」的逻辑会自己领主牌，
// 那样即使 partnerRequest 错误地返回 TRUMP 也看不出差别（两条都领主）。
// 闲家没有跟庄的义务，才能把「队友改吊主 → 这条请求作废」单独钉住。
test('帮队友求件：队友改吊主 → 那条求件请求作废，不跟着去领主牌', () => {
  // 方块给到 6 张、黑桃只留 3 张：这样「自己发展最长副牌」的答案明确是方块，
  // 领到黑桃或主牌都只能是被过期的请求带偏（bothSuits 是 4-4 平手，测不出来）。
  const hand = [
    ...[11, 9, 4].map((r, i) => T('S', r, i)),
    ...[12, 10, 8, 7, 5, 3].map((r, i) => T('D', r, i + 10)),
    ...[9, 8].map((r, i) => T('H', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 1, mySeat: 0, // 对手做庄，我和队友都是闲家
    trickHistory: [
      partnerLead(1, 'S', 3),
      { trickNo: 2, leadSeat: 2, leadSuit: 'TRUMP', winnerSeat: 2, points: 0, plays: [] },
    ],
  }))[0];
  assert.notEqual(lead.suit, 'H', '队友领主牌不是在求件，不该被当成「回他这门」而去领主');
  assert.equal(lead.suit, 'D', '黑桃那条请求已作废，该回到发展自己最长的副牌');
});

// ============ 求件应答 · 庄家带分吊主 ============


function followView({
  hand, currentTrick, seat = 2, declarerSeat = 0, piecesView = { S: [], D: [], C: [] },
  trickHistory = [], defenderTrickPoints = 0, botTuning,
}) {
  return {
    phase: 'PLAYING', declarerSeat, botTuning,
    you: { seat, team: seat % 2, hand, crossRiver: {} },
    players: [0, 1, 2, 3].map(s2 => ({ seat: s2, team: s2 % 2, handCount: 12 })),
    round: {
      trumpSuit: 'H', rankCard: 2, kittyCount: 8,
      currentTrick, trickHistory, piecesView, defenderTrickPoints,
    },
    botDifficulty: 'expert',
    botBeliefs: { players: {} },
  };
}

// 原来 scoreFollow 里只有消极的一半（opponentProbe 罚 -320，别帮对手消件），
// 队友求件时电脑没有任何动力把件贡献出去，于是 chooseLeadCards 里那条
// 'continue-contributed-piece' 约定几乎触发不了。
// 座位 2 是【第二家】，后面还有两个人 —— 这时把 10 分的 ♠K 打出去本来是亏的
// （scoreFollow 里 candidatePoints × 12 的分牌暴露惩罚）。只有「队友求件该贡献」
// 这条约定能把它推出去。
// ⚠️ 第一版这条测试让 bot 坐第三家、手里是 ♠A：打 A 稳赢这一墩，本来就会打，
// 加不加贡献分都一样 —— 变异测试证明它根本没钉住东西。
function contributionView({ partnerLead = T('S', 4, 90), unseen = 2, difficulty = 'expert' } = {}) {
  const items = [
    { rank: 14, status: 'seen' }, { rank: 14, status: 'seen' },
    { rank: 13, status: 'mine' }, { rank: 13, status: unseen >= 1 ? 'unseen' : 'seen' },
  ];
  if (unseen >= 2) items[1].status = 'unseen';
  const view = followView({
    seat: 2,
    hand: [T('S', 13, 0), T('S', 9, 1), T('S', 6, 2), T('S', 3, 3),
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10))],
    currentTrick: [{ seat: 0, playSuit: 'S', cards: [partnerLead] }],
    piecesView: { S: items, D: [], C: [] },
  });
  view.botDifficulty = difficulty;
  return view;
}

test('求件应答：队友打小牌求件 → 把件贡献出去（哪怕是 10 分的 K、后面还有两家）', () => {
  const cards = chooseFollowCards(contributionView({ unseen: 1 }));
  assert.equal(cards[0].rank, 13, '队友求件，就该把 ♠K 贡献出去');
});

// 直接比评分，不虚构「决策翻转」：未现件多的时候它仍然会贡献，
// 只是少拿那 320 的「多半能凑齐」加成。断言写成翻转就是过度声称。
test('求件应答：只剩一件没露时，贡献的评分明显更高', () => {
  const scoreOfKing = view =>
    evaluateFollowChoices(view).find(c => c.cards[0].rank === 13).score;
  const few = scoreOfKing(contributionView({ unseen: 1 }));
  const many = scoreOfKing(contributionView({ unseen: 2 }));
  assert.ok(
    few > many + 200,
    `只剩一件没露时贡献该明显更值：unseen=1 得 ${few.toFixed(0)}，unseen=2 得 ${many.toFixed(0)}`
  );
});

test('求件应答：队友领的是大牌（不是求件）→ 不贡献', () => {
  const cards = chooseFollowCards(contributionView({ partnerLead: T('S', 11, 90), unseen: 1 }));
  assert.notEqual(cards[0].rank, 13, '领 ♠J 不是求件信号，别自作多情把 K 送出去');
});

test('求件应答：easy 电脑不会这一手（约定/读牌能力，inference = 0）', () => {
  const cards = chooseFollowCards(contributionView({ unseen: 1, difficulty: 'easy' }));
  assert.notEqual(cards[0].rank, 13);
});

test('求件应答：对手求件 → 护住不给', () => {
  const view = followView({
    seat: 2, declarerSeat: 1,
    hand: [T('S', 13, 0), T('S', 9, 1), T('S', 6, 2), T('S', 3, 3),
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10))],
    currentTrick: [{ seat: 1, playSuit: 'S', cards: [T('S', 4, 90)] }],
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'seen' }],
      D: [], C: [],
    },
  });
  assert.notEqual(chooseFollowCards(view)[0].rank, 13, '对手求件时打出 ♠K 等于替他消掉一个未现件');
});

// Glen：「如果判断他并没有剩很多，又没分，自己可能留这个大牌还有其它用，那就不打」
// —— 反过来说，这墩【有分】而且我这一下能赢，就该用件把分吃回来，不能死护着。
// 护件是为了不让对手凑齐甩牌资格，不是为了把 A 带进棺材。
//
// 座位 2；对手(1)领 ♠4 求件；队友(0)跟一张；座位 3 还在后面。
// 唯一变量就是队友那张牌带不带分。
// spades = 我这门黑桃有哪几张；table = 桌上另外两家已经打出的黑桃；
// allSeen = 这门的件是不是已经全现（全现了亮不亮都一样，不该再罚）
function opponentProbeView(table, spades = [14, 9, 6, 3], allSeen = false) {
  return followView({
    seat: 2, declarerSeat: 1,
    hand: [...spades.map((r, i) => T('S', r, i)),
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10))],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [T('S', table[0], 90)] },
      { seat: 0, cards: [T('S', table[1], 91)] },
    ],
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: allSeen ? 'seen' : 'unseen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
      D: [], C: [],
    },
  });
}

test('亮件：对手求件、桌上无分 → 护住 ♠A 不打', () => {
  assert.notEqual(chooseFollowCards(opponentProbeView([4, 3]))[0].rank, 14);
});

// ⚠️ 这条原来断言「5 分也值得吃、10 分更该吃」，是我按 Glen 早先那句
//「有分而且我这一下能赢，就该用件把分吃回来」写的。他后来给了更准的判据，
// 把这条推翻了：「如果对方可能因为自己的 A 可以甩很长、得很多分，
//   有这个可能性的话，最好是不打；如果自己这门已经快断了……这个时候也可以吃，
//   需要看当时的情况。」
// 这个 fixture 正好是「不该打」的那一侧：我黑桃 4 张（打完 ♠A 还剩 3 张，不算快断），
// 而对手在这门可能还握着 5 张左右 —— 亮了 ♠A 就是把甩牌资格递过去。
test('亮件：这门还长、对手可能甩很长 → 5 分不值得亮 ♠A', () => {
  assert.notEqual(chooseFollowCards(opponentProbeView([4, 5]))[0].rank, 14, '5 分不值');
});

// ⚠️ 只钉 5 分，【故意不钉 10 分】。10 分那档实测仍然会打 ♠A，但那不是
// 「冒险亮件吃分」，是【封分】：桌上 10 分、最后一家还没出，我垫小牌的话
// 他可能用更大的黑桃把这 10 分抢走（scoreFollow 的 lastSeatPointRisk 正是这一项）。
// 「亮件的风险」和「封住最后一家」是两笔账，Glen 给的判据只讲了前者，
// 后者要不要让路还没有裁定 —— 没裁定的事不写成断言。

// ---- 策略接到出牌上：闲家吃分为主，同样局面吃的概率更大（Glen）----
//
// 「像刚才的第三家有 10 分吃不吃 A 的问题，如果是闲家，吃的概率应该得更大，
//   因为自己的策略就以吃分为主。」
//
// ⚠️ 两条必须成对：【同一手牌、同一墩】，只把庄家换个座位。
// 手上给了 3 张主 + 一门有威胁的副牌，否则庄家那边会因为「保底已经不现实」
// 同样落到 points-first，两边就分不出来了（第一版就栽在这）。
// ⚠️ 显式给 pointsFirstPieceWeight —— 默认值 0.85 折得太轻，翻不动决策，
// 那样这两条就变成「碰巧一样/碰巧不一样」，钉不住结构。量级留给训练去搜。
function strategyPieceView(declarerSeat) {
  return followView({
    seat: 2, declarerSeat,
    hand: [
      ...[14, 9, 6, 3].map((r, i) => T('S', r, i)),                   // 黑桃 4 张，握 ♠A
      ...[14, 13, 10, 9, 8, 7, 5, 4].map((r, i) => T('D', r, i + 10)), // 方块 8 张（两件在手）
      ...[7, 5, 3].map((r, i) => T('H', r, i + 30)),                   // 3 张小主
    ],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [T('S', 4, 90)] },
      { seat: 0, cards: [T('S', 5, 91)] },                             // 桌上 5 分
    ],
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
      D: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      C: [],
    },
    botTuning: { pointsFirstPieceWeight: 0.5 },
  });
}

test('策略：我是闲家（吃分为主）→ 同样 5 分就把 ♠A 打出去吃回来', () => {
  const view = strategyPieceView(1);
  assert.equal(roundStrategy(view, S_CTX), 'points-first', '前提：策略确实是吃分为主');
  assert.equal(chooseFollowCards(view)[0].rank, 14);
});

test('策略：同一手牌但我在庄家一方（跑牌兼跑分）→ 5 分不值得亮 ♠A', () => {
  const view = strategyPieceView(0);
  assert.equal(roundStrategy(view, S_CTX), 'run-and-score', '前提：策略不是吃分为主');
  assert.notEqual(chooseFollowCards(view)[0].rank, 14);
});

// 例外：这门的件已经全现了 —— 我这张 ♠A 亮不亮，对手的甩牌资格都不会因此变化，
// 那就没有「冒险」可言，该吃分就吃分。
// ⚠️ 和上面那条 5 分的用【同一个 fixture】，只把这门的件全设成已现 ——
// 两条对照才钉得住「全现就不罚」这条豁免本身。
test('亮件：这门的件已经全现 → 没有风险可言，5 分也照吃', () => {
  assert.equal(chooseFollowCards(opponentProbeView([4, 5], [14, 9, 6, 3], true))[0].rank, 14,
    '件都现完了还护着 ♠A，那是白护');
});

// 例外一：桌上分够大。Glen：「如果眼前有非常大的利益，比如 20 分甚至 30 分……
// 也可以冒风险去打件吃分。」
test('亮件：桌上分够大 → 值得冒险亮 ♠A 把分吃回来', () => {
  // 对手领 ♠K(10)、队友垫 ♠10(10)，加上后面还可能来的分 —— 这一墩已经很重
  assert.equal(chooseFollowCards(opponentProbeView([13, 10]))[0].rank, 14,
    '20 分以上就该吃回来，不能把 A 带进棺材');
});

// 例外二：自己这门快断了。Glen：「如果自己这门已经快断了，比如打 A 后再捅多一支
// 或两支就断了，可以毙别人，这个时候也可以吃。」
// 同样 5 分，只把黑桃从 4 张减到 3 张（打完 ♠A 只剩 2 张）→ 可以打。
// 这两条必须成对看：单看任何一条都钉不住「快断门」这个分界。
test('亮件：同样 5 分，但我这门打完就快断了 → 可以亮 ♠A', () => {
  assert.equal(chooseFollowCards(opponentProbeView([4, 5], [14, 9, 6]))[0].rank, 14,
    '打完 ♠A 只剩两张，很快断门就能毙别人，这时候吃分不亏');
});

// ---- 庄家首轮吊主带分 ----
//
// Glen：「庄家如果首轮吊主打个分出来，证明至少有一个大鬼，但没有绝对的保底牌，
// 希望对家表示他的大牌。对家如果有大鬼，可以用大鬼吃了之后转打副牌，
// 或者不用大鬼吃，转打副牌，都是『不用吊主』的表达。」

test('信号：庄家有大鬼但不够保底 → 首轮吊主打带分的主牌', () => {
  // ⚠️ 手里必须有【比带分主牌更小的无分主牌】（这里的 ♥3 ♥4），
  // 否则「最小的带分主牌」和「最小的主牌」是同一张，测不出差别 ——
  // 第一版就是这样，变异测试直接把它戳穿了。
  const hand = [
    T('H', 16, 0),                                     // 一张大鬼（另一张没现身 → 不够保底）
    T('H', 3, 1), T('H', 4, 2),                        // 更小的【无分】主牌
    T('H', 10, 3), T('H', 13, 4),                      // 带分的主牌：♥10 / ♥K
    ...[12, 11, 9, 8, 7].map((r, i) => T('H', r, i + 5)),
    ...[9, 7].map((r, i) => T('S', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 0, mySeat: 0, trickHistory: [],  // 首轮
  }))[0];
  assert.equal(lead.suit, 'H', '首轮吊主');
  assert.ok(
    cardPointsOf(lead) > 0,
    `该打带分的主牌发信号（手里有 ♥3 ♥4 更小但无分），实际出了 H${lead.rank}`
  );
  assert.equal(lead.rank, 10, '挑最小的那张带分主牌（♥10 < ♥K），别为了发信号丢掉大牌');
});

test('信号应答：队友收到带分吊主 + 自己有大鬼 → 转打副牌表示「不用吊主」', () => {
  const hand = [
    T('H', 16, 0),                                     // 我有大鬼
    ...[12, 11, 9, 8].map((r, i) => T('H', r, i + 1)),
    ...[11, 9, 7, 4].map((r, i) => T('S', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 2, mySeat: 0,   // 队友（座位 2）做庄
    trickHistory: [{
      trickNo: 1, leadSeat: 2, leadSuit: 'TRUMP', winnerSeat: 0, points: 5,
      plays: [{ seat: 2, playSuit: 'TRUMP', cards: [T('H', 5, 90)] }],  // 带分吊主
    }],
  }))[0];
  assert.notEqual(lead.suit, 'H', '我有大鬼，转打副牌就是「不用吊主」的表达');
});

test('信号应答：庄家吊主【不带分】→ 没有这层含义，照常跟着吊', () => {
  const hand = [
    T('H', 16, 0),
    ...[12, 11, 9, 8].map((r, i) => T('H', r, i + 1)),
    ...[11, 9, 7, 4].map((r, i) => T('S', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 2, mySeat: 0,
    trickHistory: [{
      trickNo: 1, leadSeat: 2, leadSuit: 'TRUMP', winnerSeat: 0, points: 0,
      plays: [{ seat: 2, playSuit: 'TRUMP', cards: [T('H', 7, 90)] }],  // 无分
    }],
  }))[0];
  assert.equal(lead.suit, 'H', '不带分就只是普通吊主，队友该跟着吊');
});

// ============ 本局策略（Glen：「需要有一定的策略支持，然后一直跟随它去打」）============
//
// 庄家默认保底优先，保底不现实才改跑分；闲家默认吃分为主，主又长又大才撬底。
// 「保底不现实」的判据是他给的三条【同时】成立：
//   副牌基本无威胁 + 顶牌数不够 + 主牌也不够长。
const S_CTX = { trumpSuit: 'H', rankCard: 2 };
const TWO_BIG_JOKERS = [T('JOKER', 16, 0), T('JOKER', 16, 1)];
// 黑桃两件在手、5 张 → hasStrongSideSuit 成立（副牌有威胁）
const STRONG_SPADES = {
  S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
      { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
  D: [], C: [],
};

test('策略：闲家主又长又大 → 撬底', () => {
  const view = leadView({
    hand: [...TWO_BIG_JOKERS, ...[14, 13, 12, 11, 10, 9, 8].map((r, i) => T('H', r, i + 2)),
      ...WEAK_SIDES],
    declarerSeat: 1, mySeat: 0,   // 座位 0/1 不同队 → 我是闲家
  });
  assert.equal(roundStrategy(view, S_CTX), 'grab-bottom');
});

test('策略：闲家主不强 → 吃分为主', () => {
  const view = leadView({
    hand: [...[7, 5, 3].map((r, i) => T('H', r, i)), ...WEAK_SIDES],
    declarerSeat: 1, mySeat: 0,
  });
  assert.equal(roundStrategy(view, S_CTX), 'points-first');
});

test('策略：庄家有保底牌 + 主长 → 跑副牌', () => {
  const view = leadView({
    hand: [...TWO_BIG_JOKERS, ...[14, 13, 12, 11, 10, 9, 8].map((r, i) => T('H', r, i + 2)),
      ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0,
  });
  assert.equal(roundStrategy(view, S_CTX), 'run-side');
});

// 同样握着顶档，只是主牌短 —— 和上一条成对，钉住「主长不长」这个分界
test('策略：庄家有保底牌但主不长 → 跑牌兼跑分', () => {
  const view = leadView({
    hand: [...TWO_BIG_JOKERS, ...[5, 4].map((r, i) => T('H', r, i + 2)), ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0,
  });
  assert.equal(roundStrategy(view, S_CTX), 'run-and-score');
});

test('策略：庄家没有保底牌但主还长 → 吊主（自己主长别人就短）', () => {
  const view = leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES], declarerSeat: 0, mySeat: 0,
  });
  assert.equal(roundStrategy(view, S_CTX), 'draw-trumps');
});

// Glen 给的三条同时成立：副牌无威胁 + 顶牌不够 + 主牌不够长
test('策略：庄家保底已经不现实 → 改跑分为主', () => {
  const view = leadView({
    hand: [...[7, 5, 3].map((r, i) => T('H', r, i)), ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0,
  });
  assert.equal(roundStrategy(view, S_CTX), 'points-first');
});

// ---- 惯性（Glen：「每墩重算，但加很大的惯性」）----
// 同一手牌（8 张主，差一张够不上吊主门槛，副牌有威胁所以不算保底无望）：
// 没吊过主 → 跑牌兼跑分；【我自己一直在吊主】→ 继续吊，不因为少一张就改弦更张。
const INERTIA_HAND = [
  ...[14, 13, 12, 11, 10, 9, 8, 7].map((r, i) => T('H', r, i)),  // 8 张主，无顶档
  ...[9, 7, 5, 4, 3].map((r, i) => T('S', r, i + 40)),           // 黑桃 5 张（两件在手）
];

test('策略惯性：同一手牌，没吊过主 → 跑牌兼跑分', () => {
  const view = leadView({
    hand: INERTIA_HAND, declarerSeat: 0, mySeat: 0, piecesView: STRONG_SPADES,
    trickHistory: [{ trickNo: 1, leadSeat: 1, leadSuit: 'D', winnerSeat: 1, points: 0, plays: [] }],
  });
  assert.equal(roundStrategy(view, S_CTX), 'run-and-score');
});

test('策略惯性：同一手牌，但我自己一直在吊主 → 继续吊主', () => {
  const view = leadView({
    hand: INERTIA_HAND, declarerSeat: 0, mySeat: 0, piecesView: STRONG_SPADES,
    trickHistory: [{ trickNo: 1, leadSeat: 0, leadSuit: 'TRUMP', winnerSeat: 0, points: 0, plays: [] }],
  });
  assert.equal(roundStrategy(view, S_CTX), 'draw-trumps',
    '差一张就改策略的话，就谈不上「一直跟随这个策略去打」');
});

// ---- 策略接到领牌上（Glen：「一直跟随这个策略支持去打」）----
//
// 需要一个【两种策略会给出不同答案】的局面，否则钉不住接线本身：
//   · 对手连着领了两墩黑桃 → opponentThreatSuit = ♠，attack 提案 250 分
//   · 我最长的副牌是方块   → develop 提案 160 分
// 不加策略：attack(250) > develop(160) → 领黑桃。
// 「以跑副牌为主」：develop 抬到 360 → 改领方块。
// 「吃分为主」：attack 抬到 450 → 仍领黑桃（打别人不想自己打的牌）。
//
// ⚠️ 主牌那一头必须让两个 fixture 都【不会去吊主】，否则吊主提案(520)一出来
// 两边都领主牌，副牌之间的差别就被盖掉了 —— 这是这一整轮里踩了三次的坑。
const OPPONENT_LED_SPADES = [
  { trickNo: 1, leadSeat: 1, leadSuit: 'S', winnerSeat: 1, points: 0, plays: [] },
  { trickNo: 2, leadSeat: 3, leadSuit: 'S', winnerSeat: 3, points: 0, plays: [] },
];

// 双大鬼 + 9 张主 → control.guaranteed → 策略 run-side，且吊主提案本来就被关掉
const RUN_SIDE_HAND = [
  T('JOKER', 16, 0), T('JOKER', 16, 1),
  ...[13, 12, 11, 10, 9, 8, 7].map((r, i) => T('H', r, i + 2)),
  ...[9, 6].map((r, i) => T('S', r, i + 40)),                    // 黑桃 2 张
  ...[10, 8, 7, 5, 4].map((r, i) => T('D', r, i + 50)),          // 方块 5 张 = 最长副牌
];

test('策略领牌：以跑副牌为主 → 领自己最长的副牌，而不是去打对手的门', () => {
  const view = leadView({
    hand: RUN_SIDE_HAND, declarerSeat: 0, mySeat: 0, trickHistory: OPPONENT_LED_SPADES,
  });
  assert.equal(roundStrategy(view, S_CTX), 'run-side', '前提：策略确实是跑副牌');
  assert.equal(chooseLeadCards(view)[0].suit, 'D', '跑副牌就该走自己最长的那门');
});

// 成对：同一批已出牌、同一个对手威胁门，只把手牌换成「保底无望」→ 策略变吃分为主。
// 这时该反过来打对手的黑桃（Glen：「核心是打别人不想自己打的牌」）。
test('策略领牌：吃分为主 → 反过来打对手一直在领的那门', () => {
  const view = leadView({
    hand: [
      ...[7, 5, 3].map((r, i) => T('H', r, i)),                  // 3 张小主，顶牌没有、主也不长
      ...[9, 6].map((r, i) => T('S', r, i + 40)),
      ...[10, 8, 7, 5, 4].map((r, i) => T('D', r, i + 50)),
    ],
    declarerSeat: 0, mySeat: 0, trickHistory: OPPONENT_LED_SPADES,
  });
  assert.equal(roundStrategy(view, S_CTX), 'points-first', '前提：策略确实是吃分为主');
  assert.equal(chooseLeadCards(view)[0].suit, 'S', '打别人不想自己打的牌');
});

// ============ 甩尾手（长期计划打法）============
//
// Glen：「计划起手然后甩一手长的副牌达到保底或是撬底的目的。这样的打法一般
// 需要有起手牌，比如说有个大鬼，打完大鬼就可以甩尾手，或是用主牌去毙。」
// 又：「对手要是主牌不够长，有多少个鬼都不能保底」——
// 甩 N 张副牌得有 N 张主才毙得住，这是对「靠鬼保底」的正面反制。
//
// 计划三条件：能甩的长副牌 + 起手牌（握住最高未出主）+ 现在甩还毙得住 → 先别甩。

// 黑桃四件全部已现 → canThrowByStatus 成立
const SPADES_THROWABLE = {
  S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'seen' },
      { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
  D: [], C: [],
};

// 双大鬼 = 握住顶档（起手牌）；黑桃 5 张 = 尾巴
function tailView({
  playedTrumps = [], spades = [11, 9, 7, 6, 4],
  extraTrumps = [12, 11, 10, 9, 8, 7], extraCards = [],
}) {
  const hand = [
    T('H', 16, 0), T('H', 16, 1),
    ...extraTrumps.map((r, i) => T('H', r, i + 2)),
    ...extraCards,
    ...spades.map((r, i) => T('S', r, i + 40)),
  ];
  return leadView({
    hand, declarerSeat: 1, mySeat: 0, piecesView: SPADES_THROWABLE,
    trickHistory: [{
      trickNo: 1, leadSeat: 1, leadSuit: 'TRUMP', winnerSeat: 1, points: 0,
      plays: [{ seat: 1, playSuit: 'TRUMP', cards: playedTrumps }],
    }],
  });
}

test('甩尾手：能甩但对手主牌还够毙 → 压住不甩，先去吊主削他的主', () => {
  const lead = chooseLeadCards(tailView({}))[0];
  assert.notEqual(lead.suit, 'S', '现在甩会被毙掉，该留到尾巴上');
  assert.equal(lead.suit, 'H', '这时候该吊主，把对手的主牌削下去');
});

test('甩尾手：对手主牌已经不够毙 → 整门甩出去', () => {
  // 让大量主牌已经打出，outstandingTrumpCount 降到甩牌张数以下
  const played = [];
  for (let r = 3; r <= 14; r += 1) { played.push(T('H', r, 500 + r), T('H', r, 600 + r)); }
  played.push(T('H', 15, 700), T('H', 15, 701), T('S', 2, 702), T('D', 2, 703), T('C', 2, 704), T('H', 2, 705), T('H', 2, 706));
  const view = tailView({ playedTrumps: played, extraTrumps: [] });
  const cards = chooseLeadCards(view);
  assert.equal(cards.length, 5, '整门 5 张一次甩出去');
  assert.ok(cards.every(c => c.suit === 'S'), '甩的是黑桃');
});

// 判据是「某一家最多可能有几张主」，不是场上主牌总数 ——
// 甩 5 张只有单独一家同时握着 5 张主才毙得住整手。
// 尾盘各家手牌变短，这个估计自然就掉下去了。
test('甩尾手：尾盘对手手牌很短 → 摊到他头上的主牌不够毙，可以甩了', () => {
  const view = tailView({});
  for (const p of view.players) if (p.seat !== 0) p.handCount = 3; // 对手只剩 3 张
  view.round.kittyCount = 8;
  const cards = chooseLeadCards(view);
  assert.equal(cards.length, 5, '对手手上凑不出 5 张主，整门甩出去');
  assert.ok(cards.every(c => c.suit === 'S'));
});

test('甩尾手：同样的牌，对手手牌还很长 → 摊到他头上的主可能够毙，先不甩', () => {
  const view = tailView({});
  for (const p of view.players) if (p.seat !== 0) p.handCount = 20;
  const lead = chooseLeadCards(view);
  assert.notEqual(lead.suit, 'S', '对手手牌还长，现在甩有被整手毙掉的风险');
});

// ⚠️ 这条第一版给手里留了一张 ♦3，于是不管有没有护尾逻辑，电脑都会顺手垫掉
// 那张孤张方块 —— 被测的分支根本没参与决策，变异测试直接把它戳穿了。
// 现在手里【只有主牌和尾巴】：要么垫一张低主（keepValue 高），要么拆尾巴，
// 只有护尾的那 -90 才能把天平压向低主。
test('甩尾手：计划挂起时宁可垫低主也不拆长门（垫一张就少甩一张）', () => {
  const view = followView({
    seat: 0, declarerSeat: 1,
    hand: [
      T('H', 16, 0), T('H', 16, 1),
      ...[6, 5, 4].map((r, i) => T('H', r, i + 2)),      // 几张低主
      ...[11, 9, 7, 6, 4].map((r, i) => T('S', r, i + 40)), // 尾巴：5 张可甩的黑桃
      T('D', 11, 60), T('D', 9, 61),                     // 一门中性备选（无分、非件、不会造缺门）
    ],
    // ⚠️ 这个 fixture 前后错了两次，都是「被测分支根本没参与决策」：
    //   第一版留了一张孤张 ♦3 —— 不管护不护尾都会先垫它；
    //   第二版让对手领牌 —— 电脑直接用主牌毙下这一墩，压根没走到垫牌。
    // 现在：【队友已稳赢这一墩且桌上无分】，我是最后一家，毙队友要挨 -260，
    // 于是选择纯粹变成「拆尾巴（♠4，最便宜）vs 垫中性副牌（♦9）」，
    // 只有护尾的那 -90 能把天平从 ♠4 扳到 ♦9。
    currentTrick: [
      { seat: 3, playSuit: 'C', cards: [T('C', 8, 95)] },   // 对手领梅花
      { seat: 2, cards: [T('C', 14, 96)] },                 // 队友 ♣A 稳赢
      { seat: 1, cards: [T('C', 3, 97)] },                  // 另一个对手垫小的
    ],
    piecesView: SPADES_THROWABLE,
  });
  const played = chooseFollowCards(view);
  assert.ok(
    played.every(c => c.suit !== 'S'),
    `不该拆黑桃（尾巴的一部分），实际垫了 ${played.map(c => c.suit + c.rank).join(',')}`
  );
  assert.equal(played[0].suit, 'D', '该垫的是那门中性副牌');
});

// ---- 计划成立的两个前置条件 ----
//
// 观察点都放在【吊主的开关】上：计划挂起（planPending）会让电脑
// 即使副牌够强也继续吊主（削对手的主，尾巴才毙不住）。
// 所以「本不该成立的计划」会表现为「本该转副牌却去吊主」。
//
// 这两条都要求 holdsTopTrump 成立（双大鬼）但主牌不足 9 张，
// 否则 control.guaranteed 会整块跳过吊主逻辑。
function planPrereqView({ spades, piecesView }) {
  return leadView({
    hand: [
      T('H', 16, 0), T('H', 16, 1),                     // 双大鬼 → 握住顶档
      ...[6, 5].map((r, i) => T('H', r, i + 2)),        // 主牌只有 4 张 → 不够保底
      ...spades.map((r, i) => T('S', r, i + 40)),
    ],
    declarerSeat: 0, mySeat: 0, piecesView,
    // 显式给 pieceProbeMinLength: 6（进化权重就是 6）。不这么写的话 5 张的黑桃
    // 会同时触发 seek-piece(450)，叠上 develop-long-side-suit(160) 凑成 610，
    // 本来就压过吊主的 560 —— 观察点会被这条旁路盖掉，测不出计划成没成立。
    botTuning: { pieceProbeMinLength: 6 },
    trickHistory: [{ trickNo: 1, leadSeat: 1, leadSuit: 'C', winnerSeat: 1, points: 0, plays: [] }],
  });
}

test('甩尾手：甩牌资格还没成立的长门不算计划（不能凭「够长」就开始布局）', () => {
  const lead = chooseLeadCards(planPrereqView({
    spades: [14, 13, 9, 7, 5],
    piecesView: {
      // 我握着两件，另两件还在别人手上 → canThrowByStatus 不成立，甩不了
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      D: [], C: [],
    },
  }))[0];
  assert.notEqual(
    lead.suit, 'H',
    '这门根本甩不了，不构成尾巴计划；副牌又够强，应当转副牌而不是继续吊主'
  );
});

test('甩尾手：只有两张的门不算尾巴（甩两张没意义）', () => {
  const lead = chooseLeadCards(planPrereqView({
    spades: [11, 9],           // 只有两张，且四件都已现（能甩）
    piecesView: { ...SPADES_THROWABLE },
  }))[0];
  assert.notEqual(lead.suit, 'H', '两张不构成尾巴计划，不该为它去吊主');
});

// ---- 时机判据只看【对手】，队友的主牌不会来毙我 ----
test('甩尾手：估算能不能被毙时不算队友的主牌', () => {
  const view = tailView({});
  // 两个对手手牌都很短，队友手牌很长 —— 算错边就会把队友的主当成威胁
  for (const p of view.players) {
    if (p.seat === 0) continue;
    p.handCount = p.seat % 2 === 0 ? 20 : 2;   // 座位 2 = 队友(20)，座位 1/3 = 对手(2)
  }
  view.round.kittyCount = 8;
  const cards = chooseLeadCards(view);
  assert.equal(cards.length, 5, '对手手上凑不出 5 张主，尾巴可以甩了');
  assert.ok(cards.every(c => c.suit === 'S'));
});

// 时机一到，甩尾手要压过其它一切领牌意图。
// 620 分的普通甩牌已经能压过吊主(520)、回队友门(400)、发展长门(160)，
// 所以要验证「抬到 1100」有没有意义，必须造一个【分数在 620 和 1100 之间】的
// 竞争者出来 —— 这里用 continue-contributed-piece（700）：
// 队友求件、我贡献了 ♦K 拿到牌权、手里还剩 ♦A，按约定该续打这张 ♦A。
// ⚠️ 必须让手里剩的是 ♦A 而不是 ♦K：♦K 自带 10 分，早盘的送分惩罚（-80）
// 会把它从 700 压到 620 以下，竞争者就不成立了，变异体照样活着。
// ♦A 是 0 分的件，才真正卡在 620 和 1100 之间。
// 但尾巴已经到时机了，整门甩出去才是这一整个计划的兑现，不该被这条局部约定拦下。
test('甩尾手：时机一到，压过「续打贡献件」这类高分约定', () => {
  const view = leadView({
    hand: [
      T('H', 16, 0), T('H', 16, 1),                          // 双大鬼 → 起手牌
      ...[6, 5].map((r, i) => T('H', r, i + 2)),
      ...[11, 9, 7, 6, 4].map((r, i) => T('S', r, i + 40)),  // 尾巴：5 张可甩的黑桃
      T('D', 14, 60),                                        // 手里还剩的那张 ♦A（0 分）
    ],
    declarerSeat: 1, mySeat: 0,
    piecesView: {
      ...SPADES_THROWABLE,
      D: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'unseen' }],
    },
    trickHistory: [{
      trickNo: 1, leadSeat: 2, leadSuit: 'D', winnerSeat: 0, points: 0,
      plays: [
        { seat: 2, playSuit: 'D', cards: [T('D', 3, 90)] },  // 队友打小牌求件
        { seat: 0, cards: [T('D', 13, 91)] },                // 我贡献 ♦K 并拿下
      ],
    }],
  });
  // 对手手牌很短 → 摊到他头上的主凑不出 5 张，尾巴时机已到
  for (const p of view.players) if (p.seat !== 0) p.handCount = p.seat % 2 === 0 ? 12 : 2;

  const cards = chooseLeadCards(view);
  assert.equal(cards.length, 5, `时机已到就该整门甩出去，实际出了 ${cards.map(c => c.suit + c.rank).join(',')}`);
  assert.ok(cards.every(c => c.suit === 'S'));
});

// ============ 优势牌不能一开局就打光（Glen 实战反馈）============
//
// 「BOT 一开局就打小鬼，然后 BOT 对家马上还回了大鬼 —— 一般这是优势牌，
//   都会留到中后期。」
//
// 两个独立的 bug：
//   1. drawingTrumpCard 写的是 highCards(trumps, 1)，永远挑最高的那张 = 鬼，
//      注释却是「吊 2 / 吊鬼」—— 根本轮不到 2。
//   2. 盖过【已经领先的队友】只罚 15 分，而 isKill 那条 -260 只在
//      「副牌墩用主牌毙」时成立（要求 lead.playSuit !== 'TRUMP'）。
//      首家领的是主牌时 isKill 恒为 false，于是「队友领小鬼、我盖大鬼」
//      总共只要 15 分代价，而大鬼的 keepValue 是 180 —— 等于没有代价。

// 「明确需要」= 我有一门副牌要甩、而对手可能毙得动它，必须先把他的主削掉
//（Glen 举的正是这个例子）。这个状态就是 tailThrowPlan 挂起。
// 只有这时候才吊大牌 —— 而且吊级牌那一档，鬼始终留着。
test('吊主：确有理由（甩尾手计划挂起）时才吊大牌，且仍不拿鬼去吊', () => {
  const lead = chooseLeadCards(tailView({}))[0];
  assert.equal(lead.suit, 'H', '计划挂起时该去削对手的主');
  assert.notEqual(lead.rank, 16, '大鬼是保底/撬底的本钱，任何时候都不拿去吊');
  assert.notEqual(lead.rank, 15, '小鬼同理');
  assert.equal(lead.rank, 12, '吊自己最大的那张普通主牌（这手里没有级牌）');
});

// Glen 又收窄了一档：「即使要吊主，也不应该一开始出最大的牌吊，通常都是打副7，
// 主7以上一般拿来杀的。」打 7 时的阶梯是 大鬼 > 小鬼 > 主7 > 副7 > 主花色 A…，
// 副级牌是级牌里最便宜的一档 —— 够大、逼得出对手的主，又不是毙牌的本钱。
// 原来这里挑的是「除鬼以外最大的一张」，恰好就是主级牌。
test('吊主：该吊大牌时吊【副级牌】那一档，主级牌留着杀', () => {
  const lead = chooseLeadCards(tailView({
    extraTrumps: [12, 11, 10, 9],
    extraCards: [T('H', 2, 30), T('S', 2, 31)],  // 主级牌 ♥2 / 副级牌 ♠2（打 2）
  }))[0];
  assert.equal(lead.rank, 2, `该吊级牌那一档，实际吊了 ${lead.suit}${lead.rank}`);
  assert.equal(lead.suit, 'S', '吊的是副级牌；主级牌（♥2）以上都留着毙');
});

// Glen：「用两个鬼来吊」—— 手上当主牌用的只剩两个鬼时，领它们不是吊主，
// 是把毙牌的本钱扔掉。这时候干脆别提吊主，走副牌。
test('吊主：手上只剩鬼当主牌 → 不再吊主，转副牌', () => {
  const lead = chooseLeadCards(leadView({
    hand: [
      T('H', 16, 0), T('H', 15, 1),                     // 主牌只剩大鬼 + 小鬼
      ...[9, 7, 5].map((r, i) => T('S', r, i + 20)),
      ...[8, 6, 4].map((r, i) => T('D', r, i + 30)),
    ],
    declarerSeat: 0, mySeat: 0, trickHistory: PLAYED_SOMETHING,
  }))[0];
  assert.ok(lead.rank !== 16 && lead.rank !== 15,
    `不该拿鬼去吊，实际领了 ${lead.suit}${lead.rank}`);
});

// ---- 清顶：对手主牌见底时，反过来该用大牌一次清完（Glen 纠正上一版的绝对化）----
//
// 「这个结论也太绝对，潮汕升级的玩法就是随时都需要看当时形势来定要出的牌，
//   如果当时判断对手的主已经很少、很可能把大牌撞出来的时候，
//   那这情况就可以吊大鬼小鬼主2。」
//
// ⚠️「很可能把大牌撞出来」第一版译成了「顶端只剩一两张没现身」，是错的 ——
// 领大鬼逼不出对手的大鬼：他手里只要还剩一张小主，跟一张小的就躲过去了。
// 真正的条件是【外面剩的主牌基本全是大牌】，他没有小主可垫，只能拿大牌来跟。
// 400 局配对实测把错的那版抓了出来（保底 283 → 269，翻转 2 好 16 坏）。

// 造「场上主牌只剩 outside 这几张没现身」的局面：已出 = 全部主牌 − 我的 − outside。
// 比手写已出牌可靠得多 —— 手写过一版，漏算了副级牌，判据全都对不上。
function trumpsPlayedExcept(mine, outside) {
  const drop = [...mine, ...outside];
  const played = [];
  for (const card of buildDeck().filter(c => playSuitOf(c, 'H', 2) === 'TRUMP')) {
    // 鬼只按点数配对（fixture 里写成 JOKER，牌堆里也是 JOKER）
    const i = drop.findIndex(d => d.rank === card.rank && (d.rank >= 15 || d.suit === card.suit));
    if (i >= 0) { drop.splice(i, 1); continue; }
    played.push(card);
  }
  return played;
}

const CLEARING_SIDES = [
  ...[9, 7].map((r, i) => T('S', r, i + 20)),
  ...[8, 6].map((r, i) => T('D', r, i + 30)),
];

// ⚠️ fixture 说明：已出的主牌一股脑塞进首墩「我自己」那一手，纯粹是喂给
// playedCardsOf；牌桌上不会这样出牌，但这几条断言只依赖「哪些牌已现身」。
function clearingView({ trumps, outside }) {
  const hand = [...trumps, ...CLEARING_SIDES];
  const view = leadView({
    hand, declarerSeat: 0, mySeat: 0,
    trickHistory: [{
      trickNo: 1, leadSeat: 0, leadSuit: 'TRUMP', winnerSeat: 0, points: 0,
      plays: [{ seat: 0, playSuit: 'TRUMP', cards: trumpsPlayedExcept(trumps, outside) }],
    }],
  });
  for (const p of view.players) p.handCount = 4;   // 尾盘，各家手牌都短
  return view;
}

const LOW_TRUMPS = [T('H', 6, 10), T('H', 5, 11)];

test('清顶：外面只剩一张大鬼、没有小主可垫 → 领大鬼把它撞出来', () => {
  const lead = chooseLeadCards(clearingView({
    trumps: [T('JOKER', 16, 0), T('JOKER', 15, 1), ...LOW_TRUMPS],
    outside: [T('JOKER', 16, 700)],
  }))[0];
  assert.equal(lead.rank, 16, `形势到了就该领大鬼，实际领了 ${lead.suit}${lead.rank}`);
});

// 对照一：顶端一样只剩一张大鬼，但外面还有 4 张小主 —— 他跟一张小的就躲过去了，
// 我这张大鬼白花。这条钉住的正是我第一版译错的地方。
test('清顶：外面还有小主可以垫 → 撞不出来，不动鬼', () => {
  const lead = chooseLeadCards(clearingView({
    trumps: [T('JOKER', 16, 0), T('JOKER', 15, 1), ...LOW_TRUMPS],
    outside: [T('JOKER', 16, 700), T('H', 4, 701), T('H', 3, 702),
      T('H', 8, 703), T('H', 9, 704)],
  }))[0];
  assert.ok(lead.rank !== 16 && lead.rank !== 15,
    `他有小主可垫，撞不出大牌，实际领了 ${lead.suit}${lead.rank}`);
});

// 对照二：外面一张小主都没有，但顶端还压着三张（两张大鬼 + 一张小鬼）——
// 撞得动一张，撞不干净，我的小鬼出去只是送掉。
test('清顶：顶端还剩三张压着 → 撞不干净，不动鬼', () => {
  const lead = chooseLeadCards(clearingView({
    trumps: [T('JOKER', 15, 1), ...LOW_TRUMPS],
    outside: [T('JOKER', 16, 700), T('JOKER', 16, 701), T('JOKER', 15, 702)],
  }))[0];
  assert.ok(lead.rank !== 16 && lead.rank !== 15,
    `顶上还压着三张，实际领了 ${lead.suit}${lead.rank}`);
});

// 对照三：顶端已经空了（我手上的大鬼就是场上最大），没有大牌可撞，
// 犯不着把它领出去 —— 想赢哪一墩随时都能赢。
test('清顶：顶端已经空了 → 没什么可撞，不动鬼', () => {
  const lead = chooseLeadCards(clearingView({
    trumps: [T('JOKER', 16, 0), T('JOKER', 15, 1), ...LOW_TRUMPS],
    outside: [T('H', 4, 701)],
  }))[0];
  assert.ok(lead.rank !== 16 && lead.rank !== 15,
    `顶端已空，领鬼没有意义，实际领了 ${lead.suit}${lead.rank}`);
});

// 连吊「先大后小」：大鬼打出去之后重新评估，次大的那张就是新的最大张。
test('清顶：大鬼都已现身 → 接着领小鬼把顶端清完（先大后小）', () => {
  const lead = chooseLeadCards(clearingView({
    trumps: [T('JOKER', 15, 1), ...LOW_TRUMPS],
    outside: [T('JOKER', 15, 702)],
  }))[0];
  assert.equal(lead.rank, 15, `该接着把顶端清完，实际领了 ${lead.suit}${lead.rank}`);
});

test('吊主：开局第一墩也不许领鬼', () => {
  const hand = [
    T('H', 16, 0), T('H', 15, 1),
    T('H', 2, 2), T('S', 2, 3),
    ...[14, 13, 12, 11, 10].map((r, i) => T('H', r, i + 5)),
    ...[9, 7].map((r, i) => T('S', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 0, mySeat: 0, trickHistory: [],  // 开局首墩
  }))[0];
  assert.ok(lead.suit !== 'JOKER' && lead.rank !== 16 && lead.rank !== 15,
    `开局不该领鬼，实际领了 ${lead.suit}${lead.rank}`);
});

// ---- 毙牌只要「一张够大的 + 凑张数的」（Glen 实战反馈）----
//
// 「用主牌毙别人两张的甩牌时，用了两只大鬼去毙，这个不对，看的只是最大那支，
//   一支大鬼还有一支小牌即可……当时他的主牌还很多，这个操作导致后来保不了底。」
//
// 判牌确实只比【最大的那一张】（server/trick.js 的 trickLeader → maxStrength）。
// 根子不在排序，在【候选生成】：selections 只给三种形状 —— 全小 / 全大 / 全分。
// 一旦「全小」赢不下来，「全大」就成了唯一能赢的选项。
const KILL_CTX = { trumpSuit: 'H', rankCard: 2 };

// 中后段（手牌 8 张，early 的门槛是 > 8）：对手甩两张黑桃 20 分，
// 另一个对手已经用 ♥K 毙下（再添 10 分），轮到我，黑桃已断。
// ⚠️ 逆时针 0 → 3 → 2 → 1：座位 1 领牌时顺序是 1 → 0 → 3 → 2，我（座位 2）最后出。
// 座位 0 是我队友，座位 1/3 是对手 —— 必须让【对手】领先，否则走的是「别杀队友」那条路。
const killTrick = () => [
  { seat: 1, playSuit: 'S', cards: [T('S', 13, 90), T('S', 10, 91)] },
  { seat: 0, cards: [T('C', 4, 92), T('C', 3, 93)] },
  { seat: 3, cards: [T('H', 13, 94), T('H', 11, 95)] },
];

test('毙牌：一张够大的配一张最小的主，绝不把两只大鬼一起交出去', () => {
  const trick = killTrick();
  const played = chooseFollowCards(followView({
    hand: [
      T('JOKER', 16, 0), T('JOKER', 16, 1), T('JOKER', 15, 2),
      ...[14, 13, 4, 3].map((r, i) => T('H', r, i + 10)),
      T('D', 7, 30),
    ],
    currentTrick: trick, seat: 2, declarerSeat: 0,
  }));
  assert.equal(trickLeader([...trick, { seat: 2, cards: played }], KILL_CTX).seat, 2,
    '桌上 30 分，这一墩该拿下来');
  assert.equal(played.filter(c => c.rank === 16).length, 0,
    `不该动大鬼，实际出了 ${played.map(c => c.suit + c.rank).join(',')}`);
  assert.ok(played.some(c => c.suit === 'H' && c.rank === 14), '♥A 就够大了');
});

// ---- 省不下来的时候，砍不砍要看总账（Glen 给的判据）----
//
// 「就简单那个例子，两个大鬼，别人那边还有小鬼，肯定两个都砍下去就保不了底了；
//   送的分要看是送多少……如果送出去的分还有已经吃的分加起来还不到 80，
//   那就判断如果不吃大，把小牌跑掉，大牌后边可以把分都跑了然后保底，
//   肯定收益要比这轮把别人砍了更加多。」
//
// ⚠️ 这两条测试里的 fixture 是同一个，只差【闲家已经吃了多少分】——
// 这正是判据本身，所以必须成对出现，单看任何一条都钉不住。
const ONLY_TWO_BIG_JOKERS = [
  T('JOKER', 16, 0), T('JOKER', 16, 1),          // 当主牌用的只有这两只
  ...[9, 7, 5].map((r, i) => T('D', r, i + 30)),
];

test('毙牌：砍下去就保不了底、而闲家离 80 还远 → 放走这一墩，大牌留着', () => {
  const trick = killTrick();
  const played = chooseFollowCards(followView({
    hand: ONLY_TWO_BIG_JOKERS, currentTrick: trick, seat: 2, declarerSeat: 0,
    defenderTrickPoints: 0,   // 让掉之后闲家才 30 分，离移庄线还远
  }));
  assert.notEqual(trickLeader([...trick, { seat: 2, cards: played }], KILL_CTX).seat, 2,
    `两只大鬼一起交出去就保不了底，这 30 分该放，实际出了 ${played.map(c => c.suit + c.rank).join(',')}`);
  assert.equal(played.filter(c => c.rank === 16).length, 0, '放走就该垫小牌，别把鬼搭进去');
});

// ⚠️ 这条断言是我自己先写错、再按 Glen 的判据改过来的：
// 原来写的是「没有更省的打法时，30 分该用两只大鬼毙回来」——
// 那正是他说的「见牌就砍」。真正决定砍不砍的是【让掉之后闲家到不到 80】。
test('毙牌：同一手牌，但闲家已有 60 分 → 让掉就到 90 过线，必须砍', () => {
  const trick = killTrick();
  const played = chooseFollowCards(followView({
    hand: ONLY_TWO_BIG_JOKERS, currentTrick: trick, seat: 2, declarerSeat: 0,
    defenderTrickPoints: 60,  // 60 + 桌上 30 = 90 ≥ 80，放走就直接移庄
  }));
  assert.equal(trickLeader([...trick, { seat: 2, cards: played }], KILL_CTX).seat, 2,
    '再不砍就到移庄线了，保底也没意义');
});

// ---- 闲家是【同一本账】，不是另一本（Glen 纠正）----
//
// 「闲家一个道理，这一墩杀下去，有可能本来的撬底牌就没有了……
//   如果杀下去超过 80 分爆底，那么也无所谓撬不撬底了；
//   如果杀下去分可能不够，那肯定不如留到最后撬底。」
//
// ⚠️ 我第一版写成「只对庄家成立、闲家照砍」，被这段话推翻了。
// 被罚的动作两边同一个（拿顶主去毙），衡量的数也同一个：闲家台面分 + 这墩的分。
// 差别只在理由叫「保底」还是「撬底」。
test('毙牌：闲家杀下去也到不了 80 → 撬底牌留着，别为这一墩花掉', () => {
  const trick = killTrick();
  const played = chooseFollowCards(followView({
    hand: ONLY_TWO_BIG_JOKERS, currentTrick: trick, seat: 2, declarerSeat: 1,
    defenderTrickPoints: 0,   // 杀下去也才 30 分，离 80 还远
  }));
  assert.notEqual(trickLeader([...trick, { seat: 2, cards: played }], KILL_CTX).seat, 2,
    `杀完还不够 80，不如留着撬底，实际出了 ${played.map(c => c.suit + c.rank).join(',')}`);
});

test('毙牌：闲家杀下去就到 90 爆底 → 撬不撬底无所谓了，照杀', () => {
  const trick = killTrick();
  const played = chooseFollowCards(followView({
    hand: ONLY_TWO_BIG_JOKERS, currentTrick: trick, seat: 2, declarerSeat: 1,
    defenderTrickPoints: 60,  // 60 + 30 = 90 ≥ 80，已经移庄
  }));
  assert.equal(trickLeader([...trick, { seat: 2, cards: played }], KILL_CTX).seat, 2,
    '这一墩就把 80 拿下了，撬底的边际收益已经不重要');
});

// 同门跟多张也是一样的道理：赢只看最大那张，第二张该垫最小的。
// 这个 fixture 里【没有】鬼参与，钉的纯粹是「刚好够赢」这条本身。
test('跟牌：同门跟两张也是「刚好够赢 + 垫最小」，不搭上第二张大牌', () => {
  const trick = [{ seat: 1, playSuit: 'S', cards: [T('S', 13, 90), T('S', 10, 91)] }];
  const played = chooseFollowCards(followView({
    hand: [
      ...[14, 12, 4, 3].map((r, i) => T('S', r, i + 40)),
      ...[9, 7].map((r, i) => T('H', r, i + 10)),
    ],
    currentTrick: trick, seat: 2, declarerSeat: 0,
  }));
  assert.equal(trickLeader([...trick, { seat: 2, cards: played }], KILL_CTX).seat, 2,
    '♠A 能赢这 20 分');
  assert.ok(played.some(c => c.rank === 14), '要赢就得出 ♠A');
  assert.ok(played.every(c => c.rank !== 12),
    `第二张该垫最小的，实际出了 ${played.map(c => c.suit + c.rank).join(',')}`);
});

// 队友领主牌领先了，我手里有大鬼 —— 桌上一分没有，盖上去纯属浪费
test('跟牌：队友已领先且桌上无分 → 绝不拿大鬼盖过他', () => {
  const cards = chooseFollowCards(followView({
    seat: 2, declarerSeat: 1,
    hand: [T('H', 16, 0), T('H', 9, 1), T('H', 7, 2), T('H', 4, 3),
      ...[9, 7, 5].map((r, i) => T('S', r, i + 20))],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [T('H', 15, 90)] },  // 队友领小鬼，已经领先
      { seat: 3, cards: [T('H', 5, 91)] },                       // 对手跟了张小主
    ],
  }));
  assert.notEqual(cards[0].rank, 16, '这一墩本来就是我们的，一分没有，大鬼留着');
});

// ⚠️ 这条不能断言「有分就一定用大鬼抢下来」—— 为 10 分烧掉大鬼本来就不划算，
// 跟一张小主、信任队友是合理打法。第一版这么断言纯属我想当然。
// 真正要钉住的是【惩罚力度有区别】：一分没有时盖队友是纯浪费（重罚），
// 桌上有分、后面还有对手时可能是在护分（轻罚）。所以直接比评分。
test('跟牌：桌上有分时，盖过队友的惩罚明显轻于一分没有时', () => {
  const scoreOfBigJoker = partnerCard =>
    evaluateFollowChoices(followView({
      seat: 2, declarerSeat: 1,
      hand: [T('H', 16, 0), T('H', 4, 1), ...[9, 7, 5].map((r, i) => T('S', r, i + 20))],
      currentTrick: [
        { seat: 1, playSuit: 'TRUMP', cards: [T('H', 6, 90)] },  // 对手领
        { seat: 0, cards: [partnerCard] },                        // 队友领先
      ],
    })).find(c => c.cards[0].rank === 16).score;

  const withPoints = scoreOfBigJoker(T('H', 13, 91));  // 主K = 10 分
  const noPoints = scoreOfBigJoker(T('H', 9, 91));     // 主9 = 0 分
  assert.ok(
    withPoints > noPoints + 100,
    `有分时该明显更愿意抢：有分 ${withPoints.toFixed(0)} vs 无分 ${noPoints.toFixed(0)}`
  );
});

// ---- 跟牌时也不许早早把鬼交出去（Glen 第二次实战反馈）----
//
// 「又有一局 BOT 第一张打了小鬼，完全没意义。」
// 查下来根本不是领出 —— 是【庄家开局吊主、后面几家拿鬼去压】。
// 原来两条保护都盖不住：
//   · spentLastBigJoker 只认「最后一张大鬼」，小鬼一点保护都没有；
//   · isKill 的空毙惩罚要求 lead.playSuit !== 'TRUMP'，
//     而首家领主牌时 isKill 恒为 false —— 代价为零。
// 实测 40 局里前两墩打鬼 11 次，全部是跟主牌墩。

// ⚠️ bot 必须坐【最后一家】：实测出问题的 11 次全是第 4 手 ——
// 抢牌权的加分在最后一家最大（lastToAct 额外 +45、分值 ×10），
// 坐第 3 手时鬼本来就不会被选中，被测的惩罚项根本没参与决策。
// 出牌顺序从座位 0 逆时针：0 → 3 → 2 → 1，所以最后一家是座位 1。
// ⚠️ 这个 fixture 前后错了两次，都是「被测分支根本没参与决策」：
//   1. bot 坐第 3 手 —— 抢牌权的加分在【最后一家】才最大（lastToAct 额外 +45、
//      分值 ×10），坐第 3 手时鬼本来就不会被选中；
//   2. bot 手里留了 H9 —— 它本来就能赢下这一墩，压根用不上鬼，
//      于是鬼恒为负分，改什么系数结果都一样。
// 真正要测的局面是【只有鬼能赢】：首家领主 A，我手上除了鬼全是更小的主。
// 出牌顺序从座位 0 逆时针：0 → 3 → 2 → 1，最后一家是座位 1。
function trumpLeadFollowView({ points = 0, sideCards = 6 } = {}) {
  // ⚠️ 座位 1 的队友是座位 3、对手是座位 0 和 2。
  // 造局面时必须让【对手】领先 —— 队友领先时不抢是对的（上面那条「盖过队友」
  // 的惩罚），会把这条测试变成测别的东西。
  // 首家（座位 0，对手）领 ♥K 一直领先；队友座位 3 垫小的；对手座位 2 再加分。
  // 首家领【主 A】：0 分，但在主花色里只有鬼压得过（主级牌 ♥2 没人有）。
  // 这样桌面分完全由两个跟牌位决定，points 参数才名副其实。
  const fillers = {
    0: [[T('H', 3, 90)], [T('H', 4, 91)]],
    5: [[T('H', 5, 90)], [T('H', 4, 91)]],
    20: [[T('H', 13, 90)], [T('H', 10, 91)]],  // ♥K(10) + ♥10(10)
  }[points];
  const sides = [
    ...[9, 7, 5].map((r, i) => T('S', r, i + 20)),
    ...[8, 6, 4].map((r, i) => T('D', r, i + 30)),
  ].slice(0, sideCards);
  return followView({
    seat: 1, declarerSeat: 0,
    // 小鬼 + 三张小主：只有小鬼压得过首家的主 A
    hand: [...[15, 9, 7, 4].map((r, i) => T('H', r, i)), ...sides],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [T('H', 14, 80)] },  // 首家领主 A（0 分）
      { seat: 3, cards: fillers[0] },
      { seat: 2, cards: fillers[1] },
    ],
  });
}

test('跟主牌墩：开局桌上没分，不许拿小鬼去压', () => {
  const cards = chooseFollowCards(trumpLeadFollowView({ points: 0 }));
  assert.notEqual(cards[0].rank, 15, `一分没有，小鬼留着；实际出了 H${cards[0].rank}`);
});

test('跟主牌墩：只有 5 分也不值一张鬼', () => {
  const cards = chooseFollowCards(trumpLeadFollowView({ points: 5 }));
  assert.notEqual(cards[0].rank, 15, '开局那 5 分不值一张鬼');
});

// 反向保护：别矫枉过正到把鬼烂在手里 —— 分够多就该真的拿下。
// ⚠️ 只比「10 分 vs 0 分的评分差」是不够的：其它跟分数相关的加分照样存在，
// 就算惩罚完全不看桌面分，差值也还在（变异测试戳穿过一次）。
// 所以这里断言一个真实行为：25 分在桌上时它确实会把鬼打出来。
test('跟主牌墩：桌上 20 分时确实会用鬼拿下', () => {
  const cards = chooseFollowCards(trumpLeadFollowView({ points: 20 }));
  assert.equal(cards[0].rank, 15, `20 分值一张小鬼，实际出了 H${cards[0].rank}`);
});

// 惩罚里的 `- totalPoints * 8` 那一项没法靠「决策翻转」来钉：
// 分数越高，出鬼的优势涨得比罚额减免还快，删掉它决策也不变。
// 所以直接钉住【桌面分对出鬼意愿的影响幅度】：
//   0 分 → 20 分，小鬼的评分差实测约 500；
//   其中 totalPoints × 8 × controlReserve(1.25) = 200 来自这一项，
//   其余约 300 来自 afterTeamWinning / 抢牌权那些本来就跟分数挂钩的加分。
// 门槛取 400：删掉这一项只剩 ~300，会红；保留则 ~500，通过。
test('跟主牌墩：桌面分对「要不要出鬼」的影响必须足够大', () => {
  const scoreOf = points => evaluateFollowChoices(trumpLeadFollowView({ points }))
    .find(c => c.cards[0].rank === 15).score;
  const delta = scoreOf(20) - scoreOf(0);
  assert.ok(delta > 400, `0→20 分应当让出鬼的评分抬升 400 以上，实际 ${delta.toFixed(0)}`);
});

test('跟主牌墩：手里只剩鬼这一张主牌时照样得跟（规则要求，不是策略）', () => {
  const cards = chooseFollowCards(followView({
    seat: 2, declarerSeat: 0,
    hand: [T('H', 15, 0), ...[9, 7, 5].map((r, i) => T('S', r, i + 20))],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [T('H', 6, 80)] },
      { seat: 3, cards: [T('H', 8, 90)] },
    ],
  }));
  assert.equal(cards[0].rank, 15, '有主必须跟主，这时候没得选');
});

// 反向保护：尾盘（early = 手牌 > 8 不再成立）该出手就得出手，
// 不能因为这条早盘惩罚把鬼一直烂在手里。
test('跟主牌墩：尾盘不再受早盘惩罚约束', () => {
  const late = evaluateFollowChoices(trumpLeadFollowView({ points: 0, sideCards: 2 }))
    .find(c => c.cards[0].rank === 15).score;
  const early = evaluateFollowChoices(trumpLeadFollowView({ points: 0, sideCards: 6 }))
    .find(c => c.cards[0].rank === 15).score;
  assert.ok(late > early + 100,
    `尾盘出鬼不该再挨早盘那一刀：尾盘 ${late.toFixed(0)} vs 早盘 ${early.toFixed(0)}`);
});

// ---- 开局第一墩：先放小牌，把表态机会让给队友（Glen 第三次实战反馈）----
//
// 「第一轮庄家吊主 7 也是有问题的。第一轮还没打过牌，并不知道对家是否需要吊主。
//   吊主打大牌主要是为了控制主动权，是在非常明确需要吊主的时候才这么吊。
//   通常一开始会先放小牌，让对家有机会表示 —— 因为需不需要吊主这件事，
//   对接下来要怎么出牌非常有关系。对家一旦说明不用吊主，庄家极有可能打他的
//   强势副牌，甩牌的时候也不怕最后的底给别人撬了。」

test('开局：庄家没有大鬼时，第一墩吊最小的主牌', () => {
  const hand = [
    T('H', 2, 0), T('S', 2, 1),                       // 打 2 时这两张是级牌 = 大牌
    ...[14, 13, 11, 9, 6, 4, 3].map((r, i) => T('H', r, i + 2)),
    ...[9, 7, 5].map((r, i) => T('S', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 0, mySeat: 0, trickHistory: [],   // 第一墩
  }))[0];
  assert.equal(lead.suit, 'H', '庄家开局吊主');
  assert.equal(lead.rank, 3, `该放最小的主牌，实际出了 H${lead.rank}`);
  assert.ok(lead.rank !== 2, '级牌是大牌，第一墩不该吊出去（打 7 时它就是那张「7」）');
});

test('开局：庄家有大鬼但不够保底 → 仍走「带分吊主」那条约定，也不是大牌', () => {
  const hand = [
    T('H', 16, 0),                                    // 一张大鬼
    T('H', 2, 1),                                     // 级牌
    T('H', 10, 2), T('H', 13, 3),                     // 带分的主牌
    ...[12, 11, 9, 6, 4, 3].map((r, i) => T('H', r, i + 4)),
    ...[9, 7].map((r, i) => T('S', r, i + 20)),
  ];
  const lead = chooseLeadCards(leadView({
    hand, declarerSeat: 0, mySeat: 0, trickHistory: [],
  }))[0];
  assert.equal(lead.rank, 10, '带分吊主挑最小的那张带分主牌（♥10 < ♥K）');
  assert.notEqual(lead.rank, 2, '不是级牌');
  assert.notEqual(lead.rank, 16, '更不是大鬼');
});
