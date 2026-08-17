// 花色与点数的展示映射（纯展示，不含游戏规则；规则判定只在服务端纯函数里）

export const SUIT_INFO = {
  S: { symbol: '♠', red: false, name: '黑桃' },
  H: { symbol: '♥', red: true, name: '红桃' },
  D: { symbol: '♦', red: true, name: '方块' },
  C: { symbol: '♣', red: false, name: '梅花' },
};

export function suitSymbol(suit) {
  if (!suit) return '?';
  if (suit === 'JOKER') return '王';
  return SUIT_INFO[suit].symbol;
}

export function suitRed(suit) {
  return !!suit && suit !== 'JOKER' && SUIT_INFO[suit].red;
}

// rank: 3~10 点数，11=J 12=Q 13=K 14=A 15=小鬼 16=大鬼
export function rankLabel(rank) {
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  if (rank === 14) return 'A';
  if (rank === 15) return '小鬼';
  if (rank === 16) return '大鬼';
  return String(rank);
}

// 牌的展示标签：如 “♠K” “大鬼”
export function cardLabel(card) {
  if (!card) return '';
  if (card.suit === 'JOKER') return card.rank === 16 ? '大鬼' : '小鬼';
  return `${SUIT_INFO[card.suit]?.symbol ?? ''}${rankLabel(card.rank)}`;
}

// 级别序列：0=打2 … 12=打A，13=第二圈的2，≥14=获胜
const LEVEL_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export function levelLabel(levelIndex) {
  if (levelIndex >= 14) return '获胜';
  if (levelIndex === 13) return '2·二圈';
  return LEVEL_NAMES[levelIndex];
}

export const PLAYER_EMOJI = { T: '🐯', H: '🐂', B: '🐒', M: '🐴' };

export const TEAM_COLORS = {
  0: { name: '金', border: 'border-amber-400/70', text: 'text-amber-300', bg: 'bg-amber-400/15', glow: 'shadow-amber-400/40' },
  1: { name: '青', border: 'border-sky-400/70', text: 'text-sky-300', bg: 'bg-sky-400/15', glow: 'shadow-sky-400/40' },
};
