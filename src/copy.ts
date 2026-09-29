export type Lang = "zh" | "en";

export function pickLang(v: string | null | undefined): Lang {
  return v === "en" ? "en" : "zh";
}

export function detectLangFromRequest(req: Request): Lang {
  try {
    const url = new URL(req.url);
    if (url.pathname === "/en" || url.searchParams.get("lang") === "en") return "en";
    const cookie = req.headers.get("cookie") ?? "";
    const m = cookie.match(/(?:^|;\s*)oi_lang=(zh|en)/);
    if (m) return pickLang(m[1]);
    const al = req.headers.get("accept-language") ?? "";
    if (/^en\b/i.test(al)) return "en";
  } catch { /* ignore */ }
  return "zh";
}

export const LANG_COOKIE = "oi_lang=LANG; Path=/; SameSite=Lax; Max-Age=31536000";

export const brand = { name: "MuseInst" } as const;

export const navCopy = {
  zh: { why: "优势", recipes: "任务配方", login: "登录", github: "GitHub ★", home: "回到首页", console: "进入控制台 →", backHome: "回首页" },
  en: { why: "Why", recipes: "Recipes", login: "Log in", github: "GitHub ★", home: "Home", console: "Open console →", backHome: "Back home" },
} as const;

export const consoleCopy = {
  zh: {
    workspace: "Workspace", vault: "Vault", tasks: "Tasks", recipes: "Recipes", settings: "Settings",
    accountBinding: "账号绑定",
    startTexting: "Start texting MuseInst",
    startTextingSub: "支持同时绑定微信与 Telegram，跨聊天软件随时与 Agent 对话",
    startTextingNote: "（无论在哪个软件发送指令，都由同一个 Agent 响应，共享记忆与数据）",
    needLogin: "请从聊天软件里的链接进入，或在控制台登录。",
    unboundBanner: "还没绑定任何聊天渠道 —— 先绑定微信或 Telegram，否则 Agent 联系不上你。",
    manageBindings: "管理绑定",
    contactInfo: "你的个人 Agent 住在这些聊天软件里。微信和 Telegram 支持同时绑定，跨软件共享同一份记忆与凭证。",
    usageNote: "按 Workers AI 官方标价估算，实际以你的 Cloudflare 账单为准。",
  },
  en: {
    workspace: "Workspace", vault: "Vault", tasks: "Tasks", recipes: "Recipes", settings: "Settings",
    accountBinding: "Account binding",
    startTexting: "Start texting MuseInst",
    startTextingSub: "Bind WeChat and Telegram at the same time; talk to your agent from either app",
    startTextingNote: "(Whichever app you message from, the same agent answers — shared memory and data.)",
    needLogin: "Please enter via the link in your chat app, or log into the console.",
    unboundBanner: "No chat channel bound yet — bind WeChat or Telegram first, otherwise your agent can't reach you.",
    manageBindings: "Manage bindings",
    contactInfo: "Your personal agent lives in these chat apps. WeChat and Telegram can both be bound, sharing one memory and one Vault across apps.",
    usageNote: "Estimated from Workers AI list prices; your actual Cloudflare bill is authoritative.",
  },
} as const;

