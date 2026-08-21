import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GameEngine } from './game-engine.js';
import { BotController } from './bot-controller.js';
import { viewerState } from './viewer.js';
import { PLAYER_IDS, SUIT_NAMES, KITTY_SIZE, HAND_SIZE, timingsFromEnv } from './constants.js';
import { createInitialState, createRoundState, playerBySeat, pushLog } from './state.js';
import { sortHand, SUITS } from './cards.js';
import { rebuildPieces } from './pieces.js';
import { mulberry32 } from './rng.js';
import { loadSavedGame, saveGame, clearSave, SAVE_FILE } from './persist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
// 监听地址：默认只绑回环，公网部署一律走反向代理（nginx/caddy）。
// 想直接对外暴露必须显式设 HOST=0.0.0.0——默认值绝不能是全网卡：
// 目标机器上 ufw 可能是 inactive，绑 0.0.0.0 等于把整局游戏开在公网上。
const HOST = process.env.HOST ?? '127.0.0.1';
// 服务端专用口令，不能放进前后端共享的 constants.js：浏览器没有 process.env，
// 而且管理员口令不应被打包进客户端代码。
const ADMIN_RESET_TOKEN = process.env.ADMIN_RESET_TOKEN ?? 'Y';

// 持久化恢复：启动时若有 12 小时内的存档，自动恢复（进程重启不丢战果）
function reviveState(saved) {
  const state = saved;
  state.rng = mulberry32(state.rngState ?? state.seed ?? 1);
  state.timing = { ...createInitialState().timing, ...(state.timing ?? {}) };
  for (const p of state.players) {
    p.connected = p.isBot === true; // 真人需重连；服务端电脑恢复后继续在线
    p.ready = false;
  }
  return state;
}
const restored = loadSavedGame();
if (restored) {
  console.log(`[潮汕升级] 检测到存档（12 小时内），已恢复对局（阶段 ${restored.phase}）。`);
}

// 可复现牌局：种子随机源从座位随机开始贯穿整局（SEED 相同 → 座位与牌局完全一致）。
// 恢复存档时不重设种子（rng 状态已随存档续流）。
const seedInput = process.env.SEED;
const seed =
  seedInput !== undefined && seedInput !== ''
    ? Number(seedInput) >>> 0
    : (Math.floor(Math.random() * 2 ** 31) >>> 0);

// 服务端持有唯一权威游戏状态；阶段节奏可用环境变量覆盖（测试与冒烟用）：
//   FLIP_MS / DRAW_MS / GRACE_MS / FALLBACK_MS / DEALING_MS / SETTLE_MS / SCORING_MS / ROUND_END_MS / PLAY_MS
const engine = new GameEngine({
  state: restored
    ? reviveState(restored)
    : (() => {
        const fresh = createInitialState(mulberry32(seed)); // 座位与后续洗牌共用同一种子流
        fresh.seed = seed;
        return fresh;
      })(),
  // 节奏默认值全部来自 constants.js（别在这里再写一份字面量）
  timings: timingsFromEnv(),
  broadcast: () => broadcast(),
});
const state = engine.state;
const botController = new BotController({
  engine,
  difficulty: process.env.BOT_DIFFICULTY ?? 'expert',
  // 未配置时按动作类型使用带轻微随机的思考时间；配置后固定为该毫秒数。
  delayMs: process.env.BOT_DELAY_MS === undefined
    ? null
    : Number(process.env.BOT_DELAY_MS),
});
engine.attachBotController(botController);

if (!restored) {
  console.log(`[潮汕升级] 本局种子 SEED=${seed}（用 SEED=${seed} 可复现整局）`);
} else {
  console.log(`[潮汕升级] 存档种子 SEED=${state.seed}（rng 已续流）`);
}

// playerId -> ws（同身份仅保留最新连接，新连接顶替旧连接）
const connections = new Map();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.get('/api/health', (req, res) => res.json({ ok: true, phase: state.phase, seed: state.seed ?? null }));
app.get('/api/occupancy', (req, res) => {
  res.json({
    phase: state.phase,
    occupied: state.players.filter(p => p.connected || p.isBot).map(p => p.id),
    bots: state.players.filter(p => p.isBot).map(p => p.id),
  });
});

// 清存档（想彻底重来时的显式入口）。
// 必须带管理员口令：这是个不可逆的破坏性操作，无鉴权等于任何人都能抹掉一晚上的战果。
// 口令走请求头而不是 query —— URL 会进访问日志、浏览器历史和 Referer。
app.delete('/api/save', (req, res) => {
  if (req.get('x-admin-token') !== ADMIN_RESET_TOKEN) {
    return res.status(403).json({ error: '需要管理员口令（请求头 x-admin-token）' });
  }
  clearSave();
  res.json({ ok: true, cleared: true });
});

