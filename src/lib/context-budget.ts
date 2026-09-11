import type { RewriteMessage } from "./types";

/**
 * Rough token estimate. Deliberately conservative: ASCII counts as 4 characters per token,
 * everything else (CJK and other wide scripts) as 1 character per token. Good enough to keep
 * a prompt inside a model window without pulling in a tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  const wide = (text.match(/[^\x00-\x7F]/g) || []).length;
  return Math.ceil((text.length - wide) / 4) + wide;
}

/**
 * Input context windows for known model families, matched in order against AI_MODEL.
 * Unknown models fall back to DEFAULT_CONTEXT_WINDOW; AI_MAX_CONTEXT overrides everything.
 */
const CONTEXT_WINDOWS: { pattern: RegExp; tokens: number }[] = [
  { pattern: /gemini-1\.5-pro/i, tokens: 2_097_152 },
  { pattern: /gemini/i, tokens: 1_048_576 },
  { pattern: /claude/i, tokens: 200_000 },
  { pattern: /gpt-4\.1|gpt-4o|gpt-4-turbo|o[134]/i, tokens: 128_000 },
  { pattern: /deepseek|qwen|glm|mistral/i, tokens: 128_000 }
];

const DEFAULT_CONTEXT_WINDOW = 128_000;
const SAFETY_TOKENS = 2_000;
/** Cost guard: never let a long conversation dominate the bill, even on a 1M-token window. */
const MAX_CONVERSATION_TOKENS = 60_000;

export function contextWindowFor(model: string): number {
  const override = Number(process.env.AI_MAX_CONTEXT);
  if (Number.isFinite(override) && override > 0) return override;
  return CONTEXT_WINDOWS.find(({ pattern }) => pattern.test(model))?.tokens ?? DEFAULT_CONTEXT_WINDOW;
}

export interface ConversationPlan {
  windowTokens: number;
  availableTokens: number;
  droppedTurns: number;
  turns: RewriteMessage[];
}

/**
 * Keep the newest turns that fit, dropping the oldest first.
 *
 * Dropping is safe here: the current draft is sent separately as structured input and already
 * carries every adopted change, so older turns only carry intent. The caller must still tell
 * the model which turns were dropped.
 */
export function planConversation(
  model: string,
  fixedTokens: number,
  outputTokens: number,
  turns: RewriteMessage[]
): ConversationPlan {
  const windowTokens = contextWindowFor(model);
  const availableTokens = Math.max(0, Math.min(windowTokens - fixedTokens - outputTokens - SAFETY_TOKENS, MAX_CONVERSATION_TOKENS));
  const kept: RewriteMessage[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const cost = estimateTokens(turns[index].text) + 8;
    // The most recent turn is always kept: it is the instruction being answered.
    if (kept.length && used + cost > availableTokens) break;
    used += cost;
    kept.unshift(turns[index]);
  }
  return { windowTokens, availableTokens, droppedTurns: turns.length - kept.length, turns: kept };
}
