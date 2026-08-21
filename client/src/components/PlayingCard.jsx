import { suitSymbol, suitRed, rankLabel } from '../utils.js';

const SIZES = {
  sm: { box: 'h-12 w-8', text: 'text-[11px]' },
  md: { box: 'h-16 w-11', text: 'text-sm' },
  lg: { box: 'h-20 w-14', text: 'text-base' },
  xl: { box: 'h-24 w-16', text: 'text-lg' },
};

// 潮汕功夫茶壶：大小鬼牌面中央的暗纹。
// 用 currentColor 跟着牌面主色走（大鬼红、小鬼墨），低透明度当水印。
// 绝对定位压在角标底下 —— 不参与布局，任何尺寸档都不会把角标挤开。
function TeapotMark({ className = '' }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className} fill="currentColor">
      {/* 壶钮 + 壶盖：连成一块，避免小尺寸下断成两个色点 */}
      <path d="M16 3.2a2.4 2.4 0 0 1 2.4 2.4c0 .5-.15.95-.4 1.33 2.6.62 4.8 1.94 6 3.65H8c1.2-1.71 3.4-3.03 6-3.65a2.4 2.4 0 0 1-.4-1.33A2.4 2.4 0 0 1 16 3.2Z" />
      {/* 壶身：厚实的梯形圆底，小尺寸也认得出是壶 */}
      <path d="M6.4 12.2h19.2c.9 0 1.6.82 1.44 1.7l-1.1 6.1A7.4 7.4 0 0 1 18.66 26h-5.32a7.4 7.4 0 0 1-7.28-6l-1.1-6.1c-.16-.88.54-1.7 1.44-1.7Z" />
      {/* 壶嘴：加粗成实心三角，不用细线 */}
      <path d="M6.6 13.4 1.4 10.2c-.86-.53-1.83.5-1.25 1.35l3.3 4.85Z" />
      {/* 壶把：加粗的 C 形 */}
      <path d="M26 13.1c3.1.72 4.85 2.6 4.4 4.75-.44 2.05-2.75 3.2-5.6 2.95l.42-2.9c1.35.1 2.2-.36 2.32-.92.12-.6-.5-1.2-2.05-1.55Z" />
    </svg>
  );
}

// 牌面（简化版）：点数和花色角标放在左上角与右下角两个对角（像真实扑克牌），
// 无论叠放时露出左侧还是右侧都能读到牌面。大小王统一称呼「大鬼」「小鬼」。
// 大小鬼另做区分：角标顶上加五角星、中央压潮汕茶壶暗纹，大鬼用红色、小鬼用墨色 ——
// 这两张牌是全场最大的牌，值得一眼认出来，不能和普通牌长一个样。
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
  const isJoker = suit === 'JOKER';
  const isBigJoker = isJoker && rank === 16;
  // 大鬼跟着红花色一起走红色；小鬼保持墨色，两张牌一眼能分开
  const red = suitRed(suit) || isBigJoker;
  const corner = (
    <div className={`flex flex-col items-center font-black leading-none ${dim.text} ${red ? 'text-rose-600' : 'text-zinc-800'}`}>
      {isJoker ? (
        // 用 em 相对字号：三行内容要塞进两个对角，任何尺寸档都不能顶到对面那个角标
        <>
          <span className="text-[0.5em] leading-none">★</span>
          <span className="text-[0.76em] leading-none">{isBigJoker ? '大' : '小'}</span>
          <span className="text-[0.76em] leading-none">鬼</span>
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
      {isJoker && (
        <TeapotMark
          className={`pointer-events-none absolute left-1/2 top-1/2 h-[52%] w-[52%] -translate-x-1/2 -translate-y-1/2 ${
            red ? 'text-rose-500/20' : 'text-zinc-700/18'
          }`}
        />
      )}
      <div className="absolute left-0.5 top-0.5">{corner}</div>
      <div className="absolute bottom-0.5 right-0.5 rotate-180">{corner}</div>
    </div>
  );
}
