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

// ⚠️ piecesView 的默认值是【四支全未现】，不是空数组。真实 view 里每门副牌
// 一定列着 4 项（打 A / 打 K 时那一档升主，只剩 2 项），空数组是「这门没有件」，
// 两个意思差得远：canThrowByStatus 对空数组返回 false，而
// 「还有没有件没现身」对空数组也是 false —— 一个是「甩不了」，一个是「不用再逼了」。
// 以前默认给空数组，凡是不关心件的 fixture 都在悄悄告诉电脑「这门件已经逼完」。
const ALL_UNSEEN = () => [14, 14, 13, 13].map(rank => ({ rank, status: 'unseen' }));

function leadView({
  hand, declarerSeat = 0, mySeat = 0, trickHistory = [],
  piecesView = { S: ALL_UNSEEN(), D: ALL_UNSEEN(), C: ALL_UNSEEN() }, botTuning,
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
//
// ⚠️ 这条断言在 cc052ec 里被我【改坏过一次】：当时按 c6543a2 的跨墩记忆
// 改成了「接着帮他逼黑桃」。Glen 裁定作废那一版：
//   「队友吃大然后打其它牌，证明他有其它计划，正常不应该帮他再逼件，
//     他也有可能是暗求。」
// 改吊主就是最彻底的「打其它牌」。现在断言回到原样。
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
  trickHistory = [], defenderTrickPoints = 0, botTuning, rankCard = 2,
}) {
  return {
    phase: 'PLAYING', declarerSeat, botTuning,
    you: { seat, team: seat % 2, hand, crossRiver: {} },
    players: [0, 1, 2, 3].map(s2 => ({ seat: s2, team: s2 % 2, handCount: 12 })),
    round: {
      trumpSuit: 'H', rankCard, kittyCount: 8,
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

// ---- 「快断门」那条豁免要求这支件【换回了东西】（Glen 第 3 条）----
//
// Glen 的原话：「如果自己这门已经快断了，比如打 A 后再捅多一支或两支就断了，
// 可以毙别人，这个时候也可以吃。」落点在那个【吃】字：用这支件把墩拿下来，
// 换回牌权和分，断门之后还能用主牌毙，所以划算。
//
// ⚠️ 这条测试【改过一次】，而且是把断言【反过来】写的。我第一版把这条豁免
// 收紧成「只有真的把这一墩吃下来才算数」，于是「队友 ♠A 稳赢、我手上 ♠K ♠3」
// 时电脑跟 ♠3 留住 K。那是我按他的措辞推的，推错了 —— Glen 当场纠正：
//   「队友 A，自己如果只剩下 K 和 3，正常还是要把 K 给队友。」
// 10 分是实打实进自己家的，比留着那支件更实在。收紧的代码已经退掉，
// 这条测试留下来当界桩：谁再想收紧这条豁免，它会先红。
function nearVoidPieceView(mine = 13) {
  return followView({
    seat: 0, declarerSeat: 1,
    hand: [
      T('S', mine, 40), T('S', 3, 41),                    // 这门只剩两张：一支件 + ♠3
      ...[9, 8, 7, 6, 5].map((r, i) => T('H', r, i)),     // 5 张主
      ...[9, 6].map((r, i) => T('D', r, i + 50)),
    ],
    piecesView: {
      // 一支 ♠A 是队友刚打出来的那张（已现）；另一支件在我手上，其余未现
      S: [{ rank: 14, status: 'seen' },
          { rank: 14, status: mine === 14 ? 'mine' : 'unseen' },
          { rank: 13, status: mine === 13 ? 'mine' : 'unseen' },
          { rank: 13, status: 'unseen' }],
      D: [14, 14, 13, 13].map(rank => ({ rank, status: 'unseen' })),
      C: [14, 14, 13, 13].map(rank => ({ rank, status: 'unseen' })),
    },
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [T('S', 4, 90)] },   // 对手领 ♠4
      { seat: 2, cards: [T('S', 14, 91)] },                 // 队友 ♠A，我是最后一家，稳赢
                                                            // （同点数先出者大，我的件压不过他）
      { seat: 3, cards: [T('S', 6, 92)] },                  // 另一个对手垫小的
    ],
  });
}

// Glen 的原话：「队友 A，自己如果只剩下 K 和 3，正常还是要把 K 给队友。」
test('件不能乱出：队友已经稳赢这一墩 → 把 ♠K 的 10 分送过去', () => {
  const played = chooseFollowCards(nearVoidPieceView(13));
  assert.equal(played.length, 1);
  assert.equal(played[0].rank, 13,
    `队友稳赢，该把 ♠K 的 10 分送过去，实际打了 ♠${played[0].rank}`);
});


// ============ 第三手封门（Glen 第四次提）============
//
// 「第三家的出牌，在保证不乱出鬼、主 2 或是件的前提，还是要尽量吃大一些，
//   避免第四家容易吃分。比如前两家都是小于 10 的，第三家还是尽量吃 10 以上，
//   不然第四家就容易用 10 吃分。」
//
// ⚠️ 这段逻辑代码里【本来就有】，但够不着：partnerSideProtocolChoice 里
// 「朋友领的不是求件牌 → 出最便宜的无分牌」那条兜底把它整个截住了
//（朋友领 6/7/8/9/J/Q 全落进兜底）。实测 200 局：第三家「前两手都不到 10、
// 手上有非件的 J/Q」402 次，其中 204 次打了小牌，96 次第四家当场用 10 拿走。
function thirdHandView(spades) {
  return followView({
    seat: 2, declarerSeat: 0,
    hand: [
      ...spades.map((r, i) => T('S', r, i)),
      ...[9, 7].map((r, i) => T('H', r, i + 10)),
      ...[8, 6].map((r, i) => T('D', r, i + 20)),
    ],
    piecesView: {
      S: [{ rank: 14, status: spades.includes(14) ? 'mine' : 'unseen' },
          { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
    // ⚠️ 座位轮转是【逆时针】（server/rotation.js：0 → 3 → 2 → 1）。
    // 队友座 0 领牌 → 第二家是座 3 → 我（座 2）是第三家 → 最后一家是座 1。
    // 第一版把第二家写成座 1，那其实是最后一家，整个「第三手」的前提就不成立。
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [T('S', 6, 90)] },   // 队友领 ♠6（不是求件牌）
      { seat: 3, cards: [T('S', 9, 91)] },                  // 对手 ♠9 暂时领先
    ],
  });
}

test('第三手封门：前两家都不到 10 → 用非件的大牌压住，别让第四家用 10 收走', () => {
  const cards = chooseFollowCards(thirdHandView([14, 12, 11, 7]));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].rank, 12,
    `该用 ♠Q 封住（♠J 也行，但他说「尽量吃大」），实际打了 ♠${cards[0].rank}`);
});

// 前提的另一半：「在保证不乱出鬼、主 2 或是件的前提」。
// 同一个场面，手上唯一压得住的大牌是 ♠A（件）——那就宁可不封。
// ⚠️ 两条成对看：只有上面那条的话，「按强度降序挑第一个」会先把 ♠A 送出去
//（副 A 是 0 分，混在无分牌里排第一）。
test('第三手封门：唯一压得住的是件（♠A）→ 宁可不封，也不把件送出去', () => {
  const cards = chooseFollowCards(thirdHandView([14, 7, 6, 3]));
  assert.equal(cards.length, 1);
  assert.notEqual(cards[0].rank, 14,
    `封门不能拿件去封（Glen 的前提），实际打了 ♠${cards[0].rank}`);
});

// 另一条反向保护：最后一家【已知断门】—— 他要毙就毙，我压得再大也拦不住，
// 这时候封门纯粹是白扔一张大牌，该出最便宜的。
test('第三手封门：最后一家已知这门断了 → 封也没用，出最小的', () => {
  const view = thirdHandView([12, 11, 7]);
  // 上一墩领的就是黑桃，座 3（最后一家）没跟黑桃 → 公开信息已证明他断门
  view.round.trickHistory = [{
    trickNo: 1, leadSeat: 0, leadSuit: 'S', winnerSeat: 0, points: 0,
    plays: [
      { seat: 0, playSuit: 'S', cards: [T('S', 8, 70)] },
      { seat: 3, cards: [T('S', 5, 71)] },
      { seat: 2, cards: [T('S', 3, 72)] },
      { seat: 1, cards: [T('D', 4, 73)] },   // 最后一家（座 1）垫了方块 = 黑桃断了
    ],
  }];
  const cards = chooseFollowCards(view);
  assert.equal(cards[0].rank, 7,
    `他断门了，封门拦不住，别浪费大牌（实际打了 ♠${cards[0].rank}）`);
});

// 反向保护：朋友已经把这门封死了（他领 ♠A，没有更大的牌没现身），
// 这一墩本来就是我方的 —— 那就别浪费大牌，出最便宜的。
// 这正是原来那条兜底【真正想管】的情形，不能连它一起改掉。
test('第三手封门：朋友的 ♠A 已经封住这门 → 不浪费大牌，出最小的', () => {
  const view = followView({
    seat: 2, declarerSeat: 0,
    hand: [
      ...[12, 11, 7].map((r, i) => T('S', r, i)),
      ...[9, 7].map((r, i) => T('H', r, i + 10)),
      ...[8, 6].map((r, i) => T('D', r, i + 20)),
    ],
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'seen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [T('S', 14, 90)] },  // 队友 ♠A，这门已封死
      { seat: 3, cards: [T('S', 9, 91)] },
    ],
  });
  const cards = chooseFollowCards(view);
  assert.equal(cards[0].rank, 7, `这一墩已经是我方的，别浪费（实际打了 ♠${cards[0].rank}）`);
});

// ---- 垫件 vs 垫小主：默认垫件，两个例外（Glen）----
//
// 「副 A 和低主这个也要看是留 A 更有价值，因为副 A 有时候可以成为起手牌，
//   而小的主牌一般比较难；还有一种情况是此次是对手甩的牌，有可能出了 A 后，
//   他可以顺手再甩一次长的，这个也很危险，也是需要计算当前出的牌去判断可能性。
//   当然除了这两种情况，A 的价值并不比小的主牌要高，本身它就比主牌要小。」
//
// 默认（垫 A 不垫主）本来就成立：keepValue 里副 A 是 59、最低的主花色是 78。
// 这里做的是第二个例外 —— 对手正在甩牌时把件留住。
//
// ⚠️ 光靠罚分做不到：副 A 的 cardStrength 是 14、任何主牌都是 900+，
// lowCards 一旦挑到件就说明手上只剩主牌了，那时它是【唯一】候选，罚多少都一样。
// 所以 followCandidates 的垫牌位置多给了一手「宁可动主牌也不动件」。
function fillIntoThrowView(throwerSeat) {
  return followView({
    seat: 0, declarerSeat: 1,
    hand: [
      T('C', 3, 30),                                    // 梅花只有一张，必须打出去
      T('S', 14, 40), T('S', 7, 41),                    // ♠A 是这门仅剩两张之一
      ...[9, 8, 7, 6].map((r, i) => T('H', r, i)),      // 4 张主
    ],
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'mine' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'unseen' }],
      D: ALL_UNSEEN(), C: [14, 14, 13, 13].map(rank => ({ rank, status: 'seen' })),
    },
    currentTrick: [
      { seat: throwerSeat, playSuit: 'C', cards: [T('C', 12, 90), T('C', 9, 91), T('C', 8, 92)] },
    ],
  });
}

