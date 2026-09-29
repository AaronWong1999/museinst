


export interface ParsedSchedule {
  ok: boolean;
  windows?: Array<{ start: string; end: string }>;
  timezone?: string;
  broadCity?: string;
  meetingPreference?: string;
  confidence: number;
  reason?: string;
}

const TZ_RE = /\b(UTC([+-]\d{1,2}(?::?\d{2})?)|GMT([+-]\d{1,2}(?::?\d{2})?)|Asia\/[A-Za-z_]+|America\/[A-Za-z_]+|Europe\/[A-Za-z_]+|Australia\/[A-Za-z_]+)\b/;
const DATETIME_RE = /(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::\d{2})?(\s*(?:[+-]\d{2}:?\d{2}|Z))?/g;
const CN_DATETIME_RE = /(\d{1,2})月(\d{1,2})[日号]\s*(\d{1,2})[点:：](\d{2})?/g;





export function parseHumanScheduleReply(text: string, nowMs = Date.now()): ParsedSchedule {
  const t = String(text ?? "");
  const windows: Array<{ start: string; end: string }> = [];
  for (const m of t.matchAll(DATETIME_RE)) {
    const start = `${m[1]}T${m[2]}:00${m[3] ?? ""}`;
    windows.push({ start, end: start });
    if (windows.length >= 5) break;
  }
  for (const m of t.matchAll(CN_DATETIME_RE)) {
    const year = new Date(nowMs).getFullYear();
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    const hh = String(m[3]).padStart(2, "0");
    const mi = String(m[4] ?? "00").padStart(2, "0");
    windows.push({ start: `${year}-${mm}-${dd}T${hh}:${mi}:00`, end: `${year}-${mm}-${dd}T${hh}:${mi}:00` });
    if (windows.length >= 5) break;
  }
  const tzM = t.match(TZ_RE);
  const timezone = tzM ? tzM[0] : undefined;
  const decline = /不行|没空|拒绝|算了|取消|no|cancel|decline|busy/i.test(t);
  const accept = /可以|好的|同意|确认|OK|ok|yes|confirm|works|fine/i.test(t);
  if (windows.length === 0 && !accept && !decline) {
    return { ok: false, confidence: 0.2, reason: "no_time_or_decision" };
  }
  if (decline && windows.length === 0) {
    return { ok: true, confidence: 0.8, reason: "declined" };
  }
  const confidence = windows.length > 0 ? (timezone ? 0.85 : 0.6) : 0.55;
  return {
    ok: confidence >= 0.5,
    windows: windows.length > 0 ? windows : undefined,
    timezone,
    confidence,
    reason: confidence >= 0.5 ? undefined : "low_confidence",
  };
}


export function needsOwnerReview(parsed: ParsedSchedule): boolean {
  return !parsed.ok || parsed.confidence < 0.7;
}
