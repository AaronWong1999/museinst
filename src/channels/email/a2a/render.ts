


import type { A2aMessageType } from "./schema";
import type { ScheduleFacts } from "./disclosure";

export function renderHumanBody(opts: {
  type: A2aMessageType;
  intent: "coordinate.schedule";
  facts: ScheduleFacts;
  convo: string;
  seq: number;
  lang?: "zh" | "en";
  note?: string;
}): string {
  const lang = opts.lang ?? "zh";
  const windows = (opts.facts.freeBusyWindows ?? [])
    .map((w) => `${w.start} ~ ${w.end}（${w.status === "busy" ? (lang === "zh" ? "忙" : "busy") : (lang === "zh" ? "空闲" : "free")}）`)
    .join("\n");
  const city = opts.facts.broadCity ? (lang === "zh" ? `城市：${opts.facts.broadCity}\n` : `City: ${opts.facts.broadCity}\n`) : "";
  const tz = opts.facts.timezone ? (lang === "zh" ? `时区：${opts.facts.timezone}\n` : `Timezone: ${opts.facts.timezone}\n`) : "";
  const head = lang === "zh"
    ? { propose: "【会议协调】对方助理发起时间协调", counter: "【会议协调】对方建议了新的时间", accept: "【会议协调】对方接受了时间", decline: "【会议协调】对方拒绝了该时间", cancel: "【会议协调】对方取消了协调", confirm: "【会议协调】时间已确认", error: "【会议协调】对方同步了受限错误信息" }
    : { propose: "[Scheduling] Their assistant proposed times", counter: "[Scheduling] New times proposed", accept: "[Scheduling] Time accepted", decline: "[Scheduling] Time declined", cancel: "[Scheduling] Scheduling cancelled", confirm: "[Scheduling] Time confirmed", error: "[Scheduling] Limited error notice" };
  const lines = [head[opts.type], `${lang === "zh" ? "会话" : "Convo"}: ${opts.convo} (#${opts.seq})`];
  if (city) lines.push(city.trim());
  if (tz) lines.push(tz.trim());
  if (windows) lines.push(`${lang === "zh" ? "时间窗口" : "Windows"}:\n${windows}`);
  if (opts.facts.meetingPreference) lines.push(`${lang === "zh" ? "偏好" : "Preference"}: ${opts.facts.meetingPreference}`);
  if (opts.note) lines.push(opts.note);
  lines.push(lang === "zh" ? "（这是两个助理之间的自动协调记录；需要你确认的事项会单独通知你。）" : "(Automated coordination between assistants; anything needing you will be sent separately.)");
  return lines.join("\n");
}
