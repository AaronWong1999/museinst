//
// Text renderer (spec §8.5): the same canonical message that Web renders as
// rich cards degrades to readable text + a safe MuseInst link for Telegram /
// WeChat. Unknown card types always fall back to the canonical plain text and
// never break delivery.
//
import type { CanonicalCard, CanonicalMessage } from "./message-contract";
import type { LinkResolver } from "./link-resolver";

/**
 * Render a canonical message as channel text. The canonical `text` is always
 * included verbatim; cards are appended as short text blocks + MuseInst links.
 */
export function renderCanonicalAsText(message: CanonicalMessage, links: LinkResolver): string {
  const parts: string[] = [message.text];
  for (const card of message.cards ?? []) {
    const lines = renderCardAsText(card, links);
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  return parts.filter((p) => p && p.trim().length > 0).join("\n\n");
}

function renderCardAsText(card: CanonicalCard, links: LinkResolver): string[] {
  switch (card.type) {
    case "browser_session":
      return [
        `🌐 ${card.title || "浏览器"}`.trim(),
        `打开浏览器：\n${links.browserGrant(card.ref.sessionRef)}`,
      ];
    case "task":
      return [
        `📋 ${card.title}`,
        card.progress
          ? `${card.progress.completed}${card.progress.total ? `/${card.progress.total}` : ""}${card.progress.current ? ` · ${card.progress.current}` : ""}`
          : "",
      ].filter(Boolean);
    case "approval":
      return [
        `[需要确认] ${card.summary}`,
        card.target ? `对象：${card.target}` : "",
        `打开确认：\n${links.approval(card.approvalId)}`,
      ].filter(Boolean);
    case "file":
      return [`📄 ${card.name}`, `打开文件（短时有效）：\n${links.file(card.artifactId)}`];
    case "email":
      return [`✉️ ${card.subject}`, card.snippet ?? ""].filter(Boolean);
    case "automation":
      return [
        `⏰ ${card.title}`,
        card.lastRun ? `${card.lastRun.state} · ${card.lastRun.delivery}` : "",
      ].filter(Boolean);
    case "connector":
      return [`🔌 ${card.provider} · ${card.state}`];
    case "goal":
      return [`🎯 ${card.title}`];
    case "document":
      return [`📝 ${card.documentKind}`];
    default:
      // Unknown card type contributes nothing beyond the canonical text.
      return [];
  }
}
