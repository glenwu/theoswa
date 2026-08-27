import { useEffect, useState } from 'react';

// 一个 matchMedia 订阅。布局算法要按屏幕形态换参数（不只是换 CSS 类），
// 纯 CSS 做不到，所以有几处需要在 JS 里拿到同一个判断。
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

// ⚠️ 下面两条必须和 styles.css 里 @custom-variant compact 的两条媒体查询【逐字对上】。
// CSS 那边负责换样式，这里负责换 DOM 结构（纯 CSS 做不到），对不上就会
// 一半紧凑一半不紧凑。
//
// 手机竖屏 + iPad 竖屏。
export const COMPACT_PORTRAIT = '(orientation: portrait) and (max-width: 1023px)';

// 手机横屏：宽够、但【高度不够】—— 这才是竖着堆牌桌/控制栏/手牌会糊成一团的原因。
// 用高度而不是宽度来判断：横过来的手机高度普遍在 320~430，iPad 横屏有 700+，
// 后者按原来的上下布局本来就好好的，不该被卷进来。
export const PHONE_LANDSCAPE = '(orientation: landscape) and (max-height: 520px)';

// 两者的并集 —— 和 styles.css 里 @custom-variant compact 是同一个意思。
// 有些地方光换类不够（要把整张牌换成一行文字），只能在 JS 里判断。
export const COMPACT = `${COMPACT_PORTRAIT}, ${PHONE_LANDSCAPE}`;
