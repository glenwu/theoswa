import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_TUNING_BOUNDS,
  DEFAULT_BOT_TUNING,
  normalizeBotTuning,
} from './bot-policy.js';
import { DEFAULT_BOT_TUNING_FILE, evolvedBotTuning } from './bot-tuning.js';
import { mulberry32 } from './rng.js';
import { simulateRound } from './simulate-bots.js';

const modulePath = fileURLToPath(import.meta.url);
const INTEGER_KEYS = new Set([
  'earlyThrowMinLength',
  'pieceProbeMinLength',
  'opponentThreatThreshold',
]);

function integerArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function numberArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stringArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function gaussian(rng) {
  const u = Math.max(Number.EPSILON, rng());
  const v = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleCandidate(mean, deviation, rng) {
  const sampled = {};
  for (const key of Object.keys(DEFAULT_BOT_TUNING)) {
    sampled[key] = mean[key] + gaussian(rng) * deviation[key];
  }
  return normalizeBotTuning(sampled);
}

function candidateKey(candidate) {
  return Object.entries(candidate)
    .map(([key, value]) => `${key}:${Number(value).toFixed(5)}`)
    .join('|');
}

function teamUtility(summary, team) {
  const declarerTeam = summary.declarerSeat % 2;
  const defenderTeam = 1 - declarerTeam;
  const isDefender = team === defenderTeam;
  const perspective = isDefender ? 1 : -1;
  const teamWon = isDefender ? summary.transfer : !summary.transfer;
  const upgrade = summary.upgradeCount * 24 * (summary.upgradedTeam === team ? 1 : -1);
  const pointMargin = (summary.defenderPoints - 80) * 0.7 * perspective;
  const bottom = summary.kittyGrab ? 65 * perspective : 0;
  return (teamWon ? 120 : -120) + upgrade + pointMargin + bottom;
}

function emptyMetrics() {
  return {
    games: 0,
    utility: 0,
    wins: 0,
    dealerGames: 0,
    dealerBottomSaved: 0,
    defenderGames: 0,
    defenderKittyGrabs: 0,
    defenderPointsWhenDefending: 0,
  };
}

function addRoundMetrics(metrics, summary, team) {
  const declarerTeam = summary.declarerSeat % 2;
  const isDealer = team === declarerTeam;
  const won = isDealer ? !summary.transfer : summary.transfer;
  metrics.games += 1;
  metrics.utility += teamUtility(summary, team);
  if (won) metrics.wins += 1;
  if (isDealer) {
    metrics.dealerGames += 1;
    if (!summary.kittyGrab) metrics.dealerBottomSaved += 1;
  } else {
    metrics.defenderGames += 1;
    metrics.defenderPointsWhenDefending += summary.defenderPoints;
    if (summary.kittyGrab) metrics.defenderKittyGrabs += 1;
  }
}

function finalizeMetrics(metrics) {
  return {
    games: metrics.games,
    averageUtility: Number((metrics.utility / Math.max(1, metrics.games)).toFixed(3)),
    winRate: Number((metrics.wins / Math.max(1, metrics.games)).toFixed(4)),
    dealerBottomRate: Number(
      (metrics.dealerBottomSaved / Math.max(1, metrics.dealerGames)).toFixed(4)
    ),
    defenderKittyGrabRate: Number(
      (metrics.defenderKittyGrabs / Math.max(1, metrics.defenderGames)).toFixed(4)
    ),
    averageDefenderPoints: Number(
      (metrics.defenderPointsWhenDefending / Math.max(1, metrics.defenderGames)).toFixed(2)
    ),
  };
}

function matchSeeds(baseSeed, count) {
  return Array.from({ length: count }, (_, index) => (baseSeed + index * 9_973) >>> 0);
}

// 每颗种子打两次：候选队分别坐 0/2 和 1/3。庄家座位不变，
// 因此同一手牌上候选策略会各打一次庄家与闲家，减少发牌运气偏差。
async function evaluateCandidate(candidate, baseline, seeds, timeoutMs) {
  const metrics = emptyMetrics();
  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index];
    const fixedDeclarerSeat = index % 4;
    for (const candidateTeam of [0, 1]) {
      const tuningByTeam = candidateTeam === 0
        ? [candidate, baseline]
        : [baseline, candidate];
      const result = await simulateRound({
        seed,
        difficulty: 'expert',
        timeoutMs,
        fixedDeclarerSeat,
        declarationMode: 'patient',
        tuningByTeam,
      });
      if (result.errors.length > 0 || !result.summary?.conservationOk) {
        const reason = result.errors.map(error => error.reason).join('；') || '分数守恒失败';
        throw new Error(`训练局失败 seed=${seed} team=${candidateTeam}：${reason}`);
      }
      addRoundMetrics(metrics, result.summary, candidateTeam);
    }
  }
  return finalizeMetrics(metrics);
}

function updateDistribution(elites, previousDeviation) {
  const mean = {};
  const deviation = {};
  for (const key of Object.keys(DEFAULT_BOT_TUNING)) {
    const values = elites.map(entry => entry.candidate[key]);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length;
    const [min, max] = BOT_TUNING_BOUNDS[key];
    const floor = INTEGER_KEYS.has(key) ? 0.35 : (max - min) * 0.018;
    mean[key] = average;
    deviation[key] = Math.max(floor, Math.sqrt(variance) * 0.85 + previousDeviation[key] * 0.15);
  }
  return { mean, deviation };
}

