// 分清「被逼的」和「自己选的」：只有当候选里【确实存在一组不含鬼的合法牌】、
// 电脑却仍然把鬼垫进一手赢不下的牌里，才算判断问题。
// 用 mutate.mjs 同款的「内存存原文 + finally 还原」，不碰任何备份文件。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/bot-policy.js';
const src = fs.readFileSync(F, 'utf8');
const N = process.env.N ?? '400';
const restore = () => fs.writeFileSync(F, src);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const OLD = `  return choices
    .sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id)
    )[0].cards;
}`;
const NEW = `  const __ranked = choices
    .sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id)
    );
  const __pick = __ranked[0];
  const __jk = c => c.rank === 15 || c.rank === 16;
  if (__pick && __pick.cards.some(__jk) && __pick.provisionalLeaderSeat !== view.you.seat) {
    const n = lead.cards.length;
    const suited = __pick.cards.filter(c => suitOf(c, ctx) === lead.playSuit).length;
    const trumps = __pick.cards.filter(c => suitOf(c, ctx) === 'TRUMP').length;
    if (suited !== n && trumps !== n) {
      const alt = __ranked.filter(p => !p.cards.some(__jk));
      // 「被逼的」直接从手牌算，不依赖候选生成器：
      // 必须先跟满这门（不够就全出），剩下的张数只要还有足够的非鬼牌就不算被逼。
      const mine = cardsOfSuit(view.you.hand, lead.playSuit, ctx);
      const must = Math.min(mine.length, n);
      const rest = view.you.hand.filter(c => !mine.includes(c));
      const restNoJoker = rest.filter(c => !__jk(c)).length;
      const forced = restNoJoker < n - must;
      console.error('JD ' + JSON.stringify({
        n, suited, hand: view.you.hand.length,
        kinds: __pick.cards.map(c => c.rank === 16 ? '大鬼' : c.rank === 15 ? '小鬼' : c.rank),
        alts: alt.length, forced,
        gap: alt.length ? Math.round(__pick.score - alt[0].score) : null,
        altKinds: alt.length ? alt[0].cards.map(c => c.rank) : null,
      }));
    }
  }
  return __pick.cards;
}`;

try {
  if (!src.includes(OLD)) throw new Error('锚点没对上，脚本需要跟着源码更新');
  fs.writeFileSync(F, src.replace(OLD, NEW));
  const out = execFileSync('node', ['scripts/audit/joker-discard.mjs'], {
    env: { ...process.env, N }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(out);
} catch (err) {
  process.stderr.write(String(err.stderr ?? err.message ?? err));
} finally {
  restore();
}
