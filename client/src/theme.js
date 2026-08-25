// 配色方案（Glen：「有没其它配色的方案，可以让玩家自行更换」）。
//
// 换肤【只动氛围色】—— body 渐变、牌桌聚光、牌背、felt 令牌这四处占了整屏
// 绝大部分面积。金色强调色（按钮、庄家标记、倒计时）四套里保持一致：那是这个
// 游戏的识别色，跟着换会让每套都像另一个应用，而且满屏的 amber/emerald/rose
// 工具类本来也不受令牌控制，只换一半反而更花。
//
// swatch 是给选择界面看的三个点：底色 / 聚光 / 强调。
export const THEMES = [
  { id: 'purple',  name: '夜紫',   desc: '默认，深紫聚光', swatch: ['#241b45', '#7a60d2', '#fbbf24'] },
  { id: 'green',   name: '墨绿',   desc: '老牌桌的绿绒',   swatch: ['#0c2e22', '#2e8c62', '#fbbf24'] },
  { id: 'navy',    name: '深海',   desc: '静一点的深蓝',   swatch: ['#0c2242', '#3a78c8', '#fbbf24'] },
  { id: 'crimson', name: '酒红',   desc: '暖一点的暗红',   swatch: ['#3a0f1c', '#af4155', '#fbbf24'] },
];

export const DEFAULT_THEME = 'purple';
const KEY = 'chaoshan.theme';

export function isTheme(id) {
  return THEMES.some(t => t.id === id);
}

// 读存下来的选择。存的是别人写的值（localStorage 谁都能改），所以一律校验，
// 认不出来就回默认 —— 否则 data-theme 挂上一个没有对应规则的值，整屏变成裸色。
export function loadTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    return isTheme(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // 隐私模式下 localStorage 会抛
  }
}

export function applyTheme(id) {
  const theme = isTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* 存不下就只在本次会话生效，不影响使用 */
  }
  return theme;
}
