// 调试：4 客户端完整走一局，打印每次状态变化（带时间戳与关键字段）
import { WebSocket } from 'ws';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8787/ws';
const PLAYERS = ['T', 'H', 'B', 'M'];

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = {
      id,
      ws,
      last: null,
      declared: false,
      send: a => ws.send(JSON.stringify(a)),
      onState: null,
    };
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') {
        client.last = m.state;
        client.onState?.(m.state);
      } else if (m.type === 'error') {
        log(`  [${id}] ERROR ${m.code}: ${m.reason}`);
      }
    });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', playerId: id }));
      resolve(client);
    });
  });
}

async function main() {
  const clients = [];
  for (const id of PLAYERS) clients.push(await connect(id));
  const byId = Object.fromEntries(clients.map(c => [c.id, c]));

  // 每个客户端的 state 观察器
  let lastPhases = {};
  for (const c of clients) {
    c.onState = s => {
      const key = `${s.phase}:${s.round?.drawnCount}`;
      if (lastPhases[c.id] !== key) {
        lastPhases[c.id] = key;
        log(
          `[${c.id}] phase=${s.phase} drawn=${s.round?.drawnCount} turn=${s.round?.revealTurnSeat} trump=${s.round?.trumpSuit} hand=${s.you.hand.length} rankCards=${(s.you.hand ?? []).filter(x => x.rank === s.round?.rankCard).length} graceDeadline=${s.round?.graceDeadline ? Math.max(0, s.round.graceDeadline - Date.now()).toFixed(0) : '-'}`
        );
        // 自动动作：轮到自己揭牌就揭牌；手上有级牌就亮主
        if (s.phase === 'REVEALING' && s.round && s.round.drawnCount < 100 && s.round.revealTurnSeat === s.you.seat) {
          c.send({ type: 'drawCard' });
        }
        if (s.phase === 'REVEALING' && !c.declared) {
          const rc = (s.you.hand ?? []).find(x => x.rank === s.round.rankCard);
          if (rc) {
            c.declared = true;
            log(`  [${c.id}] 亮主 ${rc.suit}${rc.rank} id=${rc.id}`);
            c.send({ type: 'declareTrump', cardId: rc.id });
          }
        }
        if (s.phase === 'KITTY_EXCHANGE' && s.declarerSeat === s.you.seat) {
          const pool = s.you.hand; // 33 张：底牌已并入手牌
          const buried = pool.slice(0, 8);
          log(`  [${c.id}] 换底 ${buried.map(x => x.id).join(',')}`);
          c.send({ type: 'buryKitty', cardIds: buried.map(x => x.id) });
        }
      }
    };
  }

  for (const c of clients) c.send({ type: 'confirmSeat' });
  await new Promise(r => setTimeout(r, 500));
  for (const c of clients) c.send({ type: 'ready' });
  await new Promise(r => setTimeout(r, 500));
  byId.T.send({ type: 'claimFlipper' });

  // 等到 PLAYING 或超时
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (byId.T.last && byId.T.last.phase === 'PLAYING') {
      log('DONE: 到达 PLAYING');
      process.exit(0);
    }
    if (byId.T.last && byId.T.last.phase === 'READY_CHECK') {
      // 流局 → 重新准备
      log('  流局 → 重新准备');
      for (const c of clients) c.send({ type: 'ready' });
      await new Promise(r => setTimeout(r, 500));
      byId.T.send({ type: 'claimFlipper' });
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 100));
  }
  log('TIMEOUT: 未到达 PLAYING');
  process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
