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
// ⚠️ 没有默认值。原来缺省是 'Y' —— 忘了设环境变量，任何人都能抹掉存档、
// 强制新开一局。未配置时一律视为「管理员能力关闭」，而不是「口令是 Y」。
const ADMIN_RESET_TOKEN = process.env.ADMIN_RESET_TOKEN || null;
const adminTokenMatches = token =>
  ADMIN_RESET_TOKEN !== null && typeof token === 'string' && token === ADMIN_RESET_TOKEN;

// ── 进门密码（Basic Auth + Cookie 会话）──────────────────────────────────────
// 本服务原本没有任何身份验证：知道地址就能顶替任意一家看牌。设 GAME_PASSWORD 后：
//   1. Cookie 会话（主路径，手机友好）：首次访问弹一个登录页，密码对了发
//      HttpOnly Cookie（30 天），之后 HTTP / WebSocket 全自动携带，
//      手机锁屏、关标签页都不用再输。
//   2. Basic Auth（兼容路径）：仍然有效，curl / 已缓存凭证的浏览器照常用。
// 不设该变量则行为与之前完全一致（本地开发不受影响）。
// Basic Auth 凭证由浏览器决定缓存多久（手机 Safari 常一锁屏就忘），
// 所以「状态保持」靠 Cookie 会话实现。
import { timingSafeEqual, randomBytes } from 'node:crypto';
const GAME_PASSWORD = process.env.GAME_PASSWORD || null;
function passwordOk(pass) {
  if (GAME_PASSWORD === null) return true;
  const a = Buffer.from(String(pass));
  const b = Buffer.from(GAME_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}
function basicAuthOk(req) {
  if (GAME_PASSWORD === null) return true;
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  // 用户名随便填（方便朋友记忆），只校验密码部分
  return passwordOk(i === -1 ? '' : decoded.slice(i + 1));
}

// ── Cookie 会话 ──────────────────────────────────────────────────────────────
// token 存内存 Map：服务重启后失效（朋友重输一次即可）。浏览器主动清 Cookie
// 或 30 天后过期同理。不需要落盘 —— 牌局存档才是要保的，登录态丢一次无所谓。
const SESSION_COOKIE = 'chaoshan_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const sessions = new Map(); // token -> 过期时间戳
function issueSession() {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function sessionOk(req) {
  if (GAME_PASSWORD === null) return true;
  const cookies = req.headers.cookie;
  if (typeof cookies !== 'string') return false;
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const exp = sessions.get(part.slice(eq + 1).trim());
    if (typeof exp === 'number' && exp > Date.now()) return true;
  }
  return false;
}
// 统一入口：Cookie 会话或 Basic Auth 任一通过即可
function authOk(req) {
  if (GAME_PASSWORD === null) return true;
  return sessionOk(req) || basicAuthOk(req);
}

// 登录页：手机友好的独立小页（不进 React bundle，密码错了就地提示）
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>潮汕升级 · 进门密码</title>
<style>
  html,body{height:100%;margin:0;background:#1a1c22;color:#eee;
    font-family:system-ui,-apple-system,"PingFang SC",sans-serif;
    display:flex;align-items:center;justify-content:center}
  form{width:min(320px,86vw);background:#23262f;border-radius:14px;
    padding:28px 24px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:1.15rem;margin:0 0 4px;text-align:center}
  p{font-size:.82rem;color:#9aa;margin:0 0 18px;text-align:center}
  input{width:100%;box-sizing:border-box;height:56px;font-size:1.25rem;
    text-align:center;letter-spacing:.3em;border-radius:10px;
    border:1px solid #3a3e4a;background:#1a1c22;color:#eee;outline:none}
  input:focus{border-color:#e8b339}
  button{width:100%;height:52px;margin-top:14px;font-size:1rem;border:0;
    border-radius:10px;background:#e8b339;color:#222;font-weight:600}
  .err{color:#e06c5a;font-size:.85rem;text-align:center;margin-top:12px;min-height:1em}
</style></head><body>
<form method="POST" action="/api/login">
  <h1>潮汕升级</h1>
  <p>请输入进门密码</p>
  <input type="password" name="password" autocomplete="current-password" autofocus>
  <button type="submit">进入</button>
  <div class="err">${'${ERR}'}</div>
</form></body></html>`;

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
// 表单解析要放在最前：登录页 <form> 是 urlencoded 提交，
// 认证中间件和 /api/login 都要能读到 req.body.password
app.use(express.urlencoded({ extended: false }));
// 进门密码：所有路由（含静态页面和 /api）都要先过 Cookie 会话或 Basic Auth。
// 浏览器首次访问看到的是登录页（不再弹原生密码框，避免手机端缓存易丢）。
if (GAME_PASSWORD !== null) {
  app.use((req, res, next) => {
    // 登录提交本身免检（密码就是凭证）
    if (req.method === 'POST' && req.path === '/api/login') return next();
    if (authOk(req)) return next();
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      res.status(401).type('html').send(LOGIN_PAGE.replace('${ERR}', ''));
      return;
    }
    // 非浏览器（curl、脚本）仍走标准 Basic Auth 质询
    res.set('WWW-Authenticate', 'Basic realm="chaoshan", charset="UTF-8"');
    res.status(401).send('需要密码');
  });
  app.post('/api/login', (req, res) => {
    const pass = req.body?.password ?? '';
    if (!passwordOk(pass)) {
      res.status(401).type('html').send(LOGIN_PAGE.replace('${ERR}', '密码不对，再试一次'));
      return;
    }
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${issueSession()}; Path=/; HttpOnly; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`);
    res.redirect('/');
  });
  console.log('[潮汕升级] 🔒 已启用进门密码（GAME_PASSWORD）：登录页 + Cookie 会话（30 天），兼容 Basic Auth。');
}
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
// ⚠️ 绝不要把 state.seed 加回这个响应。
// 种子完全决定牌堆顺序（beginRound 里 shuffleArray(buildDeck(), state.rng)），
// 而起揭人是公开信息 —— 拿到 seed 就能在本地把四家 25 张手牌和 8 张底牌全部算出来。
// viewer.js 那套递归牌形扫描器再严也拦不住：攻击者根本不看 payload。
// 想复现牌局请看服务端启动日志里打印的 SEED。
app.get('/api/health', (req, res) => res.json({ ok: true, phase: state.phase }));
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
  if (!adminTokenMatches(req.get('x-admin-token'))) {
    return res.status(403).json({
      error: ADMIN_RESET_TOKEN === null
        ? '服务端未配置 ADMIN_RESET_TOKEN，管理员能力已关闭'
        : '需要管理员口令（请求头 x-admin-token）',
    });
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
// WebSocket：有 GAME_PASSWORD 时，升级握手要求 Cookie 会话或 Basic Auth。
// 用 noServer + 手动 handleUpgrade，才能在握手阶段就拒绝。浏览器对同源
// ws:// 连接会自动带上 Cookie 和 Basic 凭证，与页面共用同一份登录态。
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!authOk(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="chaoshan", charset="UTF-8"\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

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
      const old = connections.get(id);
      if (old && old !== ws) {
        // 同身份新连接顶替旧连接（断线重连天然可用）
        send(old, { type: 'kicked', reason: '你已在别处登录' });
        try { old.close(4001, 'replaced'); } catch { /* 忽略 */ }
      }
      playerId = id;
      connections.set(id, ws);
      // 管理员能力：连接时携带正确口令才授予（伪造动作在服务端一律拒绝）
      if (adminTokenMatches(msg.adminToken)) {
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
    console.warn('[潮汕升级] ⚠️ 正在监听所有网卡（HOST=0.0.0.0）。');
    if (GAME_PASSWORD === null) {
      console.warn('[潮汕升级] ⚠️ 本服务没有任何身份验证：知道地址的人可以选任意一家并看到那家的手牌。');
      console.warn('[潮汕升级] ⚠️ 建议设置 GAME_PASSWORD（Basic Auth 进门密码）。');
    }
    console.warn('[潮汕升级] ⚠️ 对外只转发这一个端口，不要用 DMZ（DMZ 会把整台机器暴露出去）。');
  }
  if (ADMIN_RESET_TOKEN === null) {
    console.log('[潮汕升级] 未设置 ADMIN_RESET_TOKEN，管理员能力已关闭（清档 / 强制新开一局不可用）。');
  }
});
