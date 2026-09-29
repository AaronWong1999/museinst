



import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BoundStmt = {
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
  run: () => Promise<{ meta: { changes: number }; success: boolean }>;
  runSync: () => { meta: { changes: number }; success: boolean };
};

export type TestD1 = {
  prepare: (sql: string) => BoundStmt & { bind: (...args: unknown[]) => BoundStmt };
  batch: (stmts: BoundStmt[]) => Promise<Array<{ meta: { changes: number }; success: boolean }>>;
  db: DatabaseSync;
};

function makeBound(db: DatabaseSync, sql: string, args: unknown[]): BoundStmt {
  const runSync = () => {
    const r = db.prepare(sql).run(...(args as never[])) as unknown as { changes: number };
    return { meta: { changes: r.changes ?? 0 }, success: true };
  };
  return {
    first: async <T>(): Promise<T | null> => {
      const row = db.prepare(sql).get(...(args as never[])) as T | undefined;
      return row ?? null;
    },
    all: async <T>(): Promise<{ results: T[] }> => {
      const rows = db.prepare(sql).all(...(args as never[])) as unknown as T[];
      return { results: rows };
    },
    run: async () => runSync(),
    runSync,
  };
}

export function createTestD1(): TestD1 {
  const db = new DatabaseSync(":memory:");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.includes(" ")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return {
    db,
    prepare: (sql: string) => {
      const unbound = makeBound(db, sql, []);
      return {
        ...unbound,
        bind: (...args: unknown[]) => makeBound(db, sql, args),
      };
    },
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve original failure as root cause
        }
        throw e;
      }
    },
  };
}

export function d1Exec(d1: TestD1, sql: string, ...args: unknown[]): void {
  d1.db.prepare(sql).run(...(args as never[]));
}

export function envOf(d1: TestD1, extra: Record<string, unknown> = {}): any {
  return { DB: d1, TELEGRAM_BOT_TOKEN: "42:test-token", TELEGRAM_ENABLED: "1", ...extra };
}

export async function d1All<T>(d1: TestD1, sql: string, ...args: unknown[]): Promise<T[]> {
  return d1.db.prepare(sql).all(...(args as never[])) as unknown as T[];
}

export async function d1Get<T>(d1: TestD1, sql: string, ...args: unknown[]): Promise<T | null> {
  return (d1.db.prepare(sql).get(...(args as never[])) as T) ?? null;
}

export function recordedTelegramCalls(calls: Array<{ url: string; body?: unknown }>) {
  return calls;
}
