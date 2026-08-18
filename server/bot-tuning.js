import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOT_TUNING, normalizeBotTuning } from './bot-policy.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BOT_TUNING_FILE = path.join(moduleDir, 'bot-evolved.json');

export function loadEvolvedBotTuning(filePath = process.env.BOT_TUNING_FILE) {
  const resolved = filePath ? path.resolve(filePath) : DEFAULT_BOT_TUNING_FILE;
  if (!fs.existsSync(resolved)) return normalizeBotTuning(DEFAULT_BOT_TUNING);
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return normalizeBotTuning(parsed.tuning ?? parsed);
  } catch (error) {
    console.warn(`[电脑玩家] 无法读取进化权重 ${resolved}，已回退默认值：${error.message}`);
    return normalizeBotTuning(DEFAULT_BOT_TUNING);
  }
}

export const EVOLVED_BOT_TUNING = Object.freeze(loadEvolvedBotTuning());
