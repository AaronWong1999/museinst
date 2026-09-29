import React from "react";
import { api } from "../api";
import { LangToggle } from "../i18n";

interface RecipeRow {
  slug: string;
  title: string;
  description: string;
  connectors: string[];
  locale: string;
  runs: number;
}

interface RecipeDetail {
  title: string;
  description: string;
  runs: number;
  slug: string;
  data: {
    goal: string;
    steps: string[];
    connectors: string[];
    sites?: string[];
    approvalPoints: string[];
    lang: string;
  };
}

export default function Recipes({ nav, slug }: { nav: (to: string) => void; slug?: string }): React.ReactElement {
  return (
    <div className="min-h-screen bg-white">
      <header className="flex items-center justify-between h-14 border-b border-[#EFEFEF] px-6">
        <a href="/workspace" className="wordmark text-[22px]">MuseInst</a>
        <div className="flex items-center gap-4">
          <a href="/workspace" className="text-[14px] text-[#737373] hover:text-black">Workspace</a>
          <LangToggle />
        </div>
      </header>
      <main className="max-w-[620px] mx-auto px-4 py-12 pb-24">
        {slug ? <Detail slug={slug} nav={nav} /> : <Catalog nav={nav} />}
      </main>
    </div>
  );
}

function Catalog({ nav }: { nav: (to: string) => void }): React.ReactElement {
  const [recipes, setRecipes] = React.useState<RecipeRow[] | null>(null);
  React.useEffect(() => {
    api<{ recipes: RecipeRow[] }>("/api/recipes").then((r) => setRecipes(r.recipes)).catch(() => setRecipes([]));
  }, []);
  return (
    <>
      <h1 className="wordmark text-[40px]">任务配方</h1>
      <p className="text-[15px] text-[#737373] mt-3 leading-relaxed">
        这个自托管实例保存的任务模板。你可以查看步骤、所需连接器，并在自己的 Workspace 中再次执行。
      </p>
      <div className="mt-8 space-y-3">
        {(recipes ?? []).map((r) => (
          <button key={r.slug} onClick={() => nav(`/recipe/${r.slug}`)} className="w-full text-left border border-[#E5E5E5] rounded-xl p-5 hover:bg-[#FAFAFA]">
            <div className="text-[15px] font-medium">{r.title}</div>
            <div className="text-[13px] text-[#737373] mt-1">{r.description}</div>
            <div className="mt-2 flex gap-2 text-[11px] text-[#A3A3A3]">
              {r.connectors.map((c) => (
                <span key={c} className="border border-[#EFEFEF] rounded px-1.5 py-0.5">{c}</span>
              ))}
              <span>{r.runs} 次运行</span>
            </div>
          </button>
        ))}
        {recipes !== null && recipes.length === 0 && (
          <div className="border border-dashed border-[#E5E5E5] rounded-xl p-10 text-center text-[14px] text-[#A3A3A3]">
            当前实例还没有保存任务配方。
          </div>
        )}
      </div>
    </>
  );
}

function Detail({ slug, nav }: { slug: string; nav: (to: string) => void }): React.ReactElement {
  const [r, setR] = React.useState<RecipeDetail | null>(null);
  React.useEffect(() => {
    api<RecipeDetail>(`/api/recipe/${slug}`).then(setR).catch(() => nav("/recipes"));
  }, [slug]);
  if (!r) return <div className="text-[14px] text-[#A3A3A3]">加载中…</div>;
  return (
    <>
      <button onClick={() => nav("/recipes")} className="text-[13px] text-[#737373] hover:text-black">← 全部配方</button>
      <h1 className="wordmark text-[36px] mt-3 leading-tight">{r.title}</h1>
      <p className="text-[15px] text-[#737373] mt-3">{r.description}</p>

      <div className="mt-8 border border-[#E5E5E5] rounded-xl p-5">
        <div className="text-[14px] font-semibold mb-3">它做什么</div>
        <div className="text-[14px] text-[#737373]">{r.data.goal}</div>
        {r.data.steps?.length > 0 && (
          <>
            <div className="text-[14px] font-semibold mt-5 mb-3">步骤</div>
            <ol className="space-y-2 text-[14px] text-[#737373] list-decimal pl-5">
              {r.data.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </>
        )}
        {r.data.approvalPoints?.length > 0 && (
          <>
            <div className="text-[14px] font-semibold mt-5 mb-2">需要你确认的点</div>
            <div className="text-[13px] text-[#737373]">{r.data.approvalPoints.join("、")}</div>
          </>
        )}
        <div className="text-[13px] text-[#A3A3A3] mt-5">需要连接：{r.data.connectors.join(" / ") || "无"}</div>
      </div>

      <a href="/workspace" className="mt-6 block text-center h-11 leading-[44px] text-[14px] font-medium bg-[#171717] text-white rounded-lg">
        在我的 Workspace 中执行 →
      </a>
    </>
  );
}
