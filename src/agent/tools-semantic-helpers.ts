
import type { Env } from "../env";

export async function defaultMailboxAccountForSemantic(env: Env, workspaceId: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT email FROM mailbox_accounts WHERE workspace_id=? ORDER BY COALESCE(created_at,0) ASC, email ASC LIMIT 1`,
    ).bind(workspaceId).first<{ email: string } | null>();
    return row?.email ?? null;
  } catch {
    return null;
  }
}
