import {
  applyAction as applyPureAction,
  expireResetProposal,
  expireCrossRiverDecision,
  autoRespondCrossRiver,
} from './actions.js';
import { createInitialState, pushLog, playerBySeat } from './state.js';
import {
  flipCardForRevealFirst,
  drawOneCard,
  completeDeal,
} from './round.js';
import { settleNoTrump, advanceToReadyCheck, startRevealing } from './flow.js';
import { settleFinalTrick } from './scoring.js';
import { settleFallbackTrump } from './reveal.js';
import { cardLabel } from './cards.js';
import { pickAutoCards } from './trick.js';
import { chooseKittyCards } from './bot-policy.js';
import { KITTY_SIZE, REVEAL_TOTAL } from './constants.js';

// 服务端游戏引擎：纯动作裁决 + 阶段计时器。
// - 揭牌 3 秒倒计时：超时服务端自动摸牌（挂机/掉线不卡全场）
// - 100 张摸完后的亮主宽限窗口
// - 翻牌定起揭人 / 揭底定主 / 发牌收尾的自动节奏
export class GameEngine {
  constructor({ state, timings, broadcast } = {}) {
    this.state = state ?? createInitialState();
    this.broadcast = broadcast ?? (() => {});
    if (timings) Object.assign(this.state.timing, timings);
    this.timers = new Map();
    this.botController = null;
    // 构造后立即对齐计时器（覆盖“引擎创建时已处于某阶段”的情形）
    this.scheduleTimers();
  }

  // 所有客户端意图的权威入口
  applyAction(action, actorId) {
    const result = applyPureAction(this.state, action, actorId);
    if (result.ok) this.afterAction();
    return result;
  }

  afterAction() {
    this.scheduleTimers();
    // 局末复盘在广播前写入 RoundSummary，因此四端会同步看到同一份结果。
    this.botController?.observeState();
    this.broadcast();
    this.botController?.schedule();
  }

  attachBotController(controller) {
    this.botController = controller;
    controller.schedule();
  }