export const chatCopy = {
  zh: {
    unboundGuide: "你好！我是 MuseInst —— 一个能替你办事的个人 Agent。\n\n请在网页端控制台登录后获取绑定码，直接发送：/bind 绑定码 即可完成账号绑定。",
    bindUsage: "用法：/bind 绑定码\n绑定码可在网页端控制台获取。",
    invalidCode: "这个绑定码无效或已过期。请在网页端控制台重新获取后重试。",
    duplicateBind: "这个渠道已经绑定了另一个 MuseInst 账号。一个微信/Telegram 只能绑定一个账号。",
    cooldownLeft: (days: number) => `这个渠道刚从另一个账号解绑，还需 ${days} 天才能绑到新账号（防刷保护）。到期后再试，或继续用原账号。`,
    firstOwner: "🔑 这是这个 MuseInst 实例的第一条消息，所以你现在是它的主人（admin）。\n\n从这里开始你可以直接使唤我：\n· 「帮我看看今天日历上有什么」\n· 「把机票确认邮件加到日历」\n· 「记住：我以后飞机尽量靠窗」\n\n控制台（5 分钟内有效）：稍后发 /bind 可随时取新链接。",
    loginLink: (base: string, nonce: string) => `这是你的控制台入口（5 分钟内有效，只可用一次）：\n${base}/bind/${nonce}`,
    boundOk: (base: string, nonce: string) => `✅ 已绑定。这是你的控制台入口（5 分钟内有效）：\n${base}/bind/${nonce}`,
    firstTasks: [
      "试试让我做一件真事（点一条直接发给我）：\n1. 「找到我最近一封机票或酒店确认邮件，加到日历」\n2. 「找出今天最需要我回复的 3 封邮件」\n3. 「找到我的下一场会议，告诉我要准备什么」",
      "试试让我做一件真事（点一条直接发给我）：\n1. 「告诉我现在最需要处理的 3 个 PR / Issue」\n2. 「把我刚才说的 bug 建成一个 GitHub issue」\n3. 「总结一下这个仓库最近的动态」",
      "试试让我做一件真事（点一条直接发给我）：\n1. 「登录一个网站，帮我找上个月的发票」（先去控制台 Vault 存好登录信息）\n2. 「帮我查这笔订单现在到哪了」\n3. 「帮我填这个报名/预约页面，提交前给我确认」",
    ],
    approvalAsk: (desc: string, code: string) => `⚠️ 需要你确认：\n${desc}\n\n回复「批准」继续，「拒绝」取消。（${code} 也可以）`,
    modelFailed: "模型调用失败，稍后再试一次。",
    modelResumeFailed: "继续处理时模型调用失败。",
    taskFailed: "任务失败",
    voiceFailed: "这条语音没能转写出来，打字发我可以直接处理。",
    numericNoWait: "收到一串数字，但现在没有在等待验证码的任务，所以我不会保存它。要办什么直接说。",
    locationSaved: "📍 位置已记录。你可以随时问我「我的车停哪了 / 附近有什么吃的」，或说「到家提醒我拿快递」来设围栏提醒。实时共享期间我会持续更新位置。",
    capacityFree: "当前任务队列繁忙，请稍后重试。",
    hostBlocked: "本轮被宿主策略拦截。",
    receiptShare: "可以分享这张凭证。",
    groupRejected: "群里人多嘴杂容易串号 —— 请先私聊我完成绑定，再回群里用。",
    groupDmOnly: (username?: string) =>
      `我目前只在私聊里工作。${username ? `私聊 @${username} ` : "私聊我 "}继续。`,
    unsupportedMedia: "暂不支持图片/文件/贴纸/视频，请用文字或语音描述你想办的事。",
  },
  en: {
    unboundGuide: "Hi! I'm MuseInst — a personal agent that gets things done for you.\n\nPlease log into the web console to get your binding code, then send: /bind CODE to connect your account.",
    bindUsage: "Usage: /bind CODE\nYou can obtain your binding code from the web console.",
    invalidCode: "That binding code is invalid or has expired. Please get a new one from the console and try again.",
    duplicateBind: "This channel is already bound to another MuseInst account. One WeChat/Telegram maps to one account.",
    cooldownLeft: (days: number) => `This channel was just unbound from another account and needs ${days} more day(s) before it can bind to a new one (anti-abuse). Try again when it expires, or keep using the original account.`,
    firstOwner: "🔑 First message on this instance — you're its owner (admin) now.\n\nJust tell me what to do:\n· \"What's on my calendar today?\"\n· \"Add the flight confirmation to my calendar\"\n· \"Remember: aisle seat for flights\"\n\nConsole link (valid 5 min): send /bind anytime for a new link.",
    loginLink: (base: string, nonce: string) => `Your console link (valid 5 min, one-time use):\n${base}/bind/${nonce}`,
    boundOk: (base: string, nonce: string) => `✅ Bound. Your console link (valid 5 min):\n${base}/bind/${nonce}`,
    firstTasks: [
      "Try giving me one real task (tap one and send it):\n1. \"Find my latest flight/hotel confirmation and add it to my calendar\"\n2. \"Which 3 emails need my reply most today?\"\n3. \"What's my next meeting, and what should I prepare?\"",
      "Try giving me one real task:\n1. \"Which 3 PRs/issues need me most right now?\"\n2. \"File the bug I just mentioned as a GitHub issue\"\n3. \"Summarize what's new in this repo\"",
      "Try giving me one real task:\n1. \"Log into a site and find last month's invoices\" (save the login in the console Vault first)\n2. \"Where is my parcel now?\"\n3. \"Fill in this signup/booking page; confirm with me before submitting\"",
    ],
    approvalAsk: (desc: string, code: string) => `⚠️ Your approval needed:\n${desc}\n\nReply "approve" to continue, "deny" to cancel. (${code} works too)`,
    modelFailed: "Model call failed, please retry.",
    modelResumeFailed: "Model call failed while resuming.",
    taskFailed: "Task failed",
    voiceFailed: "Couldn't transcribe that voice message — type it and I can handle it directly.",
    numericNoWait: "Got a numeric code, but nothing is waiting for it right now — I won't store it. What can I do for you?",
    locationSaved: "📍 Location noted. Ask \"where's my car?\" or \"lunch nearby?\", or say \"remind me to grab the package when I'm home\" to set a geofence reminder. I'll keep updating while you share live.",
    capacityFree: "Tasks are currently queued. Please try again later.",
    hostBlocked: "Blocked by host policy.",
    receiptShare: "You can share this receipt.",
    groupRejected: "Groups get confusing fast — please DM me to finish binding first, then use me back in the group.",
    groupDmOnly: (username?: string) =>
      `I currently work in direct messages. ${username ? `DM @${username} ` : "DM me "}to continue.`,
    unsupportedMedia: "Photos, files, stickers and videos aren't supported yet — describe it in text or send a voice message.",
  },
} as const;

export type ChatCopy = (typeof chatCopy)["zh"];