test('垫件：对手正在甩牌 → 宁可垫一张小主，也不把 ♠A 送进去', () => {
  const played = fillIntoThrowView(1);   // 座位 1 是对手
  const cards = chooseFollowCards(played);
  assert.equal(cards.length, 3);
  assert.ok(
    cards.every(c => c.rank !== 14 || c.suit !== 'S'),
    `他正在甩牌，垫 ♠A 等于给他下一手铺路（实际打了 ${cards.map(c => c.suit + c.rank).join(',')}）`
  );
});

// 对照：同一手牌，改成【队友】在甩。这时没有那个危险，回到 Glen 的默认 ——
// 「A 的价值并不比小的主牌要高」，该垫的是 ♠A，主牌留着。
// ⚠️ 两条必须成对看，不然「永远不垫件」也能让上面那条绿。
test('垫件：队友在甩牌 → 按常规垫掉 ♠A，主牌留着', () => {
  const cards = chooseFollowCards(fillIntoThrowView(2));   // 座位 2 是队友
  assert.equal(cards.length, 3);
  assert.ok(
    cards.some(c => c.suit === 'S' && c.rank === 14),
    `没有危险时该垫 ♠A 留主牌（实际打了 ${cards.map(c => c.suit + c.rank).join(',')}）`
  );
});

// ---- 读件的位置（Glen）：靠「谁在这门求过牌」判断件大概在谁手上 ----
//
// 「首先看对家有没有求牌，如果有，一般情况下就在对家；其次看对手两个人有没有求牌，
//   如果没求，那么多数情况下他们这门副牌肯定不强，件一般也不多，多的话也很短……
//   但这也不能是 100%。」
//
// 三条共用同一个 fixture（桌上 5 分、这门还长），只换【这门之前谁求过牌】：
//   对手求（就是这一墩他领的 ♠4）→ 风险照旧 → 不亮
//   对家求过                      → 件多半在对家 → 亮出去是帮自己人 → 亮
//   谁都没求过                    → 对手这门多半不强 → 风险略降 → 亮
// ⚠️ 「对手求」那一条靠的是【当前这一墩】的领牌，不是历史墩 ——
// 第一版只扫历史，把「对手正在求这门」读成「谁都没求过」，正好读反。
const SPADE_ASK = seat => ([{
  trickNo: 1, leadSeat: seat, leadSuit: 'S', winnerSeat: seat, points: 0,
  plays: [{ seat, cards: [T('S', 3, 80)] }],   // 领 ♠3 = 求件
}]);

// ⚠️ 队友【后来又改打了别门】—— 这是关键，否则测不到读牌那一层：
// 已有的「队友表示过这门」豁免只认他【最近一次】领牌（信号会过期，那是刻意的），
// 队友刚求完这门的话，整块风险计算会被那条豁免直接跳过，读牌系数根本执行不到。
// 而「件在谁手上」这个判断不会因为他改打别门就失效 —— 这正是读牌那层的适用范围。
test('读件：对家早先求过这门（后来改打别门）→ 件多半仍在他那，5 分也可以亮 ♠A', () => {
  const view = opponentProbeView([4, 5]);
  view.round.trickHistory = [
    ...SPADE_ASK(0),                          // 座位 0 是我（座位 2）的对家，早先求过黑桃
    { trickNo: 2, leadSeat: 0, leadSuit: 'D', winnerSeat: 0, points: 0,
      plays: [{ seat: 0, cards: [T('D', 6, 81)] }] },   // 之后他改打方块 → 黑桃那条请求已过期
  ];
  assert.equal(chooseFollowCards(view)[0].rank, 14);
});

test('读件：谁都没在这门求过 → 对手这门多半不强，风险略降', () => {
  const view = opponentProbeView([9, 5]);   // 对手领 ♠9，不是求件牌
  assert.equal(chooseFollowCards(view)[0].rank, 14);
});

// 对照：对手正在求这门（他这一墩领的就是 ♠4）→ 风险照旧，不亮。
// 这条已经在上面「5 分不值得亮 ♠A」里钉住了，这里只标明它属于同一组三档。

// ---- 例外：这门的分快没了，甩了也刮不到什么（Glen）----
//
// 「但也有例外，比如说打 10 或打 K，如果判断现在即使对方甩了也得不了多少分，
//   那么就可以杀。」
//
// 代码里没写死「打10 / 打K」，写的是【这门还剩多少分】—— 打 10 / 打 K 时该门的
// 10 / K 升为主牌，这门天生就从 50 分掉到 30 分（实测过），正是他举的例子；
// 中后段分被吃掉一部分，道理完全一样，一个量覆盖两种情形。
//
// ⚠️ 两边【打掉同样张数】的黑桃，只差是不是分牌 ——
// 否则张数一变，maxOpponentSuitEstimate（按张数算的威胁）也跟着变，
// 就分不清是哪个维度在起作用了。
const spadesPlayed = ranks => ([{
  trickNo: 1, leadSeat: 1, leadSuit: 'S', winnerSeat: 1, points: 0,
  plays: [{ seat: 1, cards: ranks.map((r, i) => T('S', r, 700 + i)) }],
}]);

// ⚠️ 只打【两张】。第一版两边各打 5 张，结果不管是不是分牌都会亮 ♠A ——
// 打掉 5 张本身就把「对手这门可能多长」降下去了，风险已经不够，
// 分值那一维根本没参与决策。张数少到风险仍然在线，才测得出分值的作用。
test('亮件：这门的分还满着 → 他甩出来能刮不少分，不亮 ♠A', () => {
  const view = opponentProbeView([4, 5]);
  view.round.trickHistory = spadesPlayed([9, 8]);      // 两张，都是无分牌
  assert.notEqual(chooseFollowCards(view)[0].rank, 14);
});

test('亮件：这门的分被拿走了 → 甩了也刮不到分，可以亮 ♠A', () => {
  const view = opponentProbeView([4, 5]);
  view.round.trickHistory = spadesPlayed([13, 13]);    // 同样两张，但是 20 分
  assert.equal(chooseFollowCards(view)[0].rank, 14,
    '分都走了还死护着件，那是白护');
});

// 打 10 / 打 K 时该门的 10 / K 升为主牌，这门【天生】就从 50 分掉到 30 分 ——
// Glen 举的正是这两个例子。所以「还剩多少分」的分母必须是【固定的满分 50】，
// 不能用本局该门的满分：那样打 10 时算出来 30/30 = 1，效果被自己除没了。
// ⚠️ 这条是专门为那个错误写的 —— 其余测试都是打 2（该门满分正好 50），
// 两种分母算出来一模一样，谁也分不出来。
// ⚠️ 用打 K 而不是打 10 —— 两者效果一样（该门都从 50 分掉到 30 分），
// 但打 10 时我手里那张 ♦10 也会变成主牌，把别的评分项一起搅动，测不干净。
test('亮件：打 K 时这门天生就少 20 分 → 同样局面下更愿意亮 ♠A', () => {
  const view = followView({
    rankCard: 13,                                     // ♠K 升为主牌，黑桃只剩 30 分
    seat: 2, declarerSeat: 1,
    hand: [
      ...[14, 9, 6, 3].map((r, i) => T('S', r, i)),   // 不带 ♠K，免得它变成主牌
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10)),
    ],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [T('S', 4, 90)] },
      { seat: 0, cards: [T('S', 5, 91)] },
    ],
    piecesView: {
      // 打 K 时 K 是主牌，这门的件只剩 A 两张
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' }],
      D: [], C: [],
    },
  });
  assert.equal(chooseFollowCards(view)[0].rank, 14,
    '这门本来就没多少分，他甩了也刮不到，不必死护着 ♠A');
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

// ---- 件已经喂出去了，就反过来去压他的甩牌长度 ----
//
// Glen：「不得以或是砍大分出的话，就要再吊对手可以甩花色。」
// 藏是为了不让他凑齐甩牌资格；件都交出去了，藏就没有意义了，
// 只能反过来主动领这门，一张一张把他能甩的长度压短。
//
// 这条和上面「不主动领对手求的那门」是同一件事的两个阶段，必须成对看：
// 没交出去之前躲，交出去之后压。
test('件喂出去之后：改为主动领这门，压短他能甩的长度', () => {
  const lead = chooseLeadCards(opponentAskedView([9, 7, 4], undefined, true))[0];
  assert.equal(lead.suit, 'S',
    `件已经交出去了，藏没意义，该去压他的长度（实际领了 ${lead.suit}${lead.rank}）`);
});

// 上面那条只钉住「不再躲」。这一条钉的是【主动去压】那一半：把黑桃缩到
// 比方块短，「发展最长副牌」会选方块，只有「压缩对手甩牌长度」那条提案
// 才会把牌拉回黑桃 —— 而它平时要等对手领够两次，交了件就立刻算数。
test('件喂出去之后：就算这门不是我最长的，也要回头去压它', () => {
  const lead = chooseLeadCards(
    opponentAskedView([9, 7, 4], undefined, true, [10, 9, 8, 6, 4])
  )[0];
  assert.equal(lead.suit, 'S',
    `方块更长，但黑桃是欠着的那门，该先去压（实际领了 ${lead.suit}${lead.rank}）`);
});

