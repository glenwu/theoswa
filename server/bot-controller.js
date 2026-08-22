import { decideBotAction, normalizeBotDifficulty } from './bot-policy.js';
import { inferPublicBeliefs } from './bot-belief.js';
import { BotReviewJournal, botLearningProfile } from './bot-review.js';
import { evolvedBotTuning } from './bot-tuning.js';
import { viewerState } from './viewer.js';

// 动作被拒后的自愈重试：GameEngine 只在动作成功时触发 afterAction，
// 失败时不会再调 schedule()，电脑就此永久停手。出牌阶段还有 playMs 兜底，
// 但 SEATING / READY_CHECK 没有任何计时器，一次被拒就是整局卡死。
export const BOT_RETRY_BASE_MS = 400;
export const BOT_MAX_RETRIES = 4;

const DELAY_RANGES = {
  lobby: [600, 1100],
  draw: [700, 1200],
  declare: [1300, 2200],
  exchange: [2800, 4200],
  river: [2200, 3500],
  lead: [2200, 3500],
  follow: [1400, 2500],
  other: [900, 1600],
};

function decisionKind(decision) {
  const type = decision?.action?.type;
  if (type === 'confirmSeat' || type === 'ready' || type === 'claimFlipper') return 'lobby';
  if (type === 'drawCard') return 'draw';
  if (type === 'declareTrump') return 'declare';
  if (type === 'buryKitty') return 'exchange';
  if (type === 'initiateCrossRiver' || type === 'respondCrossRiver' || type === 'skipCrossRiver') {
    return 'river';
  }
  if (type === 'play') return decision.isLead ? 'lead' : 'follow';
  return 'other';
}

export function botDelayForDecision(decision, rng = Math.random) {
  const [min, max] = DELAY_RANGES[decisionKind(decision)];
  return Math.round(min + (max - min) * rng());
}

// 服务端电脑调度器：每次状态变化后，只安排一个电脑动作。
// 动作仍走 GameEngine.applyAction，因此与真人共享全部阶段校验和规则裁决。
export class BotController {
  constructor({
    engine,
    delayMs = null,
    retryBaseMs = BOT_RETRY_BASE_MS,
    maxRetries = BOT_MAX_RETRIES,
    difficulty = 'expert',
    tuning = evolvedBotTuning(), // 默认参数在调用时求值 → 天然惰性
    rng = Math.random,
    onError,
  } = {}) {
    this.engine = engine;
    this.delayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : null;
    this.retryBaseMs = Number.isFinite(retryBaseMs) ? Math.max(0, retryBaseMs) : BOT_RETRY_BASE_MS;
    this.maxRetries = Number.isFinite(maxRetries) ? Math.max(0, maxRetries) : BOT_MAX_RETRIES;
    this.rng = rng;
    this.difficulty = normalizeBotDifficulty(difficulty);
    this.tuning = tuning;
    this.reviewJournal = new BotReviewJournal();
    this.onError = onError ?? ((playerId, error) => {
      console.error(`[电脑玩家] ${playerId} 操作失败：${error.reason}`);
    });
    this.timer = null;
    this.retries = 0; // 连续被拒次数；任何一次重新排程都清零
  }

  nextDecision() {
    if (this.engine.state.paused) return null; // 暂停中电脑不出手
    // 托管（autoPlay）与电脑（isBot）在这里一视同仁：都由 AI 代打。
    // 区别只在身份 —— 托管的人还连着、还是那个人，随时可以自己取消。
    const bots = this.engine.state.players
      .filter(player => player.isBot || player.autoPlay)
      .sort((a, b) => a.seat - b.seat);
    for (const player of bots) {
      const view = {
        ...viewerState(this.engine.state, player.id),
        // 只注入给服务端决策器，不进入真人客户端的 viewer payload。
        botProfile: botLearningProfile(this.engine.state, player.id),
        botDifficulty: this.difficulty,
        botTuning: this.tuning,
      };
      view.botBeliefs = inferPublicBeliefs(view);
      const action = decideBotAction(view);
      if (action) {
        return {
          playerId: player.id,
          phase: view.phase,
          action,
          view,
          isLead: view.phase === 'PLAYING' && view.round?.currentTrick?.length === 0,
        };
      }
    }
    return null;
  }

  schedule() {
    this.stop();
    this.retries = 0; // 状态推进了（不管是电脑还是真人推的），重试计数作废
    const decision = this.nextDecision();
    if (!decision) return;
    const delay = this.delayMs ?? botDelayForDecision(decision, this.rng);
    this.timer = setTimeout(() => this.run(), delay);
    this.timer.unref?.();
  }

  run() {
    this.timer = null;
    const decision = this.nextDecision();
    if (!decision) return;
    const reviewRecord = this.reviewJournal.record(decision.view, decision.action);
    const result = this.engine.applyAction(
      { ...decision.action, phase: decision.phase },
      decision.playerId
    );
    if (result.ok) return; // 成功 → afterAction 会调 schedule() 接着排下一步

    // 失败时引擎不会 afterAction，必须自己重排，否则电脑永久停手。
    // 有界退避：连续失败到上限就放手，把局面交回真人（而不是无限空转）。
    this.reviewJournal.discard(reviewRecord);
    this.onError(decision.playerId, result.error);
    this.retries += 1;
    if (this.retries > this.maxRetries) {
      this.onError(decision.playerId, {
        code: 'BOT_STUCK',
        reason: `连续 ${this.maxRetries} 次动作被拒，已停止自动操作，请真人接手或移除该电脑`,
      });
      return;
    }
    this.timer = setTimeout(() => this.run(), this.retryBaseMs * 2 ** (this.retries - 1));
    this.timer.unref?.();
  }

  observeState() {
    this.reviewJournal.finalizeCompletedRounds(this.engine.state);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
