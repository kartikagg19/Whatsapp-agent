// ================================================================
//  src/chunker.js — Response Delivery Shaper
// ----------------------------------------------------------------
//  Pure function. Splits an AI reply into 1–3 WhatsApp-style chunks
//  for more conversational delivery. Conservative by design:
//    - short replies pass through as a single message
//    - splits only on \n\n paragraph breaks the prompt already emits
//    - merges tiny adjacent chunks so we never spam 1-liners
//    - caps at 3 chunks (tail is concatenated into the last)
//
//  Tuning knobs live at the top so they can be lifted into
//  settings.json later without touching call sites.
// ================================================================

const SINGLE_MESSAGE_MAX = 220;   // ≤ this length → never split
const MIN_CHUNK_LENGTH   = 120;   // merge into neighbour if shorter
const MAX_CHUNKS         = 3;

/**
 * Split a reply into conversational chunks.
 * @param {string} text raw reply_message from the AI
 * @returns {string[]} 1..MAX_CHUNKS non-empty strings, in order
 */
function splitReply(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Short replies stay as one message — most natural WhatsApp behaviour.
  if (trimmed.length <= SINGLE_MESSAGE_MAX) return [trimmed];

  // Split on blank lines (the prompt is instructed to emit \n\n).
  // Fall back to single chunk if there are no paragraph breaks.
  const parts = trimmed
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) return [trimmed];

  // Merge runs of tiny chunks so we never spam 1-liners.
  const merged = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last.length < MIN_CHUNK_LENGTH) {
      merged[merged.length - 1] = `${last}\n\n${part}`;
    } else {
      merged.push(part);
    }
  }

  // Cap at MAX_CHUNKS — concat any tail into the last chunk.
  if (merged.length <= MAX_CHUNKS) return merged;
  const head = merged.slice(0, MAX_CHUNKS - 1);
  const tail = merged.slice(MAX_CHUNKS - 1).join('\n\n');
  return [...head, tail];
}

module.exports = { splitReply };
