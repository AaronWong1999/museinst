

interface P {
  className?: string;
  size?: number;
}

const S = (p: P) => ({ width: p.size ?? 20, height: p.size ?? 20, viewBox: "0 0 24 24", fill: "none" });

export const IconWeChat = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M9.5 4C5.9 4 3 6.4 3 9.4c0 1.7.9 3.2 2.4 4.2l-.6 2 2.2-1.1c.8.2 1.6.3 2.5.3h.4A5.5 5.5 0 0 1 9.5 4z" fill="#16A34A" />
    <path d="M15.5 8.5c-3 0-5.5 2-5.5 4.6 0 2.5 2.5 4.6 5.5 4.6.7 0 1.4-.1 2-.3l1.9.9-.5-1.7c1.3-.9 2.1-2.2 2.1-3.6 0-2.5-2.5-4.5-5.5-4.5z" fill="#16A34A" opacity=".55" />
  </svg>
);

export const IconTelegram = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <circle cx="12" cy="12" r="9" fill="#229ED9" />
    <path d="M6.2 11.7l9.3-3.6c.6-.2 1 .2.8.9l-1.6 7.4c-.1.6-.5.7-1 .4l-2.7-2-1.3 1.3c-.2.2-.3.3-.6.3l.2-2.9 5.3-4.8c.2-.2 0-.3-.3-.1l-6.6 4.1-2.8-.9c-.6-.2-.6-.6.3-.1z" fill="#fff" />
  </svg>
);

export const IconGoogle = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z" fill="#4285F4" />
    <path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853" />
    <path d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z" fill="#FBBC05" />
    <path d="M12 6c1.5 0 2.8.5 3.8 1.5L18.7 5A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z" fill="#EA4335" />
  </svg>
);

export const IconGitHub = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5A3.9 3.9 0 0 1 6.6 8.7a3.6 3.6 0 0 1 .1-2.7s.9-.3 2.8 1a9.5 9.5 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1.1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" fill="#171717" />
  </svg>
);

export const IconFeishu = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M4 8c4-4 10-4.5 15-2.5 1 .4 1.6 1.5 1 2.5-2 3.5-6 6.5-9.5 7.5C7 16.6 4 14 4 10.5V8z" fill="#171717" opacity=".9" />
    <path d="M6 17c3.5-1 8.5-4 11-8-1.5 5-5.5 9.5-9 11l-2-3z" fill="#171717" opacity=".5" />
  </svg>
);

export const IconMail = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="#171717" strokeWidth="1.6" />
    <path d="M4 7l8 6 8-6" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const IconVault = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="#171717" strokeWidth="1.6" />
    <circle cx="12" cy="12" r="3.5" stroke="#171717" strokeWidth="1.6" />
    <path d="M12 8.5v-1M12 16.5v-1M15.5 12h1M7.5 12h1" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const IconWorkspace = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="#171717" strokeWidth="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="#171717" strokeWidth="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="#171717" strokeWidth="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="#171717" strokeWidth="1.6" />
  </svg>
);

export const IconTasks = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M4 6.5l2 2 3.5-3.5" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 17.5l2 2 3.5-3.5" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M13 7h7M13 18h7" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const IconRecipes = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M6 3v7a3 3 0 0 0 3 3v8" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M9 3v5M12 3v5" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M17 3c-1.5 1.5-2 4-2 6.5V21" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M4 12.5l5 5L20 6.5" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconCopy = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export const IconChevron = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M8 10l4 4 4-4" stroke="#737373" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconInfo = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <circle cx="12" cy="12" r="8.5" stroke="#A3A3A3" strokeWidth="1.4" />
    <path d="M12 11v5" stroke="#A3A3A3" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="12" cy="8" r="1" fill="#A3A3A3" />
  </svg>
);

export const IconKey = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <circle cx="8" cy="14" r="4" stroke="#171717" strokeWidth="1.6" />
    <path d="M11 11l8-8M16 6l2.5 2.5M13.5 8.5L16 11" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const IconCard = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="#171717" strokeWidth="1.6" />
    <path d="M3 10h18" stroke="#171717" strokeWidth="1.6" />
  </svg>
);

export const IconHome = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M4 11l8-7 8 7v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8z" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

export const IconSettings = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.7" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export const IconMicrosoft = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <rect x="3.5" y="3.5" width="7.6" height="7.6" fill="#F25022" />
    <rect x="12.9" y="3.5" width="7.6" height="7.6" fill="#7FBA00" />
    <rect x="3.5" y="12.9" width="7.6" height="7.6" fill="#00A4EF" />
    <rect x="12.9" y="12.9" width="7.6" height="7.6" fill="#FFB900" />
  </svg>
);

export const IconLinear = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M3.2 13.9l6.9 6.9A9 9 0 0 1 3.2 13.9z" fill="#5E6AD2" />
    <path d="M3 11.2l9.8 9.8a9 9 0 0 0 2.6-.7L3.7 8.6A9 9 0 0 0 3 11.2z" fill="#5E6AD2" />
    <path d="M4.4 6.6l13 13a9.2 9.2 0 0 0 1.8-1.4L5.8 4.8a9.2 9.2 0 0 0-1.4 1.8z" fill="#5E6AD2" />
    <path d="M7.2 3.8l13 13A9 9 0 1 0 7.2 3.8z" fill="#5E6AD2" />
  </svg>
);

export const IconSlack = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M9.1 2.5a1.9 1.9 0 0 0 0 3.8h1.9V4.4a1.9 1.9 0 0 0-1.9-1.9zM9.1 7.3H4.4a1.9 1.9 0 1 0 0 3.8h4.7a1.9 1.9 0 1 0 0-3.8z" fill="#36C5F0" />
    <path d="M21.5 9.1a1.9 1.9 0 1 0-3.8 0V11h1.9a1.9 1.9 0 0 0 1.9-1.9zM16.7 9.1V4.4a1.9 1.9 0 1 0-3.8 0v4.7a1.9 1.9 0 1 0 3.8 0z" fill="#2EB67D" />
    <path d="M14.9 21.5a1.9 1.9 0 0 0 0-3.8H13v1.9a1.9 1.9 0 0 0 1.9 1.9zM14.9 16.7h4.7a1.9 1.9 0 1 0 0-3.8h-4.7a1.9 1.9 0 1 0 0 3.8z" fill="#ECB22E" />
    <path d="M2.5 14.9a1.9 1.9 0 1 0 3.8 0V13H4.4a1.9 1.9 0 0 0-1.9 1.9zM7.3 14.9v4.7a1.9 1.9 0 1 0 3.8 0v-4.7a1.9 1.9 0 1 0-3.8 0z" fill="#E01E5A" />
  </svg>
);

export const IconGranola = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="#737373" strokeWidth="1.6" />
    <path d="M7 9.5h10M7 13h10M7 16.5h6" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const IconLocation = (p: P) => (
  <svg {...S(p)} className={p.className}>
    <path d="M12 21s-6.5-5.4-6.5-10.2a6.5 6.5 0 1 1 13 0C18.5 15.6 12 21 12 21z" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="10.5" r="2.4" stroke="currentColor" strokeWidth="1.7" />
  </svg>
);