function roundedTuning(tuning) {
  return Object.fromEntries(Object.entries(tuning).map(([key, value]) => [
    key,
    INTEGER_KEYS.has(key) ? Math.round(value) : Number(value.toFixed(5)),
  ]));
}

export async function trainBots({
  generations = 12,
  population = 14,
  matches = 10,
  holdoutMatches = 60,
  seed = 2026081801,
  timeoutMs = 15_000,
  minimumHoldoutUtility = 0.5,
  outputFile = DEFAULT_BOT_TUNING_FILE,
  write = true,
} = {}) {
  const startedAt = new Date();
  const rng = mulberry32(seed);
  const baseline = normalizeBotTuning(evolvedBotTuning());
  let mean = { ...baseline };
  let deviation = Object.fromEntries(Object.entries(BOT_TUNING_BOUNDS).map(([key, [min, max]]) => [
    key,
    INTEGER_KEYS.has(key) ? 1.05 : (max - min) * 0.19,
  ]));
  const trainingSeeds = matchSeeds(seed + 1_000_000, matches);
  const cache = new Map();
  let best = {
    candidate: baseline,
    metrics: await evaluateCandidate(baseline, baseline, trainingSeeds, timeoutMs),
  };

  console.log(`进化训练开始：${generations} 代 × ${population} 候选 × ${matches} 组换边种子`);
  console.log(`现有策略训练集基线 utility=${best.metrics.averageUtility.toFixed(3)}`);

  for (let generation = 0; generation < generations; generation += 1) {
    const candidates = [normalizeBotTuning(mean)];
    if (generation === 0) candidates.unshift(baseline);
    while (candidates.length < population) candidates.push(sampleCandidate(mean, deviation, rng));

    const evaluated = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const key = candidateKey(candidate);
      let metrics = cache.get(key);
      if (!metrics) {
        metrics = await evaluateCandidate(candidate, baseline, trainingSeeds, timeoutMs);
        cache.set(key, metrics);
      }
      evaluated.push({ candidate, metrics });
    }
    evaluated.sort((a, b) => b.metrics.averageUtility - a.metrics.averageUtility);
    if (evaluated[0].metrics.averageUtility > best.metrics.averageUtility) best = evaluated[0];
    const eliteCount = Math.max(3, Math.ceil(population * 0.28));
    ({ mean, deviation } = updateDistribution(evaluated.slice(0, eliteCount), deviation));
    console.log(
      `第 ${generation + 1}/${generations} 代：本代 ${evaluated[0].metrics.averageUtility.toFixed(3)}` +
      `，全局最好 ${best.metrics.averageUtility.toFixed(3)}` +
      `，胜率 ${(best.metrics.winRate * 100).toFixed(1)}%`
    );
  }

  // 留出种子与训练种子完全分开；同时评价默认权重，它在换边对拍中应接近 0。
  const holdoutSeeds = matchSeeds(seed + 50_000_000, holdoutMatches);
  const validation = await evaluateCandidate(best.candidate, baseline, holdoutSeeds, timeoutMs);
  const baselineValidation = await evaluateCandidate(baseline, baseline, holdoutSeeds, timeoutMs);
  const promoted = validation.averageUtility >= minimumHoldoutUtility;
  const finishedAt = new Date();
  const artifact = {
    schemaVersion: 1,
    algorithm: 'cross-entropy evolutionary self-play',
    fairness: {
      hiddenCardsUsedByPolicy: false,
      pairedTeamSwap: true,
      fixedSeeds: true,
      holdoutSeedsDisjoint: true,
    },
    trainedAt: finishedAt.toISOString(),
    durationSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
    promoted,
    tuning: roundedTuning(promoted ? best.candidate : baseline),
    candidateTuning: roundedTuning(best.candidate),
    baselineTuning: roundedTuning(baseline),
    training: {
      generations,
      population,
      pairedSeeds: matches,
      metrics: best.metrics,
    },
    validation: {
      pairedSeeds: holdoutMatches,
      minimumUtility: minimumHoldoutUtility,
      candidate: validation,
      baseline: baselineValidation,
    },
  };

  if (write) {
    fs.writeFileSync(path.resolve(outputFile), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  }
  console.log(
    `留出验证：候选 utility=${validation.averageUtility.toFixed(3)}` +
    `，基线=${baselineValidation.averageUtility.toFixed(3)}` +
    `，${promoted ? '通过，已晋级' : '未达门槛，保留原策略'}`
  );
  if (write) console.log(`训练产物：${path.resolve(outputFile)}`);
  return artifact;
}

async function main() {
  await trainBots({
    generations: integerArg('generations', 12),
    population: integerArg('population', 14),
    matches: integerArg('matches', 10),
    holdoutMatches: integerArg('holdout', 60),
    seed: integerArg('seed', 2026081801),
    timeoutMs: integerArg('timeout', 15_000),
    minimumHoldoutUtility: numberArg('min-utility', 0.5),
    outputFile: stringArg('output', DEFAULT_BOT_TUNING_FILE),
    write: stringArg('write', 'true') === 'true',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  await main();
}
