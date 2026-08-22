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

// 被大鬼压制的那一家的彩蛋：按【顺序】独立掷骰，命中即停 —— 一次压制最多弹一句。
// 注意不是「三选一按权重抽」：三次都是独立事件，总触发率
// 0.2 + 0.8×0.3 + 0.8×0.7×0.3 ≈ 60.8%，而不是 80%。
export const SUPPRESSED_EGGS = Object.freeze([
  { id: 'nieyige', text: '捏一个吉', chance: 0.2 },
  { id: 'puyiayi', text: '谱依阿姨', chance: 0.3 },
  { id: 'xiaodaoxia', text: '小到下', chance: 0.3 },
]);

// random 必须是彩蛋专用随机源（state.niiRandom），绝不能用发牌 rng ——
// 掷骰会推进 RNG 状态，SEED=42 就复现不出同一副牌（验收用例 §10-52）。
export function rollSuppressedEgg(random) {
  for (const egg of SUPPRESSED_EGGS) {
    if (random() < egg.chance) return egg.text;
  }
  return null;
}

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
// 庄家换底限时：超时服务端替他埋 8 张（用电脑挑底牌那套算法）。
// ⚠️ 这里原本没有任何兜底，是全局唯一漏掉的「等一个人」的阶段：
// 庄家临时走开或掉线，四个人就一起卡到天荒地老 —— 掉线不会转电脑，
// 出牌都有 60 秒自动打，唯独换底没有，只能靠全票「新开一局」把整局作废。
// 给得比出牌宽松得多：换底要看 33 张牌、想清楚埋哪 8 张，本来就慢。
export const KITTY_EXCHANGE_MS = 180000;
// 碾压收尾确认限时：任一家点确认即可推进（电脑会自动点），
// 但四个真人全挂机时同样没人推得动，而那时四家手牌正摊开着。
export const DOMINANCE_MS = 30000;
export const RESET_PROPOSAL_MS = 60000; // 新开一局提案：60 秒无人响应自动取消
export const CROSS_RIVER_DECIDE_MS = 15000; // 三主过河：发起/跳过的决定窗口（无人发起则窗口结束自动继续）
export const CROSS_RIVER_PICK_MS = 30000;   // 三主过河：对家回 3 张副牌的超时（超时自动挑最小 3 张副牌）
export const AUTO_LAST_MS = 600;        // 最后一轮自动打出：每张牌之间的间隔（走完整动画，不闪跳）

// 阶段节奏的唯一真源。
// ⚠️ 绝不要在 index.js / state.js 或别处再抄一份这些数字或这份键表。
// 踩过两次：
//   1. index.js 自带一份 `process.env.X ?? <字面量>`，改了常量却不生效；
//   2. state.js 的 createInitialState 手抄了一份 timing 默认值 —— 新增
//      kittyExchangeMs 后忘了同步，于是 t.kittyExchangeMs === undefined，
//      `now + undefined` = NaN，setTimeout(NaN) 立刻触发，换底一进去就被自动埋了。
// 现在默认值只有 DEFAULT_TIMINGS 一份，环境变量名只有 TIMING_ENV_KEYS 一份，
// 两者键集合相同（有测试钉住），加新节奏时改这里就够了。
export const DEFAULT_TIMINGS = Object.freeze({
  flipMs: REVEAL_FLIP_MS,
  flipHoldMs: FLIP_HOLD_MS,
  drawMs: REVEAL_DRAW_MS,
  graceMs: REVEAL_GRACE_MS,
  fallbackMs: FALLBACK_REVEAL_MS,
  dealingMs: DEALING_MS,
  settleMs: TRICK_SETTLE_MS,
  scoringMs: SCORING_MS,
  roundEndMs: ROUND_END_MS,
  playMs: PLAY_TIMEOUT_MS,
  kittyExchangeMs: KITTY_EXCHANGE_MS,
  dominanceMs: DOMINANCE_MS,
  resetProposalMs: RESET_PROPOSAL_MS,
  crossRiverDecideMs: CROSS_RIVER_DECIDE_MS,
  crossRiverPickMs: CROSS_RIVER_PICK_MS,
  autoLastMs: AUTO_LAST_MS,
});

export const TIMING_ENV_KEYS = Object.freeze({
  flipMs: 'FLIP_MS',
  flipHoldMs: 'FLIP_HOLD_MS',
  drawMs: 'DRAW_MS',
  graceMs: 'GRACE_MS',
  fallbackMs: 'FALLBACK_MS',
  dealingMs: 'DEALING_MS',
  settleMs: 'SETTLE_MS',
  scoringMs: 'SCORING_MS',
  roundEndMs: 'ROUND_END_MS',
  playMs: 'PLAY_MS',
  kittyExchangeMs: 'KITTY_MS',
  dominanceMs: 'DOMINANCE_MS',
  resetProposalMs: 'RESET_PROPOSAL_MS',
  crossRiverDecideMs: 'CROSS_RIVER_MS',
  crossRiverPickMs: 'CROSS_PICK_MS',
  autoLastMs: 'LAST_MS',
});

export function timingsFromEnv(env = process.env) {
  const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_TIMINGS)) {
    out[key] = num(env[TIMING_ENV_KEYS[key]], fallback);
  }
  return out;
}

export const SUIT_NAMES = Object.freeze({
  S: '黑桃',
  H: '红桃',
  D: '方块',
  C: '梅花',
});