// ---- 压他的长度 vs 帮队友求件：谁先 ----
//
// Glen 裁定（2026-08-29）：
//   「我方刚把 ♠A 喂给对手了，同时队友在求 ♥件 —— 如果判断对手可以甩牌了，
//     应该先去压 ♠ 的长度，因为此时对手甩牌的威胁比你去给队友件要更大，
//     对手可以甩的牌短一支，那就少一份威胁。」
//
// 所以 compress 不是一个固定档位，而是【看他甩不甩得动】分两档：
//   甩得动 → 580，压过帮队友求件的上限（320 + 明求 160 + 队友做庄 80 = 560）
//   甩不动 → 400，照旧让位给队友
//
// 两条必须成对看：只留上面那条的话，「compress 永远最大」也能让它绿。
//
// ⚠️ fixture 的两臂【只差一支 ♠A 在不在我手上】，别的全同：
//   · 在我手上（'mine'）→ 我挡得住他一张 → 甩不动
//   · 不在（'unseen'）  → 挡不住 → 甩得动
// 另一支 A 两臂都留 'unseen'，这是【故意的】：不留的话四支件全非 'unseen'，
// canThrowByStatus 就成立了，「别拆甩牌门」那条会接管，两臂都改领方块，
// 本条起没起作用就看不出来了。
// 方块比黑桃长（4 vs 3），所以「发展最长副牌」指向方块 —— 把牌拉回黑桃的
// 只可能是 compress 这一条。
function compressVsPartnerAskView(spadeAceMine) {
  return leadView({
    // 队友（座 2）做庄 → 帮他求件那条拿满 560
    declarerSeat: 2, mySeat: 0,
    hand: [
      T('H', 16, 0), T('H', 16, 1),                                    // 双大鬼
      ...[14, 13, 12, 11, 10, 9, 8].map((r, i) => T('H', r, i + 2)),   // 凑满 9 张主 → 有保底，不吊主
      ...(spadeAceMine ? [T('S', 14, 38)] : [T('S', 4, 38)]),
      ...[9, 7].map((r, i) => T('S', r, i + 40)),
      ...[9, 8, 6, 4].map((r, i) => T('D', r, i + 60)),
    ],
    piecesView: {
      S: [
        { rank: 14, status: spadeAceMine ? 'mine' : 'unseen' },
        { rank: 14, status: 'unseen' },
        { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' },   // 喂出去的那支
      ],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
    trickHistory: [
      // 第 1 墩：对手（座 1）领 ♠3 求件，队友（座 2）被逼交出 ♠K
      {
        trickNo: 1, leadSeat: 1, leadSuit: 'S', winnerSeat: 1, points: 0,
        plays: [
          { seat: 1, playSuit: 'S', cards: [T('S', 3, 90)] },
          { seat: 0, cards: [T('S', 5, 91)] },
          { seat: 3, cards: [T('S', 6, 92)] },
          { seat: 2, cards: [T('S', 13, 93)] },
        ],
      },
      // 第 2 墩：队友领 ♦4 —— 明求方块的件
      {
        trickNo: 2, leadSeat: 2, leadSuit: 'D', winnerSeat: 2, points: 0,
        plays: [{ seat: 2, playSuit: 'D', cards: [T('D', 4, 94)] }],
      },
    ],
  });
}

test('压他的长度 vs 帮队友求件：他甩得动 → 先去压，别管队友那门', () => {
  const lead = chooseLeadCards(compressVsPartnerAskView(false))[0];
  assert.equal(lead.suit, 'S',
    `♠ 的件我一支都挡不住了，他甩牌的威胁比队友那件大（实际领了 ${lead.suit}${lead.rank}）`);
});

test('压他的长度 vs 帮队友求件：他甩不动（♠A 还在我手上）→ 还是先帮队友', () => {
  const lead = chooseLeadCards(compressVsPartnerAskView(true))[0];
  assert.equal(lead.suit, 'D',
    `♠A 在我手上，他甩不干净，威胁没那么急，该回队友那门（实际领了 ${lead.suit}${lead.rank}）`);
});

// 第三臂：件我一支都挡不住（和「甩得动」那臂一样），但这门【已经打得差不多了】，
// 他手上估计连两张都没有 —— 甩牌至少两张，剩一张就谈不上威胁，维持原判。
// Glen：「对手可以甩的牌短一支，那就少一份威胁」，短到一张就没有威胁可言。
//
// ⚠️ 和上面两臂的差别只在【♠ 出掉了多少】：20 张已经打出、我手上 3 张，
// 剩给别人的只有 1 张。件的状态和「甩得动」那臂一字不差。
test('压他的长度 vs 帮队友求件：这门他只剩一张，甩不成 → 还是先帮队友', () => {
  const spadeFlood = Array.from({ length: 16 }, (_, i) => T('S', 3 + (i % 3), 200 + i));
  const lead = chooseLeadCards(leadView({
    declarerSeat: 2, mySeat: 0,
    hand: [
      T('H', 16, 0), T('H', 16, 1),
      ...[14, 13, 12, 11, 10, 9, 8].map((r, i) => T('H', r, i + 2)),
      ...[9, 7, 4].map((r, i) => T('S', r, i + 40)),
      ...[9, 8, 6, 4].map((r, i) => T('D', r, i + 60)),
    ],
    piecesView: {
      S: [{ rank: 14, status: 'unseen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
    trickHistory: [
      { trickNo: 1, leadSeat: 1, leadSuit: 'S', winnerSeat: 1, points: 0, plays: [
        { seat: 1, playSuit: 'S', cards: [T('S', 3, 90)] },
        { seat: 0, cards: [T('S', 5, 91)] },
        { seat: 3, cards: [T('S', 6, 92)] },
        { seat: 2, cards: [T('S', 13, 93)] },   // 队友被逼交出 ♠K
      ] },
      // ♠ 已经甩过一轮，桌上出得七七八八
      { trickNo: 2, leadSeat: 3, leadSuit: 'S', winnerSeat: 3, points: 0, plays: [
        { seat: 3, playSuit: 'S', cards: spadeFlood.slice(0, 4) },
        { seat: 2, cards: spadeFlood.slice(4, 8) },
        { seat: 1, cards: spadeFlood.slice(8, 12) },
        { seat: 0, cards: spadeFlood.slice(12, 16) },
      ] },
      { trickNo: 3, leadSeat: 2, leadSuit: 'D', winnerSeat: 2, points: 0, plays: [
        { seat: 2, playSuit: 'D', cards: [T('D', 4, 94)] },
      ] },
    ],
  }))[0];
  assert.equal(lead.suit, 'D',
    `♠ 只剩一张在别人手上，甩不成，没必要抢在队友那件前面（实际领了 ${lead.suit}${lead.rank}）`);
});

// ============ 不帮对手吊主 ============
//
// Glen：「吊主也一样，如果对方要吊主吊大牌出来让自己保底，或是吊短主牌可以让
//   自己的甩牌别人毙不到，那我方记着不能帮对方吊主；当然也有例外，就是自己的
//   主牌碾压式的强，可以反吊回去。」
//
// 他吊主是在替自己办两件事，我跟着吊就是替他办，而且一轮下来我方也少一张。
//
// ⚠️ 实测这条在对局里很少真正触发：200 局里「上一次领主的是对手、我还是领主」
// 有 296 次，但插桩一看，其中 95 次胜出的提案是 low-card-fallback 或裸
// legal-single —— 手上只剩主牌，被规则逼的，不是主动吊。真正走「继续吊主」
// 那条的只有 6 次。所以这条规则是【补漏】，不是热点。
function opponentDrewTrumpsView(leadSeat) {
  return leadView({
    hand: [...NINE_TRUMPS, ...WEAK_SIDES],
    declarerSeat: 0, mySeat: 0,
    trickHistory: [{
      trickNo: 1, leadSeat, leadSuit: 'TRUMP', winnerSeat: leadSeat, points: 0,
      plays: [{ seat: leadSeat, playSuit: 'TRUMP', cards: [T('H', 4, 90)] }],
    }],
  });
}

test('不帮对手吊主：对手刚吊过主 → 转打副牌，让他自己吊', () => {
  const lead = chooseLeadCards(opponentDrewTrumpsView(1))[0];   // 座 1 是对手
  assert.notEqual(lead.suit, 'H',
    `他吊主是在办自己的事，跟着吊等于替他办（实际领了 ${lead.suit}${lead.rank}）`);
});

// 对照：换成队友吊的主 —— 那是我方的路子，该跟着吊。
// ⚠️ 两条用同一手牌，只换领主的座位，成对才钉得住「对手」这个判据。
test('不帮对手吊主：换成队友吊过主 → 照常跟着吊', () => {
  const lead = chooseLeadCards(opponentDrewTrumpsView(2))[0];   // 座 2 是队友
  assert.equal(lead.suit, 'H',
    `队友吊主是我方的路子，该跟着吊（实际领了 ${lead.suit}${lead.rank}）`);
});

// 例外：「自己的主牌碾压式的强，可以反吊回去」。按算牌落地 ——
// 顶端在我手上，而且我的主牌比【任何单独一家】可能持有的都多。
// 这里主牌已经出掉一大批、各家手牌只剩 4 张，摊到一家头上凑不出几张主。
test('不帮对手吊主：例外 —— 自己主牌碾压式的强 → 反吊回去', () => {
  const played = [];
  for (let r = 3; r <= 12; r += 1) played.push(T('H', r, 500 + r), T('H', r, 600 + r));
  played.push(T('H', 15, 700), T('H', 15, 701), T('S', 2, 702), T('D', 2, 703));
  const view = leadView({
    hand: [
      T('H', 16, 0), T('H', 16, 1),                     // 双大鬼 = 握着顶端
      ...[14, 13].map((r, i) => T('H', r, i + 2)),      // 主牌只有 4 张 → 够不上 guaranteed
      ...WEAK_SIDES,
    ],
    declarerSeat: 0, mySeat: 0,
    trickHistory: [{
      trickNo: 1, leadSeat: 1, leadSuit: 'TRUMP', winnerSeat: 1, points: 0,
      plays: [{ seat: 1, playSuit: 'TRUMP', cards: played }],
    }],
  });
  for (const p of view.players) p.handCount = 4;
  view.round.kittyCount = 0;
  const lead = chooseLeadCards(view)[0];
  assert.equal(lead.suit, 'H',
    `主牌碾压时该反吊回去把他削光（实际领了 ${lead.suit}${lead.rank}）`);
});

// ============ 对手在求的那门，不主动去领 ============
//
// Glen：「对手在求某一门牌，正常来说我们这边不能帮他们求，也就是说一般不主动
//   打这个花色，让他们出，因为这样我方是有优势的，他们出牌我方会最后下。」
//
// 领这门有两重亏：替他把件逼出来，还把「他先出、我方最后下」的位置优势让掉。
// 这也是他那句「保件防对手甩牌」真正的落点 —— 防守在领牌这一侧，
// 不是跟牌时死攥着件不放（跟牌那边他的裁定是「对方求的件一般要给他」）。
function opponentAskedView(spades, spadePieces, gavePiece = false, diamonds = [8, 6]) {
  return leadView({
    hand: [
      T('H', 16, 0), T('H', 16, 1),                                    // 双大鬼
      ...[14, 13, 12, 11, 10, 9, 8].map((r, i) => T('H', r, i + 2)),   // 凑满 9 张主 → 有保底，不吊主
      ...spades.map((r, i) => T('S', r, i + 40)),
      ...diamonds.map((r, i) => T('D', r, i + 60)),
    ],
    declarerSeat: 0, mySeat: 0,
    piecesView: {
      S: spadePieces ?? [
        { rank: 14, status: 'unseen' }, { rank: 14, status: 'unseen' },
        { rank: 13, status: 'unseen' }, { rank: 13, status: 'seen' },
      ],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
    // 对手（座 1）第 1 墩领 ♠4 求件，件还没逼完
    trickHistory: [{
      trickNo: 1, leadSeat: 1, leadSuit: 'S', winnerSeat: 1, points: 0,
      plays: [
        { seat: 1, playSuit: 'S', cards: [T('S', 4, 90)] },
        // gavePiece：队友（座 2）被逼把 ♠K 交了出去 —— 件已经喂给他了
        ...(gavePiece ? [{ seat: 2, cards: [T('S', 13, 91)] }] : []),
      ],
    }],
  });
}

test('不帮对手求：他在求黑桃、件还没逼完 → 改领别门，让他自己来', () => {
  const lead = chooseLeadCards(opponentAskedView([9, 7, 4]))[0];
  assert.equal(lead.suit, 'D',
    `黑桃是对手在求的门，领它等于替他逼件（实际领了 ${lead.suit}${lead.rank}）`);
});

// 例外：这门我自己也有甩牌欲望 —— 那是我的武器，领它是为了自己甩，不是帮他。
// ⚠️ 「躲只针对还没逼完」这半边由上面【件喂出去之后：改为主动领这门】那条钉住
//（teamGavePieceIn 是 opponentAskOpen 的另一个出口，件状态不动，只剩本条起作用）。
//
// ⚠️ 这里【原本还有一条】用「件全现完」关掉躲避的对照，已删 —— 它变得观察不到了：
// 件全现 = opponentAskOpen 关掉，【同时】也 = canThrowByStatus 打开，两件事是
// 同一件事。于是下面「甩得出去就别一张张领」那条必然接管，领的门由它决定，
// 本条起没起作用看不出来。原来的 fixture 留着，改钉那条规矩（就在下面）。

// Glen 裁定（第三条规矩，2026-08-29）：
//   「一般来说，还是有一手甩牌对于对手来说会更有威胁，即使现在还是在吊主阶段，
//     所以如果想一支支打，一般也不能打可以甩的门，这个非常浪费，因为如果吊主
//     把对手手中的主的数量吊到低于你手中的甩牌数量的话，手上的那门甩牌就会
//     非常有价值，甚至可以保底/撬底。」
//
// 这一手：♠ 的件全现完了 → 甩牌资格成立、我还有 3 张，这门就是【留着的资产】。
// 但手牌 14 张（早盘），safeSideThrow 要 ≥4 张才肯暴露 → 它不提甩牌案。
// 旧写法只护 safeSideThrow 挑中的那一门，于是这门既没被甩、也没被护，
// 就一张张漏出去了。实测 200 局浪费的 58 次里有 41 次正是这种两三张的门。
test('别拆甩牌门：件全现、张数够甩，但早盘还不值得暴露 → 改领别门，不一张张漏', () => {
  const lead = chooseLeadCards(opponentAskedView(
    [9, 7, 4],
    [14, 14, 13, 13].map(rank => ({ rank, status: 'seen' })),
  ))[0];
  assert.equal(lead.suit, 'D',
    `♠ 甩得出去，就该整门留着甩，不能一张张领（实际领了 ${lead.suit}${lead.rank}）`);
});

test('不帮对手求：但这门我自己够长（是我的武器）→ 照领不误', () => {
  const lead = chooseLeadCards(opponentAskedView([11, 9, 8, 7, 6, 5, 4, 3]))[0];
  assert.equal(lead.suit, 'S',
    `八张黑桃是我自己的甩牌本钱，不能因为他求过就不打（实际领了 ${lead.suit}${lead.rank}）`);
});

// ============ Glen 实战反馈第 1 条：别乱求件 ============
//
// 「发现 bot 会乱求牌。一般真人玩家第一轮如果不是那门有甩牌的欲望
//  （可以是件多也可以是很长，希望通过甩牌得分或造成威胁），
//   就不会打 5 或 5 以下的牌去求对方的件。」
//
// 电脑不是故意的：develop-long-side-suit / attack / 兜底这几条压根没有求件的
// 意思，可它们一律挑「最小的无分牌」，出手就是求件信号。两道闸门：
//   · quietLead —— 这门还有 6~9 就换一张中性牌（免费，什么都不损失）
//   · strayAskPenalty —— 只剩小牌换不了，就在打分上罚，让别的门赢过它
// 豁免两种「真心在求」：这门有甩牌欲望，或者我方在这门的求件还没逼完。

// 没有件、也不够长的一门（4 张 ♠，摊到单个对手头上约 5.4 张 → 我不占优）
function strayAskView({ spades, diamonds = [], trickHistory = [], piecesView }) {
  return leadView({
    piecesView,
    hand: [
      T('H', 16, 0), T('H', 16, 1),                                    // 双大鬼
      ...[14, 13, 12, 11, 10, 9, 8].map((r, i) => T('H', r, i + 2)),   // 凑满 9 张主 → 有保底，不吊主
      ...spades.map((r, i) => T('S', r, i + 40)),
      ...diamonds.map((r, i) => T('D', r, i + 60)),
    ],
    declarerSeat: 0, mySeat: 0, trickHistory,
  });
}

test('别乱求：这门没甩牌欲望 → 换一张 6~9 的中性牌领，不发求件信号', () => {
  const lead = chooseLeadCards(strayAskView({ spades: [9, 7, 5, 3] }))[0];
  assert.equal(lead.suit, 'S');
  assert.equal(lead.rank, 7, `这门只有 4 张又一件没有，不该打 ♠3 去求件（实际 ♠${lead.rank}）`);
});

test('别乱求：这门够长（甩牌欲望成立）→ 照旧打最小的求件，这一喊是真心的', () => {
  // 8 张 ♠：摊到单个对手头上约 4.4 张，我比谁都长 → 甩出去压得住
  const lead = chooseLeadCards(strayAskView({ spades: [11, 9, 8, 7, 6, 5, 4, 3] }))[0];
  assert.equal(lead.suit, 'S');
  assert.equal(lead.rank, 3, `长门求件是 Glen 认可的打法，该打 ♠3（实际 ♠${lead.rank}）`);
});

test('别乱求：只剩小牌换不了 → 改领别的门，别硬着头皮喊', () => {
  const lead = chooseLeadCards(strayAskView({ spades: [5, 4, 3], diamonds: [8, 7] }))[0];
  assert.equal(lead.suit, 'D', `♠ 那门一张 6~9 都没有，该改领方块（实际 ${lead.suit}${lead.rank}）`);
  assert.equal(lead.rank, 7);
});

test('别乱求：我方在这门的求件还没逼完 → 接着领小牌逼件，不算乱求', () => {
  const lead = chooseLeadCards(strayAskView({
    spades: [5, 4, 3], diamonds: [8, 7],
    // 我自己第 1 墩就在 ♠ 求过件，♠ 还有一支 K 没现身 → 这一领是把它逼出来
    trickHistory: [{
      trickNo: 1, leadSeat: 0, leadSuit: 'S', winnerSeat: 0, points: 0,
      plays: [{ seat: 0, playSuit: 'S', cards: [T('S', 4, 90)] }],
    }],
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'seen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'unseen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
  }))[0];
  assert.equal(lead.suit, 'S', `件还没逼完就该接着领 ♠（实际 ${lead.suit}${lead.rank}）`);
  assert.equal(lead.rank, 3);
});

// 甩牌欲望的两档是【或】的关系，件多那一档不能被长度那一档吞掉。
// 这里两件配 5 张：长度那一档过不了（摊到单个对手头上约 5.2 张，我不占优），
// 只有 strongPieceSuit 认账 —— 正是 Glen 说的「有两件以上不少于 6 支」那一档
//（默认 tuning 的 pieceProbeMinLength 是 5）。
test('别乱求：件多但不算长 → 仍然算有甩牌欲望，该求就求', () => {
  const lead = chooseLeadCards(strayAskView({
    spades: [14, 13, 9, 7, 3],
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
  }))[0];
  assert.equal(lead.suit, 'S');
  assert.equal(lead.rank, 3, `♠AK 配 5 张就该求件（实际 ♠${lead.rank}）`);
});

// 边界钉子：「很长」的判据是【严格】比任何单独一家对手可能持有的都多。
// 一样长不算占优 —— 甩出去他跟得完，压不住。这个 fixture 把数配成整数相等：
//   对手三家各 8 张 + 底牌 0 张 = 24 张暗牌，这门未现 24-6=18 张，
//   摊到一家头上正好 18×8/24 = 6，和我手上的 6 张打平。
test('别乱求：这门和对手一样长（不算占优）→ 还是不喊', () => {
  const view = strayAskView({ spades: [11, 9, 8, 7, 4, 3] });
  for (const p of view.players) p.handCount = 8;
  view.round.kittyCount = 0;
  const lead = chooseLeadCards(view)[0];
  assert.equal(lead.suit, 'S');
  assert.equal(lead.rank, 7, `打平不算占优，该换中性牌（实际 ♠${lead.rank}）`);
});

// 甩牌不是求件信号 —— 一手小牌的甩牌不能被「别乱喊」那道闸门误删。
test('别乱求：一手小牌的甩牌不是求件信号，照甩', () => {
  const cards = chooseLeadCards(leadView({
    hand: [
      T('S', 4, 40), T('S', 3, 41),                       // 两张小黑桃，件全在外面已现
      ...[9, 8, 7, 6, 5, 4].map((r, i) => T('H', r, i)),  // 6 张弱主
    ],
    declarerSeat: 1, mySeat: 0,
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'seen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
      D: ALL_UNSEEN(), C: ALL_UNSEEN(),
    },
  }));
  assert.equal(cards.length, 2, `该把两张黑桃一起甩出去（实际 ${cards.map(c => c.suit + c.rank).join(',')}）`);
  assert.ok(cards.every(c => c.suit === 'S'));
});

// ============ Glen 实战反馈第 4 条：求完件要甩 ============
//
// 「有时候 bot 求完件，我给它之后，它却不想甩，变成一张张打，浪费了机会。」
//
// 根因量出来是【同一张牌上的加分累加】，不是甩牌那条判据出了问题：
// 「领这门最小的牌」那张卡片会同时拿到
//   return-partner-suit 320（+求件 160 +队友做庄 80）
//   + develop-long-side-suit 160 + low-card-fallback 20 = 740，
// 稳压 safe-side-throw 的 620。所以 chooseLeadCards 里用的是【让位】：
// 这门甩得出去时，同门的单张提案整个删掉。
//
// ⚠️ 这个 fixture 是照着那 740 分搭的，别随手改动这几处：
//   · 队友（座 2）做庄，第 1 墩领 ♠4 —— 凑齐 seeking(160) + 队友做庄(80)
//   · 黑桃是我最长的副牌 —— 才拿得到 develop 的 160
//   · 黑桃 4 张且一分不带 —— 4 张才过得了 safeSideThrow 的早盘门槛，
//     带分的话早盘 pointValue×8 的罚分会把甩牌自己压下去，换成另一个根因
function askAnsweredView(spadePieces) {
  return leadView({
    hand: [
      ...[14, 9, 7, 3].map((r, i) => T('S', r, i + 40)),   // 黑桃 4 张，无分
      ...[8, 6].map((r, i) => T('D', r, i + 50)),          // 一门更短的副牌
      ...[9, 8, 7, 6, 5, 4].map((r, i) => T('H', r, i)),   // 6 张弱主
    ],
    declarerSeat: 2, mySeat: 0,
    piecesView: { S: spadePieces, D: [], C: [] },
    trickHistory: [{
      trickNo: 1, leadSeat: 2, leadSuit: 'S', winnerSeat: 0, points: 0,
      plays: [{ seat: 2, playSuit: 'S', cards: [T('S', 4, 90)] }],
    }],
  });
}

// ♠A 在我手上，另外三件都已现身 → canThrowByStatus 成立
const SPADE_PIECES_DONE = [
  { rank: 14, status: 'mine' }, { rank: 14, status: 'seen' },
  { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' },
];

test('求完件要甩：件都现完了就整门甩出去，不许再一张一张领这门', () => {
  const cards = chooseLeadCards(askAnsweredView(SPADE_PIECES_DONE));
  assert.equal(cards.length, 4, `件已逼完就该整门甩，实际只打了 ${cards.map(c => c.suit + c.rank).join(',')}`);
  assert.ok(cards.every(c => c.suit === 'S'), '甩的是黑桃');
});

// 反向保护：让位只挂在「这门此刻甩得出去」上。件还没逼完的时候，
// 一张一张领这门正是 Glen 第 2 条要的【帮队友把件逼出来】，不能一起删掉。
test('求完件要甩：还有件没现身 → 照旧领小牌帮队友逼件，不受让位影响', () => {
  const cards = chooseLeadCards(askAnsweredView([
    { rank: 14, status: 'mine' }, { rank: 14, status: 'seen' },
    { rank: 13, status: 'seen' }, { rank: 13, status: 'unseen' },  // 还差一支 ♠K
  ]));
  assert.equal(cards.length, 1, '件没逼完就还不能甩');
  assert.equal(cards[0].suit, 'S', '该接着领黑桃把最后那支 K 逼出来');
  assert.equal(cards[0].rank, 3, '领这门最小的那张');
});

// 第二条反向保护：让位只针对【甩牌那一门】。别的门的单张提案不能受牵连，
// 否则「手上碰巧有一门能甩」就变成「这一墩只准甩牌」，把帮队友逼件、吊主
// 这些更要紧的事全挤掉了。变异测试专门盯着这一条（mutants18）。
test('求完件要甩：让位只挂在甩牌那一门，别的门照领不误', () => {
  const view = leadView({
    hand: [
      T('S', 13, 40), T('S', 10, 41),                      // 黑桃 2 张，能甩但带 20 分
      ...[9, 6, 3].map((r, i) => T('D', r, i + 50)),       // 方块 3 张 —— 队友在求的就是这门
      ...[9, 8, 7, 6, 5].map((r, i) => T('H', r, i)),      // 5 张弱主
    ],
    declarerSeat: 2, mySeat: 0,
    piecesView: {
      // 黑桃：双 A 已现、♠K 在我手上、另一支 K 已现 → 甩得出去
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'seen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'seen' }],
      // 方块：还有一支 ♦A 没现身 → 队友第 1 墩那次求件还没逼完
      D: [{ rank: 14, status: 'unseen' }, { rank: 14, status: 'seen' },
          { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' }],
      C: [],
    },
    trickHistory: [{
      trickNo: 1, leadSeat: 2, leadSuit: 'D', winnerSeat: 0, points: 0,
      plays: [{ seat: 2, playSuit: 'D', cards: [T('D', 4, 90)] }],
    }],
  });
  const cards = chooseLeadCards(view);
  assert.equal(cards[0].suit, 'D', `该去帮队友逼那支 ♦A，实际打了 ${cards.map(c => c.suit + c.rank).join(',')}`);
  assert.equal(cards.length, 1, '帮队友逼件是领单张');
});

// 第三条：计划性压住不甩的那一门也让位。
// 甩尾手的计划是「先吊主削掉对手的毙牌能力，再整门甩出去」——
// 这期间一张一张漏这门，等于自己把尾巴拆了。跟牌那边早有护尾罚分
//（见上面「宁可垫低主也不拆长门」那条），领牌这边要一致。
//
// ⚠️ 这一档是从 Glen 的原则推的，不是他直接裁定的，回头要跟他确认。
test('求完件要甩：计划留着尾巴甩的那一门，也不许一张一张漏出去', () => {
  const view = leadView({
    hand: [
      T('H', 16, 0), T('H', 16, 1),                        // 双大鬼 → holdsTopTrump
      ...[6, 5].map((r, i) => T('H', r, i + 2)),           // 主牌只有 4 张 → 计划还没到火候
      ...[11, 9, 7, 6, 4].map((r, i) => T('S', r, i + 40)), // 尾巴：5 张可甩的黑桃
    ],
    declarerSeat: 2, mySeat: 0, piecesView: SPADES_THROWABLE,
    // 队友（座 2，同时是庄家）第 1 墩领 ♠3 求件 —— 回门那条能拿到满额 560 分，
    // 加上 develop(160) + 兜底(20) = 740，压得过一切；没有让位就会去领 ♠4。
    trickHistory: [{
      trickNo: 1, leadSeat: 2, leadSuit: 'S', winnerSeat: 0, points: 0,
      plays: [{ seat: 2, playSuit: 'S', cards: [T('S', 3, 90)] }],
    }],
  });
  const cards = chooseLeadCards(view);
  assert.notEqual(
    `${cards.length}${cards[0].suit}`, '1S',
    `对手主牌还够毙，这门要留到尾巴上整门甩，不能拆着领（实际打了 ${cards.map(c => c.suit + c.rank).join(',')}）`
  );
  assert.equal(cards[0].suit, 'H', '这时候该去吊主，把对手的主削下来');
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
// ⚠️ 手上必须是【双大鬼 + 一张小鬼】，不能只给一大一小：
//   一大一小 → holdsTopTrump 不成立、主又只有 2 张、副牌也无威胁 →
//   roundStrategy 判成「保底已经不现实」→ 吊主提案被整块压掉 →
//   这条测试变成「因为不吊主所以没领鬼」，把「吊主候选不含鬼」那条删掉都不会红。
// 双大鬼撑住 holdsTopTrump（另一张大鬼已被自己拿光，顶档没有威胁），
// 策略回到 run-and-score，吊主提案活着，被测的那条筛选才是决定因素。
// 留一张小鬼是为了区分「只挡大鬼」和「鬼全挡」这两种写法。
test('吊主：手上只剩鬼当主牌 → 不再吊主，转副牌', () => {
  const lead = chooseLeadCards(leadView({
    hand: [
      T('JOKER', 16, 0), T('JOKER', 16, 1), T('JOKER', 15, 2),  // 当主牌用的只有这三只鬼
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
//
// ⚠️ 这个 fixture 调了两轮才让被测的那道闸真正参与决策，两次都是「吊主提案压根没出现」：
//   第一版 3 张主 → roundStrategy 判成「保底已经不现实」（副牌无威胁 + 没顶张 +
//     主不够长，三条全中）→ 吊主提案被整块压掉；
//   第二版 9 张主 → 外面只剩 3 张，holdsTopTrump 且主够长 → control.guaranteed
//     成立 →「有保底牌就不吊」那条又把提案关掉了。
// 两次测试都还是绿的（因为不吊主自然也不会领鬼），全靠变异测试戳穿。
// 现在用【顶端断层】的牌型：小鬼 + 双主2 + 双副2 —— 顶上压着三张（双大鬼 + 一张小鬼），
// 但靠下面四张级牌撑住 holdsTopTrump，主牌只有 5 张所以不够保底，吊主提案活着。
test('清顶：顶端还剩三张压着 → 撞不干净，不动鬼', () => {
  const lead = chooseLeadCards(clearingView({
    trumps: [
      T('JOKER', 15, 1),
      T('H', 2, 61), T('H', 2, 62),   // 双主2
      T('S', 2, 63), T('D', 2, 64),   // 双副2（打 2 时属主牌）
    ],
    outside: [T('JOKER', 16, 700), T('JOKER', 16, 701), T('JOKER', 15, 702)],
  }))[0];
  assert.ok(lead.rank !== 16 && lead.rank !== 15,
    `顶上还压着三张，我的小鬼出去只是送掉，实际领了 ${lead.suit}${lead.rank}`);
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

// ⚠️ 这条测试【整个换掉了】。原来写的是「尾盘不再受早盘惩罚约束」——
// 断言手牌降到 8 张以下之后出鬼的评分要比早盘高出 100 以上。那是照着代码里
// `early = hand.length > 8` 这个开关写的，方向反了。Glen 第三次纠正：
//   「留鬼保底/撬底是潮汕升级的基本打法，不能见牌或见分就砍……有保底/撬底的
//     鬼组合（如大小鬼）还是见牌就砍，需要再严格地出这个规则。」
// 保底/撬底比的就是最后一墩，越往后这张鬼越金贵，代价不该在后半盘凭空消失。
//
// 原来那条测试真正想守的东西（别把鬼烂在手里）没有丢，换成下面这一对来守：
// 门槛是【这一墩值不值】，不是【第几墩】。
test('留鬼：后半盘这一墩一分没有 → 不砍，跟一张小主', () => {
  for (const sideCards of [2, 6]) {   // 手牌 6 张（后半盘）和 10 张（早中盘）都一样
    const cards = chooseFollowCards(trumpLeadFollowView({ points: 0, sideCards }));
    assert.notEqual(cards[0].rank, 15,
      `手牌 ${4 + sideCards} 张、桌上 0 分，不该拿小鬼去砍（实际 ♥${cards[0].rank}）`);
  }
});

test('留鬼：同样是后半盘，这一墩 20 分 → 该砍就砍', () => {
  for (const sideCards of [2, 6]) {
    const cards = chooseFollowCards(trumpLeadFollowView({ points: 20, sideCards }));
    assert.equal(cards[0].rank, 15,
      `20 分够大了，该拿小鬼收下来（手牌 ${4 + sideCards} 张，实际 ♥${cards[0].rank}）`);
  }
});

// ---- 「这一下把底丢了」不只发生在副牌墩（Glen 第三次强调留鬼）----
//
// 「留鬼保底/撬底是潮汕升级的基本打法，不能见牌或见分就砍……有保底/撬底的
//   鬼组合（如大小鬼）还是见牌就砍，需要再严格地出这个规则。」
//
// 原来这条保护写着 isKill（副牌墩 + 我缺门 + 整手主牌毙）。可 isKill 要求
// lead.playSuit !== 'TRUMP'，【首家领主牌时它恒为 false】—— 别人吊主、我拿鬼
// 去压，一分代价都没有，而那正是后半盘最常见的场面。丢掉的是同一件资产，
// 跟这一墩是副牌还是主牌无关。
//
// 局面：另一张大鬼和另一张小鬼都已经打掉了，我手上这张大鬼是场上唯一顶牌。
// 对手领剩下那张小鬼，桌上 20 分，只有我的大鬼压得过。
function lastTopTrumpView(defenderTrickPoints) {
  return followView({
    seat: 1, declarerSeat: 0, defenderTrickPoints,   // 我是闲家
    hand: [
      T('H', 16, 0),                                 // 场上仅剩的顶牌
      ...[9, 7, 6].map((r, i) => T('H', r, i + 2)),
      ...[9, 7].map((r, i) => T('S', r, i + 20)),
    ],
    trickHistory: [{
      trickNo: 1, leadSeat: 0, leadSuit: 'TRUMP', winnerSeat: 0, points: 0,
      plays: [{ seat: 0, playSuit: 'TRUMP', cards: [T('H', 16, 70)] },   // 另一张大鬼
              { seat: 1, cards: [T('H', 3, 71)] },
              { seat: 2, cards: [T('H', 15, 72)] },                      // 另一张小鬼
              { seat: 3, cards: [T('H', 5, 73)] }],
    }],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [T('H', 15, 80)] },  // 对手领剩下那张小鬼
      { seat: 3, cards: [T('H', 13, 81)] },                     // 10 分
      { seat: 2, cards: [T('H', 10, 82)] },                     // 10 分
    ],
  });
}

test('留鬼：领的是主牌也一样 —— 20 分不到移庄线，不拿最后一张顶牌去换', () => {
  const cards = chooseFollowCards(lastTopTrumpView(0));
  assert.notEqual(cards[0].rank, 16,
    `20 分够不上 80 的移庄线，这张大鬼该留着撬底（实际打了 ♥${cards[0].rank}）`);
});

// 对照：同一手牌，闲家已经有 60 分 —— 这 20 分收下就到 80，那就无所谓底了，该砍。
// ⚠️ 两条必须成对看，不然「永远不出鬼」也能让上面那条绿。
test('留鬼：同一手牌，收下这 20 分正好到移庄线 → 该砍就砍', () => {
  const cards = chooseFollowCards(lastTopTrumpView(60));
  assert.equal(cards[0].rank, 16,
    `60 + 20 = 80 过线了，这时候就该拿下（实际打了 ♥${cards[0].rank}）`);
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

// Glen 实战反馈②：「我方甩一门牌后，BOT 把这门牌下完，然后贴其它门牌的时候
// 不知道为什么放了小鬼在里边，也不是给逼出来。」
//
// 根因不在牌值表，在候选形状：followCandidates 给「凑张数」的位置也生成了
// highCards（挑最大的几张）。可混合花色的一手【永远】参与不了比大小
//（server/trick.js trickLeader 分支 A 只认满额跟花色 / 满额主牌毙），
// 所以那几张挑大的一分也换不回来。评分器反而偏爱它：
//   垫两张 ♦5 送出 10 分 → candidatePoints × 14 = −140
//   白扔小鬼 + 小主       → keepValue × 0.25  = −61
// （写这条时护鬼那条规则还要求 early「手牌 > 8 张」，甩牌多发生在中后段，
//   所以这里一分保护都没有。后来 Glen 第三次强调留鬼，那个开关去掉了，
//   这个局面现在被护了两遍 —— 候选形状这一层仍然要留着，它管的是别的牌。）
//
// 手牌 7 张、非鬼牌 6 张、只需凑 2 张 —— 规则上完全逼不出这张鬼。
// 改之前实测：400 局里有 25 次这样【有得选却仍然把鬼垫掉】，改之后 0 次
//（还剩 8 次是手牌真不够，规则逼的）。见 scripts/audit/joker-discard-decisions.mjs。
test('垫牌：赢不下的一墩里，绝不拿鬼去凑张数', () => {
  const view = followView({
    seat: 2,
    hand: [
      T('S', 9, 0), T('S', 7, 1),   // 这门只剩两张，对手甩四张
      T('JOKER', 15, 2),            // 小鬼
      T('H', 8, 3),                 // 一张小主
      T('D', 10, 4), T('D', 5, 5), T('D', 5, 6),
    ],
    currentTrick: [{
      seat: 1, playSuit: 'S',
      cards: [T('S', 14, 90), T('S', 14, 91), T('S', 12, 92), T('S', 11, 93)],
    }],
  });
  const cards = chooseFollowCards(view);
  const shown = cards.map(c => `${c.suit}${c.rank}`).join(' ');
  assert.equal(
    cards.filter(c => c.rank === 15 || c.rank === 16).length, 0,
    `这一墩怎么打都赢不下，鬼扔进去一分换不回来，却打了：${shown}`
  );
  assert.equal(cards.filter(c => c.suit === 'S').length, 2, '这门有几张就得跟几张');
});

// 反向保护：别把 highCards 一并从【能赢的位置】拿掉。
// 满额跟花色是要比大小的，该出大的时候就得出大的。
test('垫牌：能满额跟这门时，仍然会用大牌去争这一墩的分', () => {
  const view = followView({
    seat: 3, // 最后一家；桌上 20 分正被对手(2)的 ♠K 领着
    hand: [T('S', 14, 0), T('S', 4, 1), T('D', 4, 2), T('D', 6, 3), T('C', 7, 4)],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [T('S', 10, 90)] },
      { seat: 1, playSuit: 'S', cards: [T('S', 3, 91)] },
      { seat: 2, playSuit: 'S', cards: [T('S', 13, 92)] },
    ],
  });
  assert.equal(chooseFollowCards(view)[0].rank, 14, '20 分在桌上被对手领着、我是最后一家，♠A 就该拿下');
});

// ---- Glen 实战反馈①：「件还是容易打出来」----
//
// 「一方 BOT 求了个件，对方打出来后又打了个 5 以下，其实这个时候已经不代表求件了，
//   因为之前对家已经求过，我似乎看到他们互出件，然后给我方甩牌。」
//
// 裁定：求件是一次性的表态。我方在一门副牌上只有一次求件机会 ——
// 第一次领小牌是在问「你有没有件」，队友答过之后，同门再领小牌只是普通打法。

test('求件应答：这门我方已经求过一次 → 队友再领小牌不算求件，不再贡献', () => {
  const view = contributionView({ unseen: 1 });
  // 队友（座 0）之前已经在♠求过一次件，而且那一墩是我方赢下的
  view.round.trickHistory = [{
    leadSeat: 0, leadSuit: 'S', winnerSeat: 2,
    plays: [
      { seat: 0, playSuit: 'S', cards: [T('S', 3, 80)] },
      { seat: 1, playSuit: 'S', cards: [T('S', 7, 81)] },
      { seat: 2, playSuit: 'S', cards: [T('S', 14, 82)] },
      { seat: 3, playSuit: 'S', cards: [T('S', 8, 83)] },
    ],
  }];
  const cards = chooseFollowCards(view);
  assert.notEqual(
    cards[0].rank, 13,
    `这门已经求过一次了，再贡献一支 ♠K 只是把「未现」变「已现」，却打了 ${cards[0].suit}${cards[0].rank}`
  );
});

// partnerSideProtocolChoice 里的 asksForPiece 原来写成
// 「cardPoints > 0 || 不是件」= 朋友单张领这门、只要不是副 A 就算求件，
// 6/7/8/9/J/Q 全算 —— 而这条约定带 +700 加分，稳压亮件代价。
// 求件的判据全项目只有一个：单张、本身不是件、5 以下或者 10。
test('求件应答：队友领 ♠9 不是求件 → 第三家不该把 ♠A 交出去', () => {
  const view = followView({
    seat: 2, // 第三家，partnerSideProtocolChoice 只在这个位置生效
    hand: [T('S', 14, 0), T('S', 8, 1), T('S', 3, 2),
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10))],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [T('S', 9, 90)] },   // 队友领 ♠9：不是求件
      { seat: 1, playSuit: 'S', cards: [T('S', 7, 91)] },
    ],
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' }],
      D: [], C: [],
    },
  });
  const cards = chooseFollowCards(view);
  assert.notEqual(
    cards[0].rank, 14,
    `一墩零分、队友领的又不是求件牌，♠A 交出去纯粹是替对手凑甩牌资格，却打了 ${cards[0].suit}${cards[0].rank}`
  );
});

// 反向保护：真正的求件仍然要应。别把上面两条收得连正经约定都触发不了。
test('求件应答：队友领 ♠4（真求件）→ 第三家照样把 ♠A 贡献出去', () => {
  const view = followView({
    seat: 2,
    hand: [T('S', 14, 0), T('S', 8, 1), T('S', 3, 2),
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10))],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [T('S', 4, 90)] },   // 队友领 ♠4：明确求件
      { seat: 1, playSuit: 'S', cards: [T('S', 7, 91)] },
    ],
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' }],
      D: [], C: [],
    },
  });
  assert.equal(chooseFollowCards(view)[0].rank, 14, '队友明确求件，件就该给');
});

// ---- Glen 实战反馈③：「鬼还是有乱出的情况」----
//
// 复核下来鬼的出牌整体已经很干净（前中段「有得选却白打」400 局里 1 次），
// 剩下的是这一个形状：毙牌时候选只有两个极端 ——
//   最便宜的那组（可后面还有两家能压过去，而且往往带着自家的分牌）
//   和 highCards 那组（安全，可要一口气交两只鬼）
// 中间那个正解「一支够大的 + 一支最便宜的」从来没被生成过，
// 而这正是 Glen 上一轮给的判据：「看的只是最大那支，一支大鬼还有一支小牌即可」。
// 根因在 followCandidates 的 economical：它在第一组【眼前赢得下】的地方就 return 了，
// 而 trickLeader 只判半墩，不知道后面还有人没出。
//
// 对手甩 ♦A♦K，我方缺门要毙。手上 3 张鬼 + H2/H14/H11/H10/H3。
function killLadderView(defenderTrickPoints) {
  return followView({
    seat: 2,
    hand: [
      T('JOKER', 16, 0), T('JOKER', 15, 1), T('JOKER', 15, 2),
      T('H', 2, 3), T('H', 14, 4), T('H', 11, 5), T('H', 10, 6), T('H', 3, 7),
    ],
    currentTrick: [{ seat: 1, playSuit: 'D', cards: [T('D', 14, 90), T('D', 13, 91)] }],
    defenderTrickPoints,
  });
}

// 闲家已吃 75 分 + 这一墩 10 分 ≥ 80，「毙下去也不影响底」那条不再生效，
// 于是旧代码只剩 [大鬼,小鬼] 和 [H3,H10] 两个候选，选了前者。
test('毙牌：一支够大的配一支最便宜的就够了，不许一口气交两只鬼', () => {
  const cards = chooseFollowCards(killLadderView(75));
  const shown = cards.map(c => `${c.suit}${c.rank}`).join(' ');
  assert.ok(
    cards.filter(c => c.rank === 15 || c.rank === 16).length <= 1,
    `判牌只比最大那一张，一支够大的配一支小主就行，却交了：${shown}`
  );
});

// 同一手牌，闲家已吃 75 → 60（这一墩后仍不到 80）。
// 这里考的是另一半：最便宜的那组 [H3,H10] 会把自家带 10 分的主牌垫进去，
// 而后面还有两家 —— 有了阶梯之后就该挑「够大 + 最便宜」而不是「最小 + 带分」。
test('毙牌：有阶梯可选时，不把自家带分的主牌塞进这一毙', () => {
  const cards = chooseFollowCards(killLadderView(60));
  const shown = cards.map(c => `${c.suit}${c.rank}`).join(' ');
  assert.equal(
    cards.reduce((sum, c) => sum + cardPointsOf(c), 0), 0,
    `后面还有两家未出，主 10 塞进去等于把分挂在外面，却打了：${shown}`
  );
});

// 「公开信息已经排除反超」的第三种情形：满额主牌、外面没有更大的主牌没现身。
// 这一墩已经落袋，带上去的分一点风险都没有，不该按分牌暴露罚 ——
// 否则电脑宁可多花一只鬼也不肯把自己的主 10 打出去。
test('毙牌：外面没有更大的主牌了，带分的主牌就可以放心打出去', () => {
  // 主 H、级 2。比主花色 A 更大的主牌一共 12 张：大鬼 2、小鬼 2、
  // 主级牌 H2 两张、副级牌 S2/D2/C2 各两张 —— 全部让它们现身。
  // 另一张 H14 仍未现，但同强度后出者不大，威胁不到我。
  const spentTrick = (i, cards) => ({
    leadSeat: 0, leadSuit: 'TRUMP', winnerSeat: 0,
    plays: cards.map((card, k) => ({ seat: k, playSuit: 'TRUMP', cards: [card] })),
  });
  const view = followView({
    seat: 2,
    hand: [T('H', 14, 0), T('H', 10, 1), T('H', 3, 2), T('H', 4, 3),
      T('C', 9, 4), T('C', 8, 5)],
    currentTrick: [{ seat: 1, playSuit: 'D', cards: [T('D', 14, 90), T('D', 13, 91)] }],
    trickHistory: [
      spentTrick(0, [T('JOKER', 16, 20), T('JOKER', 16, 21), T('JOKER', 15, 22), T('JOKER', 15, 23)]),
      spentTrick(1, [T('H', 2, 24), T('H', 2, 25), T('S', 2, 26), T('S', 2, 27)]),
      spentTrick(2, [T('D', 2, 28), T('D', 2, 29), T('C', 2, 30), T('C', 2, 31)]),
    ],
  });
  const choices = evaluateFollowChoices(view);
  const withTen = choices.find(c =>
    c.cards.some(x => x.suit === 'H' && x.rank === 14) &&
    c.cards.some(x => x.suit === 'H' && x.rank === 10));
  const without = choices.find(c =>
    c.cards.some(x => x.suit === 'H' && x.rank === 14) &&
    !c.cards.some(x => x.suit === 'H' && x.rank === 10));
  assert.ok(withTen && without, '两种毙法都该在候选里');
  assert.ok(
    withTen.score > without.score - 60,
    `H14 已经压不倒了，带上主 10 一点风险没有，不该被当成「分牌暴露」重罚：` +
    `带 10 分 ${withTen.score.toFixed(0)}，不带 ${without.score.toFixed(0)}`
  );
});

// ---- 第三家 10 分要不要打 A 封：Glen 的第 2 种情况 ----
//
// 「如果此门副牌不长，但也不短，大概 5 张，没有出过件的情况，最好也是不杀，
//   风险一样，如果判断件有可能在自己对家，然后自己还有大牌，比如 Q 或是 J 多，
//   可以逼别人的件出来的情况，特别是别人可能只剩一件，逼出来之后，
//   别人的甩牌自己可能可以大，也可以杀。」
//
// 这一档以前是【故意没裁定】的（上面那条 5 分测试的注释里写着「10 分那档实测
// 仍然会打 ♠A，但那是封分，两笔账，没裁定的事不写成断言」）。现在裁定了：
// 这门一支件都没现过时，「封住最后一家」不构成亮出第一支件的理由。
//
// ⚠️ 这条挂在【整墩】上而不是候选上 —— 那 161 分的差距来自「垫小牌的候选被罚」，
// 不是「打 ♠A 被奖」。挂在候选上一点用没有（第一版就是这么写的）。
//
// 对手(1)领 ♠4，队友(0)跟 ♠10 —— 桌上 10 分，我是第三家，最后一家还没出。
function aceCoverView({ spades, partnerAsked }) {
  return followView({
    seat: 2, declarerSeat: 1,
    hand: [...spades.map((r, i) => T('S', r, i)),
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10))],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [T('S', 4, 90)] },
      { seat: 0, cards: [T('S', 10, 91)] },
    ],
    trickHistory: partnerAsked ? [{
      leadSeat: 0, leadSuit: 'S', winnerSeat: 1,
      plays: [
        { seat: 0, playSuit: 'S', cards: [T('S', 3, 80)] },   // 对家求过这门
        { seat: 1, playSuit: 'S', cards: [T('S', 7, 81)] },
        { seat: 2, playSuit: 'S', cards: [T('S', 5, 82)] },
        { seat: 3, playSuit: 'S', cards: [T('S', 8, 83)] },
      ],
    }] : [],
    piecesView: {
      S: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' }],
      D: [], C: [],
    },
  });
}

test('打A封：这门一支件都没现过 → 桌上 10 分也不杀', () => {
  const card = chooseFollowCards(aceCoverView({ spades: [14, 9, 6, 3], partnerAsked: false }))[0];
  assert.notEqual(card.rank, 14,
    `亮出这门第一支件 = 把甩牌资格从零推起来，比这 10 分重，却打了 ${card.suit}${card.rank}`);
});

test('打A封：对家求过这门，但我逼不出件（♠A 之下只有 9/6/3）→ 还是不杀', () => {
  const card = chooseFollowCards(aceCoverView({ spades: [14, 9, 6, 3], partnerAsked: true }))[0];
  assert.notEqual(card.rank, 14, '光知道件在对家没用，还得逼得动才值得亮');
});

test('打A封：对家求过 + 件逼出来后这门顶端还在我手上 → 可以杀', () => {
  const card = chooseFollowCards(aceCoverView({ spades: [14, 12, 11, 9], partnerAsked: true }))[0];
  assert.equal(card.rank, 14,
    '件在对家、逼出来之后 ♠Q 就是这门最大的，「别人的甩牌自己可能可以大」');
});

test('打A封：能逼件但读不出件在对家 → 两条要同时成立，不杀', () => {
  const card = chooseFollowCards(aceCoverView({ spades: [14, 12, 11, 9], partnerAsked: false }))[0];
  assert.notEqual(card.rank, 14, '谁都没在这门求过牌，件多半不在对家，逼出来是替对手凑资格');
});

// 缺门整手垫牌也一样：赢不下的位置不许挑最大的几张。
// 上面那条钉的是「跟了几张花色 + 凑张数」，这条钉的是「这门一张没有，整手垫」。
// 主牌只有 3 张、对手甩 4 张 —— 毙不了，怎么打都赢不下。
// 手上便宜的牌全是分牌，垫出去要按 candidatePoints × 14 罚，
// 于是「挑最大的几张」（小鬼 + 两张小主 + ♦10）反而只罚 keepValue × 0.25 —— 正是那个洞。
test('垫牌：缺门整手垫出去时，也不许拿鬼去凑张数', () => {
  const view = followView({
    seat: 2,
    hand: [T('JOKER', 15, 0), T('H', 4, 1), T('H', 3, 2),
      T('D', 5, 3), T('D', 5, 4), T('D', 5, 5), T('D', 10, 6)],
    currentTrick: [{
      seat: 1, playSuit: 'S',
      cards: [T('S', 14, 90), T('S', 14, 91), T('S', 13, 92), T('S', 12, 93)],
    }],
  });
  const cards = chooseFollowCards(view);
  assert.equal(
    cards.filter(c => c.rank === 15 || c.rank === 16).length, 0,
    `主牌不够毙、这一墩赢不下，鬼扔进去一分换不回来，却打了：${cards.map(c => `${c.suit}${c.rank}`).join(' ')}`
  );
});

// 一次性求件的第二个出口：第三家的约定贡献（partnerSideProtocolChoice，+700 加分）。
// 上面那条钉的是第二家的评分加成，这条走的是完全不同的代码路径。
function thirdSeatProbeView(repeatAsk) {
  return followView({
    seat: 2, declarerSeat: 1,
    hand: [T('S', 13, 0), T('S', 9, 1), T('S', 6, 2), T('S', 3, 3),
      ...Array.from({ length: 8 }, (_, i) => T('D', 12 - i, i + 10))],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [T('S', 4, 90)] },   // 队友求件
      { seat: 1, cards: [T('S', 7, 91)] },
    ],
    trickHistory: repeatAsk ? [{
      leadSeat: 0, leadSuit: 'S', winnerSeat: 2,
      plays: [
        { seat: 0, playSuit: 'S', cards: [T('S', 3, 80)] }, // 这门我方之前已经求过一次
        { seat: 1, playSuit: 'S', cards: [T('S', 7, 81)] },
        { seat: 2, playSuit: 'S', cards: [T('S', 14, 82)] },
        { seat: 3, playSuit: 'S', cards: [T('S', 8, 83)] },
      ],
    }] : [],
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      D: [], C: [],
    },
  });
}