  // 按阶段重排计时器（幂等：先清后建，同名覆盖）
  scheduleTimers() {
    this.clearTimers();
    const s = this.state;
    // 暂停中：一个计时器都不排。截止时刻原样留在状态里，
    // 恢复时由 pause.js 的 shiftDeadlines 整体往后推「暂停了多久」，
    // 所以这里不需要（也不应该）改动它们。
    if (s.paused) return;
    const t = s.timing;
    const now = Date.now();

    // 新开一局提案超时（与轮局无关，round 为 null 时也生效；存档恢复后重新计时）
    if (s.resetProposal) {
      this.setTimer('resetProposal', Math.max(0, s.resetProposal.deadline - now), () => {
        expireResetProposal(s);
        this.afterAction();
      });
    }

    const r = s.round;
    if (!r) return;

    if (s.phase === 'REVEAL_FIRST' && s.flipperSeat !== null && !r.flipDone) {
      this.setTimer('flip', t.flipMs, () => this.flipOne());
    } else if (s.phase === 'REVEAL_FIRST' && r.flipDone) {
      // 起揭人已定，停留供四家看清；四人点满「知道了」会提前走（见 handleConfirmFlip）
      if (!r.flipHoldDeadline) r.flipHoldDeadline = now + t.flipHoldMs;
      this.setTimer('flipHold', Math.max(0, r.flipHoldDeadline - now), () => this.beginRevealing());
    } else if (s.phase === 'REVEALING' && !r.trumpSuit) {
      if (r.drawnCount < REVEAL_TOTAL) {
        if (!r.drawDeadline) r.drawDeadline = now + t.drawMs;
        this.setTimer('draw', Math.max(0, r.drawDeadline - now), () => this.autoDraw());
      } else {
        if (!r.graceDeadline) {
          r.graceDeadline = now + t.graceMs;
          pushLog(s, `揭牌完成，最后 ${Math.round(t.graceMs / 1000)} 秒内仍可亮主`);
        }
        this.setTimer('grace', Math.max(0, r.graceDeadline - now), () => this.settleGrace());
      }
    } else if (s.phase === 'FALLBACK_TRUMP') {
      this.setTimer('fallback', t.fallbackMs, () => this.revealNextKittyCard());
    } else if (s.phase === 'DEALING') {
      this.setTimer('dealing', t.dealingMs, () => this.completeDealing());
    } else if (s.phase === 'KITTY_EXCHANGE') {
      // 绝对时刻：四端倒计时一致，存档恢复后接着走（不会因为重启白送庄家一轮时间）
      if (!r.kittyDeadline) r.kittyDeadline = now + t.kittyExchangeMs;
      this.setTimer('kitty', Math.max(0, r.kittyDeadline - now), () => this.autoBuryKitty());
    } else if (s.phase === 'CROSS_RIVER') {
      // 三主过河：决定窗口（到时未行动的候选人自动跳过）+ 每笔过河的对家回牌超时
      const cr = r.crossRiver;
      if (cr.decideDeadline) {
        this.setTimer('crossDecide', Math.max(0, cr.decideDeadline - now), () => {
          expireCrossRiverDecision(s);
          this.afterAction();
        });
      }
      for (const a of cr.active) {
        this.setTimer(`crossPick-${a.fromSeat}`, Math.max(0, a.deadline - now), () => {
          autoRespondCrossRiver(s, a.fromSeat);
          this.afterAction();
        });
      }
    } else if (s.phase === 'PLAYING') {
      if (r.lastTrick && r.settleDeadline) {
        // 收牌停留：服务端计时，四端同步（期间拒绝出牌 WAIT_SETTLE）
        this.setTimer('settle', Math.max(0, r.settleDeadline - now), () => this.settleTrick());
      } else if (r.turnSeat !== null) {
        // 出牌限时：超时服务端自动打出最小合法牌（宽松 60s，可调）
        if (!r.playDeadline || r.playTurnSeat !== r.turnSeat) {
          r.playDeadline = now + t.playMs;
          r.playTurnSeat = r.turnSeat;
        }
        this.setTimer('play', Math.max(0, r.playDeadline - now), () => this.autoPlay());
      }
    } else if (s.phase === 'DOMINANCE') {
      if (!r.dominanceDeadline) r.dominanceDeadline = now + t.dominanceMs;
      this.setTimer('dominance', Math.max(0, r.dominanceDeadline - now), () =>
        this.autoConfirmDominance()
      );
    } else if (s.phase === 'SCORING') {
      // 结算展示 → 本局小结
      this.setTimer('scoring', t.scoringMs, () => {
        s.phase = 'ROUND_END';
        // 小结停留用绝对时刻：四端倒计时一致，存档恢复后也能接着走
        r.roundEndDeadline = Date.now() + t.roundEndMs;
        r.roundEndConfirms = [];
        this.afterAction();
      });
    } else if (s.phase === 'ROUND_END') {
      // 本局小结停留 → 下一局准备（四人都点「看完了」会提前走，见 handleConfirmRoundEnd）
      if (!r.roundEndDeadline) r.roundEndDeadline = now + t.roundEndMs;
      this.setTimer('roundEnd', Math.max(0, r.roundEndDeadline - now), () => this.enterReadyCheck());
    }
  }

  setTimer(name, ms, cb) {
    const timer = setTimeout(() => {
      this.timers.delete(name);
      cb();
    }, ms);
    // 阶段计时器不该单靠自己撑住进程：真实服务端有 http server 顶着，
    // 而测试里造完就丢的引擎不该把 node --test 挂住不退出。
    // 换底那条是 180 秒，加上之前整个测试进程就得干等三分钟才肯结束。
    timer.unref?.();
    this.timers.set(name, timer);
  }

  clearTimers() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // REVEAL_FIRST：翻一张（大小王自动重翻，直到点数牌）
  flipOne() {
    if (this.state.phase !== 'REVEAL_FIRST' || !this.state.round || this.state.round.flipDone) return;
    flipCardForRevealFirst(this.state);
    this.afterAction();
  }

