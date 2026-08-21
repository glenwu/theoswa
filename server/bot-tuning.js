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

// 惰性 + 记忆化：import 本模块不应该产生磁盘 IO。
// 之前是顶层 `Object.freeze(loadEvolvedBotTuning())`，任何人 import 一下
// （包括只想用类型或常量的测试）都会立刻读盘，且 BOT_TUNING_FILE 在 import
// 之后再设就不生效了。改成首次真正需要时才读，读一次缓存住。
let cachedTuning = null;

export function evolvedBotTuning() {
  cachedTuning ??= Object.freeze(loadEvolvedBotTuning());
  return cachedTuning;
}

// 测试用：丢弃缓存，让下一次 evolvedBotTuning() 重新读盘
export function resetEvolvedBotTuningCache() {
  cachedTuning = null;
}