test('求件应答：第三家 —— 首次求件照样贡献 ♠K', () => {
  assert.equal(chooseFollowCards(thirdSeatProbeView(false))[0].rank, 13);
});

test('求件应答：第三家 —— 这门我方已经求过一次，就不再贡献', () => {
  assert.notEqual(chooseFollowCards(thirdSeatProbeView(true))[0].rank, 13,
    '+700 的约定加分压得过一切亮件代价，正因如此它的触发条件必须严');
});

// 领牌那一侧：「回队友这门」的求件加成（+160）同样只认第一次。
// ⚠️ fixture 要卡在 400 和 560 之间才测得出来：
//   回门 320 + 求件 160 + 队友做庄 80 = 560（求件成立）/ 400（不成立）
//   自己那门够格求件 seek-piece = 450
// 所以梅花必须是【最长的门】—— 否则 develop-long-side-suit 的 360 会叠到方块上，
// 810 稳压回门，两种情况都选方块，什么也钉不住（第一版就栽在 ♣2 是级牌、
// 梅花实际只有 6 张、和方块打平这件事上）。
function returnSuitLeadView(repeatAsk, spadePiecesSeen = false) {
  const trick = (no, leadCard, mine, winner) => ({
    leadSeat: 0, leadSuit: 'S', winnerSeat: winner, trickNo: no,
    plays: [
      { seat: 0, playSuit: 'S', cards: [leadCard] },
      { seat: 1, cards: [T('S', 7, no * 10 + 1)] },
      { seat: 2, cards: [mine] },
      { seat: 3, cards: [T('S', 8, no * 10 + 3)] },
    ],
  });
  const history = [];
  if (repeatAsk) history.push(trick(1, T('S', 4, 80), T('S', 9, 82), 0));
  history.push(trick(2, T('S', 3, 84), T('S', 11, 86), 2));
  return leadView({
    mySeat: 2, declarerSeat: 0, trickHistory: history,
    hand: [
      ...[9, 8, 7, 6, 5, 4, 3].map((r, i) => T('C', r, i)),      // 梅花 7 张，最长
      ...[14, 13, 10, 9, 8, 7].map((r, i) => T('D', r, i + 10)), // 方块 6 张、两件在手
      ...[6, 5].map((r, i) => T('S', r, i + 20)),                // 队友那门还有牌
      ...[5, 4, 3].map((r, i) => T('H', r, i + 30)),
    ],
    piecesView: {
      S: [14, 14, 13, 13].map(rank => ({
        rank, status: spadePiecesSeen ? 'seen' : 'unseen',
      })),
      D: [{ rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' }],
      C: [14, 14, 13, 13].map(rank => ({ rank, status: 'unseen' })),
    },
  });
}

test('领牌：队友第一次求件 → 拿到牌权就把这门回过去', () => {
  assert.equal(chooseLeadCards(returnSuitLeadView(false))[0].suit, 'S');
});

// ⚠️ 这条断言【改过】，原来写的是「队友这门已经求过一次 → 不再当求件，
// 转去自己那门求件（期望 D）」。那是把「求件一次性」错套到了领牌这一侧。
// Glen 的裁定：求件这个意图跨墩有效，只要这门还有件没现身，就该接着帮他打
// ——「即使自己没件，也需要帮队友把别人的件逼出来，因为这个时候你并不知道
//    你的队友有多少支、对手有多少支，只能跟着打。」
// 一次性那条【只管贡献这一侧】（下面第三家/第二家那两条仍然钉着它）：
// 领牌是「帮他把件逼出来」，贡献是「把我的件交给他」，两回事。
test('领牌：队友求过件、这门的件还没逼完 → 接着帮他打这门（求了几次都一样）', () => {
  assert.equal(chooseLeadCards(returnSuitLeadView(true))[0].suit, 'S');
});

test('领牌：这门的件已经全现 → 逼件这件事了结，转去自己那门求件', () => {
  assert.equal(chooseLeadCards(returnSuitLeadView(true, true))[0].suit, 'D',
    '件都出来了就没什么可逼的了，接下来该甩或者去做自己的事');
});

test('打A封：打完这张这门只剩一张 → 压不住甩牌，不算「逼出来我可以大」', () => {
  const card = chooseFollowCards(aceCoverView({ spades: [14, 12], partnerAsked: true }))[0];
  assert.notEqual(card.rank, 14,
    '顶端再大，只剩一张也只压得住单张 —— 别拿这个当亮件的理由');
});

// Glen 第 2 条的正主：求件这个意图【跨墩有效】，而且【自己没件也要帮着逼】。
//   「假如我这门只有一支 ♠A，队友求件我交出去了，现在我手上一支件都没有、
//     但还有 ♠9 ♠7 ♠4 这些小牌 —— 这时候正该继续领这门（领 ♠4）
//     把对手的件逼出来。」
// 中间隔了两墩、队友最近领的是别的门，旧代码就把这次求件忘干净了：
// partnerRequest 只看队友【最近一次】领了什么。
function forgottenAskView(thirdSuit = 'S') {
  return leadView({
    mySeat: 2, declarerSeat: 0,
    hand: [
      ...[9, 7, 4].map((r, i) => T('S', r, i)),        // 件已经交给队友，只剩小牌
      ...[8, 7, 6, 5, 4, 3].map((r, i) => T('C', r, i + 10)),
      // ♦ 故意配成「一张 6~9 + 一张 ≤5」：求件走 lowestLead 出 ♦3，
      // 普通回门走 quietLead 会避开求件信号出 ♦9 —— 两者按点数分得开
      ...[9, 3].map((r, i) => T('D', r, i + 20)),
      ...[5, 4, 3].map((r, i) => T('H', r, i + 30)),
    ],
    trickHistory: [
      { // 第 1 墩：队友求件
        leadSeat: 0, leadSuit: 'S', winnerSeat: 1, trickNo: 1,
        plays: [{ seat: 0, playSuit: 'S', cards: [T('S', 4, 80)] },
                { seat: 1, cards: [T('S', 11, 81)] },
                { seat: 2, cards: [T('S', 14, 82)] },   // 我把唯一那支件交了出去
                { seat: 3, cards: [T('S', 8, 83)] }],
      },
      { // 第 2 墩：对手领梅花，队友吃下
        leadSeat: 1, leadSuit: 'C', winnerSeat: 0, trickNo: 2,
        plays: [{ seat: 1, playSuit: 'C', cards: [T('C', 12, 84)] },
                { seat: 2, cards: [T('C', 3, 85)] },
                { seat: 3, cards: [T('C', 9, 86)] },
                { seat: 0, cards: [T('C', 14, 87)] }],
      },
      // 第 3 墩：队友拿着牌权做的选择 —— 接着打黑桃，还是换门打方块
      thirdSuit === 'S'
        ? { leadSeat: 0, leadSuit: 'S', winnerSeat: 2, trickNo: 3,
            plays: [{ seat: 0, playSuit: 'S', cards: [T('S', 9, 88)] },
                    { seat: 1, cards: [T('S', 6, 89)] },
                    { seat: 2, cards: [T('S', 13, 90)] },
                    { seat: 3, cards: [T('S', 7, 91)] }] }
        : { leadSeat: 0, leadSuit: 'D', winnerSeat: 2, trickNo: 3,
            plays: [{ seat: 0, playSuit: 'D', cards: [T('D', 9, 88)] },
                    { seat: 1, cards: [T('D', 6, 89)] },
                    { seat: 2, cards: [T('D', 13, 90)] },
                    { seat: 3, cards: [T('D', 7, 91)] }] },
    ],
    piecesView: {
      S: [{ rank: 14, status: 'seen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' }],
      D: [14, 14, 13, 13].map(rank => ({ rank, status: 'unseen' })),
      C: [14, 14, 13, 13].map(rank => ({ rank, status: 'unseen' })),
    },
  });
}

// Glen 的两句话合起来才是完整的规则，缺一不可：
//   跨墩 —— 「即使自己没件，也需要帮队友把别人的件逼出来……只能跟着打」
//   换门作废 —— 「队友吃大然后打其它牌，证明他有其它计划，正常不应该帮他再逼件」
// 所以跨墩只在【同一门】里跨。下面两条就是这条规则的两侧。
//
// ⚠️ 这一对测试【改过】。c6543a2 只实现了跨墩那一半，于是「他第 3 墩换门」
// 也照样回去逼旧那门；Glen 裁定那是错的。同门跨墩这一半仍然要保住 ——
// 再往前那一版只看最近一领，他第 3 墩领 ♠9（不是求件）就把第 1 墩的 ♠4 忘了。
test('帮队友求：他第 3 墩还在打这门（只是不再是求件牌）→ 第 1 墩那次求件仍然算数', () => {
  const card = chooseLeadCards(forgottenAskView('S'))[0];
  assert.equal(card.suit, 'S');
  // ♠4 而不是 ♠7 才说明它算的是【求件】：求件走 lowestLead，普通回门走
  // quietLead（这门没甩牌欲望，会避开 ≤5 的求件信号，改出 ♠7）。
  assert.equal(card.rank, 4, `该领 ♠4 接着逼件，实际领了 ${card.suit}${card.rank}`);
});

test('帮队友求：他吃大之后改打方块 → 黑桃那次求件作废，跟着他的新计划走', () => {
  const card = chooseLeadCards(forgottenAskView('D'))[0];
  assert.equal(card.suit, 'D',
    `队友换门就是换了计划（也可能是暗求方块），实际领了 ${card.suit}${card.rank}`);
  // ♦9 而不是 ♦3：他第 3 墩领的 ♦9 不是求件牌，这一回就只是把牌权还给他这门，
  // 不该顺手替黑桃那次求件在方块上再喊一嗓子。
  assert.equal(card.rank, 9, `这不是求件，该走中性牌 ♦9（实际 ♦${card.rank}）`);
});

// 另一条停止条件：队友那门我【一张都不剩】了 —— 帮不上，就去打自己的牌。
// 件可能躺在底牌里永远等不到现身，光靠「还有件没现身」停不下来。
//
// ⚠️ 去掉 partnerRequest 开头那句 `cardsOfSuit(...).length === 0 → return null`，
// 它会返回一门我一张都没有的花色，lowestLead 拿到空数组返回 null，
// addProposal 当场抛异常。这条测试就是钉那一句（原来只有整场对局那条端到端
// 测试偶然踩到它，换个出牌轨迹就踩不到 —— 不能靠那种巧合）。
test('帮队友求：队友那门我已经打空了 → 帮不上，回去发展自己最长的副牌', () => {
  const view = forgottenAskView('S');
  view.you.hand = view.you.hand.filter(card => card.suit !== 'S'); // 黑桃全打完了
  const card = chooseLeadCards(view)[0];
  assert.equal(card.suit, 'C', `帮不上就该打自己 6 张的梅花（实际 ${card.suit}${card.rank}）`);
});
