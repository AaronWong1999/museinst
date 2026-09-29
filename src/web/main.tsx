import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import Setup from "./pages/Setup";
import Workspace from "./pages/Workspace";
import Chat from "./pages/Chat";
import Connect from "./pages/Connect";
import Tasks from "./pages/Tasks";
import VaultPage from "./pages/Vault";
import Receipt from "./pages/Receipt";
import Recipes from "./pages/Recipes";
import Admin from "./pages/Admin";
import SettingsPage from "./pages/Settings";
import { LangProvider } from "./i18n";

function match(path: string): { page: string; param?: string } {
  let m: RegExpMatchArray | null;
  if (path === "/" || path === "") return { page: "setup" };
  if (path === "/workspace") return { page: "workspace" };
  if (path === "/chat") return { page: "chat" };
  if (path === "/workspace/connect") return { page: "connect" };
  if (path === "/tasks") return { page: "tasks" };
  if ((m = path.match(/^\/tasks\/([^/]+)$/))) return { page: "task", param: m[1] };
  if (path === "/vault") return { page: "vault" };
  if ((m = path.match(/^\/r\/([^/]+)$/))) return { page: "receipt", param: m[1] };
  if (path === "/recipes") return { page: "recipes" };
  if ((m = path.match(/^\/recipe\/([^/]+)$/))) return { page: "recipe", param: m[1] };
  if (path === "/admin") return { page: "admin" };
  if (path === "/settings") return { page: "settings" };
  return { page: "workspace" };
}

function routeForTarget(target: string): { page: string; param?: string } {
  return match(new URL(target, location.origin).pathname);
}

function Router(): React.ReactElement {
  const [route, setRoute] = React.useState(match(location.pathname));
  React.useEffect(() => {
    const onPop = () => setRoute(match(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const nav = (to: string) => {
    history.pushState(null, "", to);
    setRoute(routeForTarget(to));
  };
  switch (route.page) {
    case "setup": return <Setup />;
    case "workspace": return <Workspace nav={nav} />;
    case "chat": return <Chat nav={nav} />;
    case "connect": return <Connect nav={nav} />;
    case "tasks": return <Tasks nav={nav} />;
    case "task": return <Tasks nav={nav} taskId={route.param} />;
    case "vault": return <VaultPage nav={nav} />;
    case "receipt": return <Receipt slug={route.param!} />;
    case "recipes": return <Recipes nav={nav} />;
    case "recipe": return <Recipes nav={nav} slug={route.param} />;
    case "admin": return <Admin />;
    case "settings": return <SettingsPage nav={nav} />;
    default: return <Workspace nav={nav} />;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <Router />
    </LangProvider>
  </React.StrictMode>,
);

export function navigate(to: string): void {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}
