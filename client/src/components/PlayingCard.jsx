import { suitSymbol, suitRed, rankLabel } from '../utils.js';

const SIZES = {
  sm: { box: 'h-12 w-8', text: 'text-[11px]' },
  md: { box: 'h-16 w-11', text: 'text-sm' },
  lg: { box: 'h-20 w-14', text: 'text-base' },
  xl: { box: 'h-24 w-16', text: 'text-lg' },
};

// 牌面（简化版）：点数和花色角标放在左上角与右下角两个对角（像真实扑克牌），
// 无论叠放时露出左侧还是右侧都能读到牌面。大小王统一称呼「大鬼」「小鬼」。
// suit/rank 为 null 时渲染牌背。
export function PlayingCard({
  suit,
  rank,
  faceUp = true,
  selected = false,
  size = 'md',
  className = '',
  onClick,
  onPointerDown,
}) {
  const dim = SIZES[size] ?? SIZES.md;
  if (!faceUp || suit == null || rank == null) {
    return (
      <div
        className={`card-back ${dim.box} rounded-lg ${className}`}
        onClick={onClick}
        onPointerDown={onPointerDown}
      />
    );
  }
  const red = suitRed(suit);
  const isJoker = suit === 'JOKER';
  const corner = (
    <div className={`flex flex-col items-center font-black leading-none ${dim.text} ${red ? 'text-rose-600' : 'text-zinc-800'}`}>
      {isJoker ? (
        <>
          <span>{rank === 16 ? '大' : '小'}</span>
          <span>鬼</span>
        </>
      ) : (
        <>
          <span>{rankLabel(rank)}</span>
          <span>{suitSymbol(suit)}</span>
        </>
      )}
    </div>
  );
  return (
    <div
      onClick={onClick}
      onPointerDown={onPointerDown}
      className={`card-face relative ${dim.box} select-none rounded-lg px-1 pt-0.5 shadow-md transition ${
        selected ? 'ring-2 ring-amber-300' : ''
      } ${className}`}
    >
      <div className="absolute left-0.5 top-0.5">{corner}</div>
      <div className="absolute bottom-0.5 right-0.5 rotate-180">{corner}</div>
    </div>
  );
}