  // 起揭人停留结束 → 正式开始逐张揭牌
  beginRevealing() {
    if (startRevealing(this.state)) this.afterAction();
  }

  // 揭牌超时：服务端自动替当前揭牌人摸一张，照常轮转
  autoDraw() {
    const s = this.state;
    const r = s.round;
    if (s.phase !== 'REVEALING' || r.trumpSuit || r.drawnCount >= REVEAL_TOTAL) return;
    const seat = r.revealTurnSeat;
    drawOneCard(s, seat);
    r.drawDeadline = Date.now() + s.timing.drawMs;
    this.afterAction();
  }

  // 宽限窗口结束仍无人亮主 → 流局（庄家未定）或 揭底定主（庄家已定）
  settleGrace() {
    const s = this.state;
    const r = s.round;
    if (s.phase !== 'REVEALING' || r.trumpSuit || r.drawnCount < REVEAL_TOTAL) return;
    settleNoTrump(s);
    this.afterAction();
  }

  // 揭底定主：逐张公开翻开底牌，全部翻开后定主
  revealNextKittyCard() {
    const s = this.state;
    const r = s.round;
    if (s.phase !== 'FALLBACK_TRUMP') return;
    const idx = r.fallbackRevealed.length;
    const card = r.kitty[idx];
    if (!card) return;
    r.fallbackRevealed.push(card);
    pushLog(s, `底牌第 ${idx + 1} 张：${cardLabel(card)}`); // 公开摊开，四家可见
    if (r.fallbackRevealed.length >= KITTY_SIZE) {
      settleFallbackTrump(s);
    }
    this.afterAction();
  }

  // DEALING：剩余牌一次性发完 + 手牌排序 + 进入换底
  completeDealing() {
    if (this.state.phase !== 'DEALING') return;
    completeDeal(this.state);
    this.afterAction();
  }

  // 收牌停留结束：清空 lastTrick，轮到赢家出牌。
  // 四家各只剩 1 张时（最后一轮）谁出什么已无选择：直接自动逐张打出并结算
  //（仍走完整出牌展示 + 收牌停留，这一轮决定撬底，不能闪跳）。
  settleTrick() {
    const s = this.state;
    const r = s.round;
    if (s.phase === 'PLAYING' && r.lastTrick) {
      // 有人按住「我想再看一会」→ 现在还不能收。
      // 按住时 settleDeadline 已经被延到 60 秒，afterAction 会照新的时间重排；
      // 这里再挡一道，防止旧计时器抢先跑进来（clearTimers 之外的竞态兜底）。
      if ((r.lastTrickHolds ?? []).length > 0 && Date.now() < (r.settleDeadline ?? 0)) return;
      // 本局最后一墩：停留看完了才结算（原来是打完立刻 finishRound，
      // 结算面板一秒不到就盖上来，见 actions.js 那段注释）。
      // ⚠️ 用显式标记，不用「四家手牌都空了」—— 那个条件在刚建好、还没发牌的
      // state 上也成立（engine.test.js 里就有这样的 fixture），会把没打过的局
      // 直接推去 finishRound，当场抛「kittyGrab 判定需要已打完的局」。
      if (settleFinalTrick(s)) {
        this.afterAction();
        return;
      }
      r.lastTrick = null;
      r.lastTrickHolds = [];
      if (r.currentTrick.length === 0 && s.players.every(p => p.hand.length === 1)) {
        // 最后一轮：逐张自动打出（内部自行 afterAction 并排下一张的计时器）。
        // 这里立即返回，避免再次 afterAction → clearTimers 把 autoLast 计时器清掉。
        this.autoPlayLastCards();
        return;
      }
      this.afterAction();
    }
  }

