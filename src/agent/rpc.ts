


import type { Env } from "../env";
import { DEADLINE_BUDGETS_MS, withDeadline } from "../util/deadlines";

export function agentFetch(
  ns: DurableObjectNamespace,
  room: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const stub = ns.get(ns.idFromName(room));
  const headers = new Headers(init?.headers);
  headers.set("x-partykit-room", room);
  return stub.fetch(`https://agent${path}`, { ...init, headers });
}





export function agentFetchWithDeadline(
  ns: DurableObjectNamespace,
  room: string,
  path: string,
  init?: RequestInit,
  budgetMs: number = DEADLINE_BUDGETS_MS.modelRequest,
): Promise<Response> {
  return withDeadline(agentFetch(ns, room, path, init), {
    operation: `agent_rpc:${path}`,
    budgetMs,
    onLateResult: () => {},
  });
}

export function agentStub(env: Env, workspaceId: string): DurableObjectStub {
  return env.AGENT.get(env.AGENT.idFromName(workspaceId));
}
