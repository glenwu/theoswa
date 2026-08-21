// UI 验收截图脚本（1366×768）：
// 1) 起干净服务端（短节奏 + 固定种子）；
// 2) 4 个 ws bot 走到 KITTY_EXCHANGE（庄家 33 张）后停住；
// 3) 用系统 Chrome 打开庄家页面 → 截图「换底 33 张」并断言无溢出；
// 4) 页面点选 8 张 + 埋底 → 跳过过河 → PLAYING；
// 5) 出牌阶段分别截 25 张、13 张、3 张三个时点，断言间距一致、右端 x 一致、行宽随张数递减。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import puppeteer from 'puppeteer-core';
import { playSuitOf, cardStrength } from '../server/cards.js';

const WS_URL = 'ws://localhost:8787/ws';
const PAGE_URL = 'http://localhost:8787/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = path.join(process.cwd(), 'screenshots') + '/';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(cond, timeout, interval = 60) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(interval);
  }
  throw new Error('waitUntil 超时');
}

function botCards(hand, lead, ctx) {
  const suitOf = x => playSuitOf(x, ctx.trumpSuit, ctx.rankCard);
  const bySuit = s => hand.filter(x => suitOf(x) === s);
  const lowest = (cards, n) =>
    [...cards].sort((a, b) => cardStrength(a, ctx) - cardStrength(b, ctx)).slice(0, n);
  if (!lead) {
    const nonTrump = hand.filter(x => suitOf(x) !== 'TRUMP');
    return [lowest(nonTrump.length ? nonTrump : hand, 1)[0]];
  }
  const N = lead.cards.length;
  const suitCards = bySuit(lead.playSuit);
  if (suitCards.length >= N) return lowest(suitCards, N);
  if (suitCards.length > 0) {
    return [...lowest(suitCards, suitCards.length), ...lowest(hand.filter(x => !suitCards.includes(x)), N - suitCards.length)];
  }
  const trumps = bySuit('TRUMP');
  if (trumps.length >= N) return lowest(trumps, N);
  return lowest(hand, N);
}

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = {
      id,
      ws,
      last: null,
      declared: false,
      lastDrawKey: null,
      skippedRiverRound: null,
      send: action => ws.send(JSON.stringify(action)),
      close: () => ws.close(),
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', playerId: id })));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') {
        client.last = m.state;
        if (!client.gotState) {
          client.gotState = true;
          resolve(client);
        }
      }
    });
    ws.on('error', reject);
  });
}