  // 最后一轮自动打出：每次只打一张（当前 turnSeat 手上唯一那张），
  // 间隔 autoLastMs 继续下一张 —— 四家依次出完、动画完整、最后照常 1.5 秒停留。
  autoPlayLastCards() {
    const s = this.state;
    const r = s.round;
    if (s.phase !== 'PLAYING' || !r || r.lastTrick || r.currentTrick.length >= 4) return;
    const player = playerBySeat(s, r.turnSeat);
    if (!player || player.hand.length !== 1) return;
    const result = applyPureAction(
      s,
      { type: 'play', cardIds: [player.hand[0].id] },
      player.id
    );
    if (!result.ok) {
      pushLog(s, `自动打最后一轮失败：${result.error.reason}`);
    }
    this.afterAction();
    if (
      s.phase === 'PLAYING' &&
      !r.lastTrick &&
      r.currentTrick.length > 0 &&
      r.currentTrick.length < 4
    ) {
      this.setTimer('autoLast', s.timing.autoLastMs, () => this.autoPlayLastCards());
    }
  }

  // 本局小结结束 → 下一局准备。
  // 跨局只保留：座位、两队级别、declarerSeat（轮转产生）；其余随新局 beginRound 整体重建。
  enterReadyCheck() {
    if (advanceToReadyCheck(this.state)) this.afterAction();
  }

  // 出牌超时：服务端自动打出最小合法牌（不判负、不跳过，牌局照常走完）
  autoPlay() {
    const s = this.state;
    const r = s.round;
    if (s.phase !== 'PLAYING' || r.lastTrick || r.turnSeat === null) return;
    const player = playerBySeat(s, r.turnSeat);
    const lead = r.currentTrick[0] ?? null;
    const cards = pickAutoCards(player.hand, lead, {
      trumpSuit: r.trumpSuit,
      rankCard: r.rankCard,
    });
    pushLog(s, `${player.nickname} 出牌超时，自动打出`);
    const result = applyPureAction(
      s,
      { type: 'play', cardIds: cards.map(c => c.id) },
      player.id
    );
    if (!result.ok) {
      // 理论上不会发生（pickAutoCards 保证合法）
      pushLog(s, `自动出牌失败：${result.error.reason}`);
    }
    this.afterAction();
  }

  // 换底超时：服务端替庄家埋 8 张，用的就是电脑玩家挑底牌那套算法
  //（弃分最低、最没用的 8 张），不是随手抓 8 张糊弄。
  // 走 applyAction 正式路径，规则校验 / 件表重建 / 阶段推进全部照常。
  autoBuryKitty() {
    const s = this.state;
    const r = s.round;
    if (s.phase !== 'KITTY_EXCHANGE' || !r || s.declarerSeat === null) return;
    const declarer = playerBySeat(s, s.declarerSeat);
    const cards = chooseKittyCards(declarer.hand, {
      trumpSuit: r.trumpSuit,
      rankCard: r.rankCard,
    });
    pushLog(s, `${declarer.nickname} 换底超时，服务端自动埋底`);
    const result = applyPureAction(
      s,
      { type: 'buryKitty', cardIds: cards.map(c => c.id) },
      declarer.id
    );
    if (!result.ok) {
      // 兜底的兜底：算法万一给不出合法的 8 张，也不能让整局卡死在这里
      pushLog(s, `自动埋底失败（${result.error.reason}），改埋手牌最后 8 张`);
      applyPureAction(
        s,
        { type: 'buryKitty', cardIds: declarer.hand.slice(-KITTY_SIZE).map(c => c.id) },
        declarer.id
      );
    }
    this.afterAction();
  }

  // 碾压确认超时：随便找一家替他点。结算结果与谁点无关
  //（handleConfirmDominance 只用 r.leadSeat 记虚拟轮赢家），所以不存在“替谁点”的公平问题。
  autoConfirmDominance() {
    const s = this.state;
    if (s.phase !== 'DOMINANCE' || !s.round?.dominance) return;
    // 有人按了「看多一会」而窗口还没到 → 不收（口径同 settleTrick 那边）
    const r = s.round;
    if ((r.dominanceHolds ?? []).length > 0 && Date.now() < (r.dominanceDeadline ?? 0)) return;
    const actor = playerBySeat(s, s.round.leadSeat);
    pushLog(s, '碾压收尾确认超时，自动结算本局');
    applyPureAction(s, { type: 'confirmDominance' }, actor.id);
    this.afterAction();
  }
}
