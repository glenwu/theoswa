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
export const REVEAL_DRAW_MS = 3000;     // 揭牌倒计时：超时服务端自动摸牌
export const REVEAL_GRACE_MS = 3000;    // 100张摸完后的亮主宽限窗口
export const FALLBACK_REVEAL_MS = 800;  // 揭底定主：逐张翻底牌间隔
export const DEALING_MS = 600;          // 剩余牌一次性发完的展示停留
export const TRICK_SETTLE_MS = 1500;    // 一轮结束后收牌停留（服务端计时，四端同步）
export const SCORING_MS = 600;          // 局末结算展示停留
export const ROUND_END_MS = 3000;       // 本局小结面板停留，随后进入下一局准备
export const PLAY_TIMEOUT_MS = 60000;   // 出牌限时：超时服务端自动打出最小合法牌（宽松，可调）
export const RESET_PROPOSAL_MS = 60000; // 新开一局提案：60 秒无人响应自动取消
export const CROSS_RIVER_DECIDE_MS = 15000; // 三主过河：发起/跳过的决定窗口（无人发起则窗口结束自动继续）
export const CROSS_RIVER_PICK_MS = 30000;   // 三主过河：对家回 3 张副牌的超时（超时自动挑最小 3 张副牌）
export const AUTO_LAST_MS = 600;        // 最后一轮自动打出：每张牌之间的间隔（走完整动画，不闪跳）
// 管理员强制重置口令：带 ?RESET=<此值> 进入才启用。
// 公网部署务必改成只有四人知道的串：可用环境变量 ADMIN_RESET_TOKEN 覆盖（systemd 的 Environment= 里配），
// 或在源码里改这个默认值（默认 'Y' 仅供内网测试——公网 URL 人人可扫）。
export const ADMIN_RESET_TOKEN = process.env.ADMIN_RESET_TOKEN ?? 'Y';

export const SUIT_NAMES = Object.freeze({
  S: '黑桃',
  H: '红桃',
  D: '方块',
  C: '梅花',
});