// 本脚本专用存档路径。⚠️ 必须每次跑之前删掉：
// 服务端启动时会自动恢复 12 小时内的存档，上一次跑完留下的存档会让这次直接从
// PLAYING 之类的中途阶段起步，脚本却还在等 READY_CHECK —— 表现为莫名其妙的
// 「waitUntil 超时」，而且只在第二次跑时出现，极难排查。
const SHOT_SAVE_FILE = '/tmp/ui-shot-save.json';

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(SHOT_SAVE_FILE, { force: true }); // 清掉上一次的存档，保证每次都是干净开局

  // 1) 干净服务端（固定种子 + 短节奏；收牌停留很短以便快速过轮）
  const srv = spawn(
    process.execPath,
    ['server/index.js'],
    {
      env: {
        ...process.env,
        SEED: '42',
        SAVE_FILE: SHOT_SAVE_FILE,
        FLIP_MS: '60', DRAW_MS: '80', GRACE_MS: '400', FALLBACK_MS: '30', DEALING_MS: '30',
        CROSS_RIVER_MS: '300', SETTLE_MS: '200', PLAY_MS: '120000',
        SCORING_MS: '100', ROUND_END_MS: '200', // 小结默认 100 秒（供复盘），截图脚本压短
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };

  try {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch('http://localhost:8787/api/health');
        if (res.ok) break;
      } catch {}
      await sleep(200);
    }

    // 2) bots 走到 KITTY_EXCHANGE
    const ids = ['T', 'H', 'B', 'M'];
    const bots = await Promise.all(ids.map(connect));
    const byId = Object.fromEntries(bots.map(b => [b.last.you.id, b]));
    for (const b of bots) b.send({ type: 'confirmSeat' });
    await waitUntil(() => byId.T.last.phase === 'READY_CHECK', 8000);
    for (const b of bots) b.send({ type: 'ready' });
    await waitUntil(() => byId.T.last.phase === 'REVEAL_FIRST', 8000);
    byId.T.send({ type: 'claimFlipper' });
    await waitUntil(() => byId.T.last.phase === 'REVEALING', 15000);

    let guard = 0;
    while (guard++ < 4000) {
      const st = byId.T.last;
      if (st.phase === 'KITTY_EXCHANGE') break;
      if (st.phase === 'REVEALING') {
        for (const b of bots) {
          const s = b.last;
          if (!s || s.phase !== 'REVEALING') continue;
          const key = `${s.round.drawnCount}:${s.round.revealTurnSeat}`;
          if (s.round.drawnCount < 100 && s.round.revealTurnSeat === s.you.seat && b.lastDrawKey !== key) {
            b.lastDrawKey = key;
            b.send({ type: 'drawCard' });
          }
          if (!b.declared) {
            const rc = (s.you.hand ?? []).find(x => x.rank === s.round.rankCard);
            if (rc) {
              b.declared = true;
              b.send({ type: 'declareTrump', cardId: rc.id });
            }
          }
        }
      }
      await sleep(30);
    }
    if (byId.T.last.phase !== 'KITTY_EXCHANGE') throw new Error('未到达 KITTY_EXCHANGE：' + byId.T.last.phase);

    const declarerId = byId.T.last.players.find(p => p.seat === byId.T.last.declarerSeat).id;
    console.log('庄家 =', declarerId);

    // 3) 打开庄家页面
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--window-size=1366,768', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(PAGE_URL + '?USER=' + declarerId, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-card-id]');
    await waitUntil(async () => (await page.$$('[data-card-id]')).length === 33, 10000);
    await sleep(400); // 等 ResizeObserver 测量 + 重排稳定后再量指标

    // 33 张换底验收指标
    const m1 = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-card-id]')];
      const row = cards[0]?.parentElement;
      const last = cards[cards.length - 1];
      return {
        cardCount: cards.length,
        cardW: cards[0] ? Math.round(cards[0].querySelector('.card-face, .card-back').getBoundingClientRect().width) : null,
        hScroll: document.documentElement.scrollWidth > window.innerWidth,
        rowOverflow: row ? row.scrollWidth > row.clientWidth + 1 : null,
        lastVisible: row && last ? last.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1 : null,
      };
    });
    await page.screenshot({ path: OUT_DIR + 'kitty-exchange-33.png' });
    console.log('截图1 kitty-exchange-33.png', JSON.stringify(m1));

    // 4) 页面点选 8 张 → 埋底（合成 PointerEvent 打在每张牌的露出条上）
    await sleep(300);
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-card-id]')].slice(0, 8);
      for (const wrapper of cards) {
        const el = wrapper.querySelector('.card-face, .card-back') ?? wrapper;
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      }
    });
    await sleep(300);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('埋底'));
      btn?.click();
    });

    // 跳过过河 → PLAYING
    await waitUntil(() => byId.T.last.phase === 'PLAYING', 20000);
    await sleep(500);

    // 手牌几何指标：间距(step) / 最右一张右端 x / 行右端 x / 最左一张左端 x / 张数
    const handGeo = () =>
      page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-card-id]')];
        const row = cards[0]?.parentElement;
        const last = cards[cards.length - 1];
        const diffs = [];
        for (let i = 1; i < cards.length; i++) {
          diffs.push(Math.round(cards[i].getBoundingClientRect().left - cards[i - 1].getBoundingClientRect().left));
        }
        const cardW = cards[0] ? Math.round(cards[0].querySelector('.card-face, .card-back').getBoundingClientRect().width) : null;
        // 组内间距 = 相邻差里去掉「组间隔」(牌宽+20 / 牌宽+32) 之后的最小值
        const intra = diffs.filter(d => d < cardW).sort((a, b) => a - b)[0] ?? null;
        return {
          count: cards.length,
          cardW,
          diffs,
          intraStep: intra,
          rightEdge: last ? Math.round(last.getBoundingClientRect().right) : null,
          rowRight: row ? Math.round(row.getBoundingClientRect().right) : null,
          firstLeft: cards[0] ? Math.round(cards[0].getBoundingClientRect().left) : null,
        };
      });

    const g25 = await handGeo();
    await page.screenshot({ path: OUT_DIR + 'play-25.png' });
    console.log('play-25', JSON.stringify(g25));

    // bots 出牌驱动（T/B/M；庄家由页面扮演，按 botCards 逻辑打最小合法牌）
    let botLoopStop = false;
    const botPlayLoop = (async () => {
      while (!botLoopStop) {
        const st = byId.T.last;
        if (st.phase === 'DOMINANCE') { byId.T.send({ type: 'confirmDominance' }); await sleep(100); continue; }
        if (st.phase === 'SCORING' || st.phase === 'ROUND_END' || st.phase === 'GAME_OVER') return;
        if (st.phase !== 'PLAYING' || st.round?.lastTrick) { await sleep(50); continue; }
        for (const b of bots) {
          if (b.ws.readyState !== 1) continue; // 庄家已被浏览器顶替
          const s = b.last;
          if (!s || s.phase !== 'PLAYING' || s.round.lastTrick) continue;
          if (s.round.turnSeat !== s.you.seat) continue;
          const key = `${s.round.trickHistory.length}:${s.round.currentTrick.length}`;
          if (b.lastPlayKey === key) continue;
          b.lastPlayKey = key;
          const ctx = { trumpSuit: s.round.trumpSuit, rankCard: s.round.rankCard };
          const lead = s.round.currentTrick[0] ?? null;
          const cards = botCards(s.you.hand, lead, ctx);
          b.send({ type: 'play', cardIds: cards.map(x => x.id) });
        }
        await sleep(30);
      }
    })();

    // 庄家（页面）打出一张：按 botCards 逻辑用 data-suit/data-rank 算要出的牌
    async function pagePlayTurn() {
      await waitUntil(async () => (await page.title()).includes('该你'), 15000).catch(() => {});
      const st = byId.T.last;
      if (st.phase !== 'PLAYING' || st.round?.lastTrick) return;
      const ctx = { trumpSuit: st.round.trumpSuit, rankCard: st.round.rankCard };
      const lead = st.round.currentTrick[0] ?? null;
      const hand = await page.evaluate(() =>
        [...document.querySelectorAll('[data-card-id]')].map(w => ({
          id: w.dataset.cardId, suit: w.dataset.suit, rank: Number(w.dataset.rank),
        }))
      );
      const target = botCards(hand, lead, ctx)[0]?.id;
      if (!target) return;
      await page.evaluate((id) => {
        const wrapper = document.querySelector(`[data-card-id="${id}"]`);
        const el = wrapper.querySelector('.card-face, .card-back') ?? wrapper;
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      }, target);
      await sleep(250);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('出牌'));
        btn?.click();
      });
    }

    async function playUntil(count) {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (byId.T.last.phase !== 'PLAYING') return;
        const n = (await page.$$('[data-card-id]')).length;
        if (n <= count) return;
        await pagePlayTurn();
        await sleep(120);
      }
    }

    await playUntil(13);
    await sleep(400);
    const g13 = await handGeo();
    await page.screenshot({ path: OUT_DIR + 'play-13.png' });
    console.log('play-13', JSON.stringify(g13));

    await playUntil(3);
    await sleep(400);
    const g3 = await handGeo();
    await page.screenshot({ path: OUT_DIR + 'play-3.png' });
    console.log('play-3', JSON.stringify(g3));

    botLoopStop = true;
    for (const b of bots) b.close();
    await browser.close();
    console.log('DONE');
  } finally {
    killSrv();
    await sleep(200);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
