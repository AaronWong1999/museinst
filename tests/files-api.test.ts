//
// Files / Artifacts API tests (spec §15, §25.6): R2 ownership, upload
// init→content→complete lifecycle, workspace isolation, delete tombstone.
//
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { coreApiApp } from "../src/core/router";

console.log("▶ Files / Artifacts API");

interface R2Obj { key: string; size: number; body?: Uint8Array; httpMetadata?: { contentType?: string } }

function createEnv() {
  const objects = new Map<string, R2Obj>();
  const r2 = {
    async put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<R2Obj> {
      const bytes = new Uint8Array(value);
      const obj: R2Obj = { key, size: bytes.byteLength, body: bytes, httpMetadata: opts?.httpMetadata };
      objects.set(key, obj);
      return obj;
    },
    async head(key: string): Promise<R2Obj | null> {
      return objects.get(key) ?? null;
    },
    async get(key: string): Promise<(R2Obj & { body: ReadableStream }) | null> {
      const obj = objects.get(key);
      if (!obj || !obj.body) return null;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(obj.body);
          controller.close();
        },
      });
      return { ...obj, body: stream };
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
  };
  const rows = new Map<string, any>();
  let seq = 0;
  const db = {
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              const q = query.trim();
              if (q.startsWith("SELECT") && q.includes("FROM artifacts WHERE id=? AND workspace_id=?")) {
                for (const row of rows.values()) {
                  if (row.id === args[0] && row.workspace_id === args[1] && row.deleted_at === null) return structuredCloneRow(row);
                }
                return null;
              }
              return null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              const q = query.trim();
              if (q.startsWith("SELECT") && q.includes("FROM artifacts")) {
                const [ws] = args as string[];
                const limit = Number(args[args.length - 1]) || 100;
                const out = [...rows.values()]
                  .filter((r) => r.workspace_id === ws && r.deleted_at === null)
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(0, limit)
                  .map(structuredCloneRow);
                return { results: out as T[] };
              }
              return { results: [] as T[] };
            },
            async run(): Promise<{ meta: { changes: number }; success: boolean }> {
              const q = query.trim();
              if (q.startsWith("INSERT INTO artifacts")) {
                const [id, workspace_id, thread_id, task_id, kind, filename, mime_type, size_bytes, r2_key, source, source_ref, created_at] = args as never[];
                rows.set(id, { id, workspace_id, thread_id, task_id, kind, filename, mime_type, size_bytes, r2_key, source, source_ref, created_at, deleted_at: null });
              } else if (q.startsWith("UPDATE artifacts SET size_bytes")) {
                const row = rows.get(args[1] as string);
                if (row) row.size_bytes = args[0];
              } else if (q.startsWith("UPDATE artifacts SET deleted_at")) {
                const row = rows.get(args[1] as string);
                if (row) row.deleted_at = args[0];
              }
              return { meta: { changes: 1 }, success: true };
            },
          };
        },
      };
    },
    batch: async () => [],
  };
  return { env: { DB: db, ARTIFACTS: r2 } as any, objects, rows };
}

function structuredCloneRow(row: any) {
  return JSON.parse(JSON.stringify(row));
}

async function call(env: any, method: string, path: string, body?: unknown, raw = false): Promise<Response> {
  const req = new Request(`https://kernel.test${path}`, {
    method,
    headers: {
      "content-type": raw ? "application/pdf" : "application/json",
      // the router reads the session via readSession(env, req); tests inject a
      // host-hook-free environment where the session comes from the cookie —
      // use the same bypass the kernel tests use: ALLOW_INSECURE_DEV_SESSION.
      cookie: "oi=test",
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  });
  return coreApiApp.fetch(req, env, {} as any);
}

// Session stub: the kernel's readSession honours the host hook first; tests
// stub the D1 sessions table path by monkey-patching readSession through the
// module registry is not possible — instead assert through the same
// authorization the router performs using a direct service-level flow.

console.log("  [1] upload lifecycle at service level (init → content → complete → read → delete)");
{
  const { env, objects } = createEnv();
  const { initUpload, putContent, completeUpload, readContent, deleteArtifact, listArtifacts } = await import("../src/files/service");
  const ws = "ws-files";
  const init = await initUpload(env, { workspaceId: ws, filename: "租房合同.pdf", mimeType: "application/pdf", source: "upload" });
  assert.ok(init.ok);
  if (!init.ok) process.exit(1);
  const key = init.artifact.r2_key;
  assert.ok(key.startsWith(`artifacts/${ws}/`), "r2 key is workspace-scoped");

  // content before complete → upload_incomplete on read
  const bytes = new TextEncoder().encode("hello artifact").buffer as ArrayBuffer;
  const put = await putContent(env, { workspaceId: ws, artifactId: init.artifact.id, body: bytes, contentType: "application/pdf" });
  assert.ok(put.ok);

  const earlyRead = await readContent(env, ws, init.artifact.id);
  assert.ok(!earlyRead.ok && earlyRead.error === "upload_incomplete", "read before complete is 409");

  const done = await completeUpload(env, { workspaceId: ws, artifactId: init.artifact.id });
  assert.ok(done.ok);
  if (done.ok) assert.equal(done.artifact.size_bytes, bytes.byteLength);

  const read = await readContent(env, ws, init.artifact.id);
  assert.ok(read.ok);
  if (read.ok) {
    const text = await new Response(read.body.body).text();
    assert.equal(text, "hello artifact");
  }

  // double upload is rejected
  const again = await putContent(env, { workspaceId: ws, artifactId: init.artifact.id, body: bytes });
  assert.ok(!again.ok && again.error === "already_uploaded");

  // listing shows one available artifact
  const list = await listArtifacts(env, ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].available ?? list[0].size_bytes !== null, true);

  // cross-workspace read is not found (ownership boundary)
  const otherRead = await readContent(env, "ws-OTHER", init.artifact.id);
  assert.ok(!otherRead.ok && otherRead.error === "not_found");

  // delete removes the object and tombstones the row
  const del = await deleteArtifact(env, ws, init.artifact.id);
  assert.ok(del.ok);
  assert.equal(objects.size, 0, "R2 object removed");
  const afterDelete = await readContent(env, ws, init.artifact.id);
  assert.ok(!afterDelete.ok && afterDelete.error === "not_found");
  const listAfter = await listArtifacts(env, ws);
  assert.equal(listAfter.length, 0, "deleted artifact leaves the list");
}

console.log("  [2] upload validation: bad filename and oversize rejected");
{
  const { env } = createEnv();
  const { initUpload, putContent } = await import("../src/files/service");
  const bad = await initUpload(env, { workspaceId: "ws", filename: "" });
  assert.ok(!bad.ok && bad.error === "filename_invalid");
  const tricky = await initUpload(env, { workspaceId: "ws", filename: "../escape.bin" });
  assert.ok(!tricky.ok && tricky.error === "filename_invalid", "path traversal filename rejected");
  const ok = await initUpload(env, { workspaceId: "ws", filename: "a.bin" });
  if (ok.ok) {
    const big = await putContent(env, { workspaceId: "ws", artifactId: ok.artifact.id, body: new ArrayBuffer(60 * 1024 * 1024) });
    assert.ok(!big.ok && big.error === "file_too_large");
  }
}

console.log("  [3] router wiring: unauthenticated request is refused before any service call");
{
  const { env } = createEnv();
  const res = await call(env, "GET", "/api/files");
  assert.equal(res.status, 401, "no session → 401");
}

console.log("✅ files-api passed");
