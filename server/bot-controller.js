import { decideBotAction, normalizeBotDifficulty } from './bot-policy.js';
import { inferPublicBeliefs } from './bot-belief.js';
import { BotReviewJournal, botLearningProfile } from './bot-review.js';
import { EVOLVED_BOT_TUNING } from './bot-tuning.js';
import { viewerState } from './viewer.js';

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
    difficulty = 'expert',
    tuning = EVOLVED_BOT_TUNING,
    rng = Math.random,
    onError,
  } = {}) {
    this.engine = engine;
    this.delayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : null;
    this.rng = rng;
    this.difficulty = normalizeBotDifficulty(difficulty);
    this.tuning = tuning;
    this.reviewJournal = new BotReviewJournal();
    this.onError = onError ?? ((playerId, error) => {
      console.error(`[电脑玩家] ${playerId} 操作失败：${error.reason}`);
    });
    this.timer = null;
  }

  nextDecision() {
    const bots = this.engine.state.players
      .filter(player => player.isBot)
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
    if (!result.ok) {
      this.reviewJournal.discard(reviewRecord);
      this.onError(decision.playerId, result.error);
    }
  }

  observeState() {
    this.reviewJournal.finalizeCompletedRounds(this.engine.state);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