// 调试注入（仅开发环境 DEBUG=1）：
// 直接指定四家手牌 + 底牌，构造 PLAYING 状态，用于针对性验证与手动验规则。
// body: { declarerSeat, trumpSuit, rankCard, hands: { "0": [{suit,rank}×25], ... }, kitty: [×8] }
app.post('/api/debug/inject', (req, res) => {
  if (process.env.DEBUG !== '1') {
    return res.status(403).json({ error: '调试端点未启用（需 DEBUG=1 启动）' });
  }
  const body = req.body ?? {};
  try {
    if (!Number.isInteger(body.declarerSeat) || body.declarerSeat < 0 || body.declarerSeat > 3) {
      throw new Error('declarerSeat 必须是 0..3');
    }
    if (!SUITS.includes(body.trumpSuit)) throw new Error('trumpSuit 必须是 S/H/D/C');
    if (!Number.isInteger(body.rankCard) || body.rankCard < 2 || body.rankCard > 14) {
      throw new Error('rankCard 必须是 2..14');
    }
    const validCard = c =>
      c && (c.suit === 'JOKER' || SUITS.includes(c.suit)) && Number.isInteger(c.rank) && c.rank >= 2 && c.rank <= 16;
    const hands = body.hands ?? {};
    for (const seat of [0, 1, 2, 3]) {
      const cards = hands[String(seat)];
      if (!Array.isArray(cards) || cards.length !== HAND_SIZE || !cards.every(validCard)) {
        throw new Error(`座位 ${seat} 需要恰好 ${HAND_SIZE} 张合法牌`);
      }
    }
    if (!Array.isArray(body.kitty) || body.kitty.length !== KITTY_SIZE || !body.kitty.every(validCard)) {
      throw new Error(`底牌需要恰好 ${KITTY_SIZE} 张合法牌`);
    }

    const ctx = { trumpSuit: body.trumpSuit, rankCard: body.rankCard };
    let n = 0;
    for (const seat of [0, 1, 2, 3]) {
      playerBySeat(state, seat).hand = sortHand(
        hands[String(seat)].map(c => ({ id: `inj-${n++}`, ...c })),
        ctx
      );
    }
    const r = createRoundState(state.round ? state.round.roundNumber : 1, body.declarerSeat);
    r.trumpSuit = body.trumpSuit;
    r.rankCard = body.rankCard;
    r.kitty = body.kitty.map(c => ({ id: `inj-${n++}`, ...c }));
    state.declarerSeat = body.declarerSeat;
    state.round = r;
    state.phase = 'PLAYING';
    r.leadSeat = Number.isInteger(body.leadSeat) ? body.leadSeat : body.declarerSeat;
    r.turnSeat = r.leadSeat;
    rebuildPieces(state);
    pushLog(state, `调试注入牌局：主${SUIT_NAMES[body.trumpSuit]}，打 ${body.rankCard}`);
    broadcast();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// 每次状态变更后，按玩家裁剪广播。
// viewerState 内置递归安全扫描：若出现非公开牌面会直接抛错（失败要响，不能静默）。
function broadcast() {
  for (const [playerId, ws] of connections) {
    const view = viewerState(state, playerId);
    if (view) send(ws, { type: 'state', state: view });
  }
  scheduleSave(); // 状态变更后节流持久化
}

// 持久化节流：合并高频变更，1 秒无新变更时落盘
let saveTimer = null;
let saveSuppressUntil = 0; // 新开一局后的短暂窗口内不落盘（清档语义）
function scheduleSave() {
  if (Date.now() < saveSuppressUntil) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveGame(state);
  }, 1000);
}

// 退出钩子：把最后一刻的状态落盘
function flushAndExit(code = 0) {
  clearTimeout(saveTimer);
  saveGame(state);
  process.exit(code);
}
process.on('SIGINT', () => flushAndExit(0));
process.on('SIGTERM', () => flushAndExit(0));

function sendError(ws, code, reason) {
  send(ws, { type: 'error', code, reason });
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'BAD_ACTION', '无效消息');
    }

    if (msg.type === 'join') {
      const id = msg.playerId;
      if (!PLAYER_IDS.includes(id)) return sendError(ws, 'UNKNOWN_PLAYER', '未知身份');
      const joiningPlayer = state.players.find(p => p.id === id);
      if (joiningPlayer?.isBot) {
        return sendError(ws, 'BOT_UNAVAILABLE', '该身份当前由电脑控制，请先在大厅移除电脑');
      }
      const old = connections.get(id);
      if (old && old !== ws) {
        // 同身份新连接顶替旧连接（断线重连天然可用）
        send(old, { type: 'kicked', reason: '你已在别处登录' });
        try { old.close(4001, 'replaced'); } catch { /* 忽略 */ }
      }
      playerId = id;
      connections.set(id, ws);
      // 管理员能力：连接时携带正确口令才授予（伪造动作在服务端一律拒绝）
      if (msg.adminToken === ADMIN_RESET_TOKEN) {
        if (!state.adminIds.includes(id)) state.adminIds.push(id);
      } else if (state.adminIds.includes(id)) {
        state.adminIds = state.adminIds.filter(x => x !== id); // 不带口令重连 → 撤销
      }
      const result = engine.applyAction({ type: 'join' }, id);
      if (!result.ok) {
        connections.delete(id);
        playerId = null;
        return sendError(ws, result.error.code, result.error.reason);
      }
      return;
    }

    if (!playerId) return sendError(ws, 'NOT_JOINED', '请先选择身份');
    const result = engine.applyAction(msg, playerId);
    if (!result.ok) return sendError(ws, result.error.code, result.error.reason);
    // 新开一局已执行（提案全票通过或管理员强制）：取消待落盘的保存并清掉旧存档
    if (state.saveClearRequested) {
      state.saveClearRequested = false;
      clearTimeout(saveTimer);
      saveSuppressUntil = Date.now() + 3000; // 断线 leave 等涟漪广播不重写存档
      clearSave();
    }
  });

  ws.on('close', () => {
    // 仅当未被新连接顶替时才记为掉线
    if (playerId && connections.get(playerId) === ws) {
      connections.delete(playerId);
      engine.applyAction({ type: 'leave' }, playerId);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[潮汕升级] 存档文件：${SAVE_FILE}`);
  console.log(`[潮汕升级] 服务端已启动: http://${HOST}:${PORT}`);
  console.log(`[潮汕升级] WebSocket: ws://${HOST}:${PORT}/ws`);
  if (HOST === '0.0.0.0') {
    console.warn('[潮汕升级] ⚠️ 正在监听所有网卡（HOST=0.0.0.0）：请确认防火墙已配置，或改用反向代理。');
  }
});
