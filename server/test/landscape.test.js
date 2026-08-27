import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const panel = readFileSync(path.join(root, 'client/src/components/TablePanel.jsx'), 'utf8');
const player = readFileSync(path.join(root, 'client/src/components/PlayerPanel.jsx'), 'utf8');
const media = readFileSync(path.join(root, 'client/src/useMedia.js'), 'utf8');

// 手机横屏那套版式把左右两个 aside 让出去了（它们本来就被 md:/lg: 断点藏着）。
// 「场上已打出 + 件」和那五个功能按钮是打牌时一直要用的，横屏分支必须自己补回来 ——
// 漏掉的话界面不报错，只是那些信息在横屏下彻底消失，很难被发现。
test('手机横屏：分支里必须补回「已打出/件」面板，且不重复放功能按钮', () => {
  const branch = panel.slice(panel.indexOf('if (phoneLandscape) {'), panel.indexOf('const controls ='));
  const start = panel.indexOf('if (phoneLandscape) {');
  assert.ok(start > 0, '找不到手机横屏分支');
  const body = panel.slice(start, start + 1600);
  assert.ok(body.includes('<MyDetails'), '横屏分支没有渲染「场上已打出 + 件」面板');
  // ⚠️ 这里原来还要求渲染 <PanelToolbar/>（那五个功能按钮）。Glen 看到实机之后
  // 改口：「5 个在出牌按钮上方的功能键也取消吧，重复了，还占地」——
  // 👥 抽屉里的玩家面板底部本来就有同一组。所以断言反过来：不许再放一份。
  assert.ok(!body.includes('<PanelToolbar'), '横屏分支又放了一份重复的功能按钮');
  assert.ok(body.includes('{controls}'), '横屏分支没有渲染控制栏');
  assert.ok(body.includes('{hand}'), '横屏分支没有渲染手牌区');
  assert.ok(body.includes('{table}'), '横屏分支没有渲染牌桌');
  assert.ok(branch !== undefined);
});

// 两块都得是导出的，横屏分支才拿得到。
test('手机横屏：MyDetails 和 PanelToolbar 必须是导出的', () => {
  assert.ok(/export function MyDetails\b/.test(player), 'MyDetails 没有导出');
  assert.ok(/export function PanelToolbar\b/.test(player), 'PanelToolbar 没有导出');
});

// 判据要用【高度】不是宽度：横过来的手机高 320~430，iPad 横屏有 700+，
// 后者按原来的上下布局本来就好好的，不该被卷进这套紧凑版式。
test('手机横屏：断点按高度判定，且把 iPad 横屏排除在外', () => {
  const m = /PHONE_LANDSCAPE = '([^']+)'/.exec(media);
  assert.ok(m, '找不到 PHONE_LANDSCAPE');
  assert.ok(m[1].includes('orientation: landscape'), '没有限定横屏');
  const h = /max-height:\s*(\d+)px/.exec(m[1]);
  assert.ok(h, '没有用高度做判据');
  assert.ok(Number(h[1]) <= 600, `高度门槛 ${h[1]}px 太宽松，iPad 横屏会被卷进来`);
});

// ⚠️ 这条是踩过的坑：手机横过来【宽度】有 800~950，md:(768) 甚至 lg:(1024) 这些
// 断点会把它当成桌面 —— 左栏玩家列表直接铺在牌桌旁边（Glen：「左边那个状态显示
// 要关掉，和竖屏一样」），而 ControlBar 里的 👥 浮层开关（md:hidden）反倒被藏了，
// 两头都错。横屏这一档必须由【高度】判据统一接管，不能只靠宽度断点。
test('手机横屏：两个 aside 必须由高度判据收起，不能只靠宽度断点', () => {
  const app = readFileSync(path.join(root, 'client/src/App.jsx'), 'utf8');
  assert.ok(app.includes('PHONE_LANDSCAPE'), 'App 没有引入横屏判据');
  const asides = [...app.matchAll(/<aside[\s\S]{0,120}?>/g)].map(m => m[0]);
  assert.equal(asides.length, 2, `期望正好两个 aside（玩家列表 / 聊天），实际 ${asides.length}`);
  for (const aside of asides) {
    const at = app.indexOf(aside);
    const before = app.slice(Math.max(0, at - 200), at);
    assert.ok(
      before.includes('!phoneLandscape'),
      `这个 aside 没有被横屏判据收起：${aside.slice(0, 60)}…`
    );
  }
});

// 左栏收起来了，浮层开关就必须留着 —— 否则玩家列表在横屏下彻底没有入口。
test('手机横屏：浮层开关不能被宽度断点藏掉', () => {
  const panel2 = readFileSync(path.join(root, 'client/src/components/TablePanel.jsx'), 'utf8');
  for (const [cls, name] of [['md:hidden', '👥 玩家列表'], ['lg:hidden', '💬 聊天']]) {
    const re = new RegExp(`btn-float-sm[^\`]*\\$\\{compact \\? '' : '${cls}'\\}`);
    assert.ok(re.test(panel2), `${name} 的浮层开关还写死着 ${cls}，横屏下会连开关一起消失`);
  }
});

// 五个功能按钮（📖 规则 / 🕘 历史 / 🎨 配色 / 🔄 新开一局 / ⏸ 暂停）—— Glen 点名要这五个。
// ⛔ 是管理员专用的第六个，不算在内。
test('功能按钮：常驻的正好是那五个', () => {
  const start = player.indexOf('export function PanelToolbar');
  // 只取到管理员那颗 ⛔ 之前 —— 它是第六个，且只有管理员看得到
  const body = player.slice(start, player.indexOf('{game.you.isAdmin', start));
  const icons = [...body.matchAll(/>\s*([\u{1F300}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FA}])\s*</gu)].map(x => x[1]);
  assert.deepEqual(icons, ['📖', '🕘', '🎨', '🔄', '⏸'], `实际是 ${icons.join('')}`);
});
