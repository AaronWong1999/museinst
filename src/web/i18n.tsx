


import React from "react";
import type { Lang } from "../copy";
import { pickLang } from "../copy";

const KEY = "oi_lang";

export function initialLang(): Lang {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "zh" || q === "en") return q;
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") return pickLang(saved);
    if (/^en\b/i.test(navigator.language ?? "")) return "en";
  } catch { /* ignore */ }
  return "zh";
}

const LangCtx = React.createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: "zh", setLang: () => {} });

export function LangProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [lang, setLangState] = React.useState<Lang>(() => initialLang());
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
      document.cookie = `oi_lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax`;
      document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    } catch { /* ignore */ }
  };
  React.useEffect(() => {
    try { document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"; } catch { /* ignore */ }
  }, [lang]);
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export function useLang(): { lang: Lang; setLang: (l: Lang) => void } {
  return React.useContext(LangCtx);
}

export function LangToggle(): React.ReactElement {
  const { lang, setLang } = useLang();
  return (
    <button
      onClick={() => setLang(lang === "zh" ? "en" : "zh")}
      className="text-[13px] text-[#737373] hover:text-black border border-[#E5E5E5] rounded-lg px-2.5 h-8 whitespace-nowrap"
      title={lang === "zh" ? "Switch to English" : "切换到中文"}
    >
      {lang === "zh" ? "EN" : "中文"}
    </button>
  );
}
