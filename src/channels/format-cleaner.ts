// format-cleaner.ts — Sanitizes unescaped tool call DSL/XML leakage from assistant outputs.
// Contract invariant:
// 1. Fenced code blocks (``` ... ```) and inline code (` ... `) are PRESERVED 100% intact.
//    Legitimate documentation, XML/JSON examples, and code explanations are NEVER corrupted.
// 2. Only unescaped/leaked model protocol frames outside code blocks are stripped.
// 3. Streaming buffer has a 512-byte limit to prevent swallowing regular user text if an unclosed tag occurs.

const PRIV_OPEN = "\uE000__CODE_";
const PRIV_CLOSE = "__\uE001";

/**
 * Strip leaked tool call DSL tokens while preserving fenced code blocks and inline code.
 */
export function stripToolCallDSL(text: string): string {
  if (!text) return "";

  // 1. Extract and protect fenced code blocks and inline code
  const codeBlocks: string[] = [];
  let tokenCounter = 0;

  // Protect triple-backtick fenced blocks (```...```) or inline code (`...`)
  const protectedText = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const token = `${PRIV_OPEN}${tokenCounter++}${PRIV_CLOSE}`;
    codeBlocks.push(match);
    return token;
  });

  // 2. Strip leaked protocol markup on text OUTSIDE code blocks
  const cleaned = protectedText
    // DSML tool calls
    .replace(/<[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>[\s\S]*?<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/gi, "")
    .replace(/<[｜|]?\s*DSML\s*[｜|]?\s*\/?\s*tool_calls?\s*>/gi, "")
    // Standard invoke / parameter / function / tool_call tags
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, "")
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<\/?(?:invoke|function|parameter|tool_calls?)\b[^>]*>/gi, "")
    // Stray unclosed DSML lines
    .replace(/^\s*[<＜][｜|]?\s*DSML[｜|]?.*$/gim, "")
    .replace(/^\s*[<＜]\s*\/\s*[｜|]?\s*DSML[｜|]?.*$/gim, "");

  // 3. Restore protected code blocks
  return cleaned.replace(new RegExp(`${PRIV_OPEN}(\\d+)${PRIV_CLOSE}`, "g"), (_, idx) => {
    return codeBlocks[Number(idx)] ?? "";
  });
}

/**
 * Streaming window cleaner with sliding buffer and 512-byte anti-swallowing limit.
 */
export function createDSLStreamCleaner() {
  let pending = "";
  let inDslBlock = false;
  let swallowed = "";
  const MAX_PENDING = 512;

  const cleanComplete = (input: string): string => {
    let text = input;
    let out = "";
    while (text) {
      if (inDslBlock) {
        const close = text.search(/<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        if (close < 0) {
          swallowed += text;
          if (swallowed.length > MAX_PENDING) {
            // Reached limit: treat as legitimate text to avoid swallowing user content
            const flushed = swallowed;
            swallowed = "";
            inDslBlock = false;
            return out + flushed;
          }
          return out;
        }
        swallowed = "";
        const rest = text.slice(close);
        const closeMatch = rest.match(/^<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        text = rest.slice(closeMatch?.[0].length || 0);
        inDslBlock = false;
        continue;
      }

      const open = text.search(/<[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      if (open < 0) {
        out += stripToolCallDSL(text);
        break;
      }
      out += stripToolCallDSL(text.slice(0, open));
      const rest = text.slice(open);
      const openMatch = rest.match(/^<[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      text = rest.slice(openMatch?.[0].length || 0);
      inDslBlock = true;
    }
    return out;
  };

  return {
    push(chunk: string): string {
      pending += chunk;
      const keepFrom = Math.max(
        pending.lastIndexOf("<"),
        pending.lastIndexOf("＜"),
        pending.lastIndexOf("<｜DSML"),
        pending.lastIndexOf("<|DSML")
      );
      const keep = keepFrom >= 0 && pending.length - keepFrom < MAX_PENDING ? pending.slice(keepFrom) : "";
      const complete = keep ? pending.slice(0, -keep.length) : pending;
      pending = keep;
      return cleanComplete(complete);
    },
    flush(): string {
      const out = cleanComplete(pending);
      pending = "";
      return out;
    },
  };
}
