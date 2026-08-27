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

// 手机竖屏 + iPad 竖屏：和 CSS 里的 portrait:max-lg: 断点保持一致。
export const COMPACT_PORTRAIT = '(orientation: portrait) and (max-width: 1023px)';

// 手机横屏：宽够、但【高度不够】—— 这才是竖着堆牌桌/控制栏/手牌会糊成一团的原因。
// 用高度而不是宽度来判断：横过来的手机高度普遍在 320~430，iPad 横屏有 700+，
// 后者按原来的上下布局本来就好好的，不该被卷进来。
export const PHONE_LANDSCAPE = '(orientation: landscape) and (max-height: 520px)';
