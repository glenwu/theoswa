// 全局常量：玩家身份、阶段、快捷短语（唯一真源）

export const PLAYERS = Object.freeze([
  { id: 'T', nickname: '勝' },
  { id: 'H', nickname: '麤' },
  { id: 'B', nickname: '半仙' },
  { id: 'M', nickname: '旻' },
]);

export const PLAYER_IDS = Object.freeze(PLAYERS.map(p => p.id));

export const PHASES = Object.freeze([
  'SEATING',        // 换座 + 确认座位（仅游戏开始一次）
  'READY_CHECK',    // 每局开始前全员准备（含流局后）
  'REVEAL_FIRST',   // 仅庄家未定时：抢按揭牌人 + 翻牌定起揭人（翻牌流程阶段2接入）
  'REVEALING',      // 揭牌定主
  'FALLBACK_TRUMP', // 庄家已定且无人亮牌：揭底牌定主
  'DEALING',        // 剩余牌一次性发完
  'KITTY_EXCHANGE', // 庄家换底
  'CROSS_RIVER',    // 三主过河（主牌 ≤3 者可发起，无人符合自动跳过）
  'PLAYING',        // 出牌
  'DOMINANCE',      // 碾压收尾：充分条件命中，摊开四家剩余手牌待确认（confirmDominance 后结算）
  'SCORING',        // 局末结算
  'ROUND_END',      // 本局小结
  'GAME_OVER',
]);

export const QUICK_PHRASES = Object.freeze({
  langxian: '浪险',
  mengmeng: '猛猛呐',
  nieyige: '捏一个吉',
  maiLanghua: '迈浪话',
  sanpu: '散谱母落',
});

export const PLAYER_COUNT = 4;
export const HAND_SIZE = 25;
export const KITTY_SIZE = 8;
export const REVEAL_TOTAL = 100;       // 4 × 25

// 阶段节奏（毫秒，可用环境变量覆盖，便于测试与冒烟）
export const REVEAL_FLIP_MS = 800;      // 翻牌定起揭人：每次翻牌间隔
// 翻牌定出起揭人之后的停留：这一下决定了整局从谁开始揭，
// 四个人都得看清「翻的是什么牌、点数怎么换算、轮到谁」。原来定完立刻开揭，根本来不及看。
// 四人都点「知道了」可提前开始。
export const FLIP_HOLD_MS = 10000;
export const REVEAL_DRAW_MS = 3000;     // 揭牌倒计时：超时服务端自动摸牌
export const REVEAL_GRACE_MS = 3000;    // 100张摸完后的亮主宽限窗口
export const FALLBACK_REVEAL_MS = 800;  // 揭底定主：逐张翻底牌间隔
export const DEALING_MS = 600;          // 剩余牌一次性发完的展示停留
export const TRICK_SETTLE_MS = 1500;    // 一轮结束后收牌停留（服务端计时，四端同步）
export const SCORING_MS = 600;          // 局末结算展示停留
// 本局小结停留：给四个人复盘的时间（看得分构成、看底牌、回顾这局怎么赢/怎么输）。
// 四人都点「看完了」可提前进入下一局；没点满就等满这 100 秒。
export const ROUND_END_MS = 100000;
export const PLAY_TIMEOUT_MS = 60000;   // 出牌限时：超时服务端自动打出最小合法牌（宽松，可调）
export const RESET_PROPOSAL_MS = 60000; // 新开一局提案：60 秒无人响应自动取消
export const CROSS_RIVER_DECIDE_MS = 15000; // 三主过河：发起/跳过的决定窗口（无人发起则窗口结束自动继续）
export const CROSS_RIVER_PICK_MS = 30000;   // 三主过河：对家回 3 张副牌的超时（超时自动挑最小 3 张副牌）
export const AUTO_LAST_MS = 600;        // 最后一轮自动打出：每张牌之间的间隔（走完整动画，不闪跳）

// 阶段节奏的唯一出口：环境变量覆盖，缺省一律取上面的常量。
// ⚠️ 绝不要在 index.js 或别处再写一遍这些数字。
// 曾经 index.js 自带一份 `process.env.X ?? <字面量>`，改了上面的常量却不生效 ——
// 单测断言常量本身没问题，跑起来的服务端却还用着旧值，极难发现。
export function timingsFromEnv(env = process.env) {
  const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
  return {
    flipMs: num(env.FLIP_MS, REVEAL_FLIP_MS),
    flipHoldMs: num(env.FLIP_HOLD_MS, FLIP_HOLD_MS),
    drawMs: num(env.DRAW_MS, REVEAL_DRAW_MS),
    graceMs: num(env.GRACE_MS, REVEAL_GRACE_MS),
    fallbackMs: num(env.FALLBACK_MS, FALLBACK_REVEAL_MS),
    dealingMs: num(env.DEALING_MS, DEALING_MS),
    settleMs: num(env.SETTLE_MS, TRICK_SETTLE_MS),
    scoringMs: num(env.SCORING_MS, SCORING_MS),
    roundEndMs: num(env.ROUND_END_MS, ROUND_END_MS),
    playMs: num(env.PLAY_MS, PLAY_TIMEOUT_MS),
    resetProposalMs: num(env.RESET_PROPOSAL_MS, RESET_PROPOSAL_MS),
    crossRiverDecideMs: num(env.CROSS_RIVER_MS, CROSS_RIVER_DECIDE_MS),
    crossRiverPickMs: num(env.CROSS_PICK_MS, CROSS_RIVER_PICK_MS),
    autoLastMs: num(env.LAST_MS, AUTO_LAST_MS),
  };
}

export const SUIT_NAMES = Object.freeze({
  S: '黑桃',
  H: '红桃',
  D: '方块',
  C: '梅花',
});
