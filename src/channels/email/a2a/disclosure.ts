


export interface ScheduleFacts {
  freeBusyWindows?: Array<{ start: string; end: string; status: "free" | "busy" }>;
  timezone?: string;
  broadCity?: string;
  meetingPreference?: string;
}

const ALLOWED_KEYS = new Set(["freeBusyWindows", "timezone", "broadCity", "meetingPreference"]);

export function serializeDisclosure(input: Record<string, unknown>): ScheduleFacts {
  const out: ScheduleFacts = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (k === "timezone" && typeof v === "string" && v.length <= 64) out.timezone = v;
    else if (k === "broadCity" && typeof v === "string" && v.length <= 64) out.broadCity = v;
    else if (k === "meetingPreference" && typeof v === "string" && v.length <= 280) out.meetingPreference = v;
    else if (k === "freeBusyWindows" && Array.isArray(v)) {
      out.freeBusyWindows = (v as Array<{ start?: string; end?: string; status?: string }>)
        .filter((w) => typeof w?.start === "string" && typeof w?.end === "string")
        .slice(0, 20)
        .map((w) => ({ start: String(w.start), end: String(w.end), status: w.status === "busy" ? "busy" as const : "free" as const }));
    }
  }
  return out;
}


export function readDisclosedFacts(opts: {
  convoPayload: Record<string, unknown>;
  allowEventTitle?: boolean;
  eventTitle?: string;
}): ScheduleFacts {
  const base = serializeDisclosure(opts.convoPayload ?? {});
  void opts.allowEventTitle;
  void opts.eventTitle;
  return base;
}
