import assert from "node:assert/strict";
import {
  larkFeishuDatabaseCreateRecord,
  larkFeishuDatabaseQuery,
} from "../src/connectors/lark-feishu/index";

const originalFetch = globalThis.fetch;
const env = {} as any;

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

try {
  {
    let seenUrl = "";
    let seenBody: any = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body ?? "{}"));
      return ok({ items: [{ record_id: "rec_1", fields: { Name: "A" } }], has_more: true, page_token: "next" });
    }) as typeof fetch;

    const result = await larkFeishuDatabaseQuery(env, "lark", "user-token", "app_1", "tbl_1", {
      pageSize: 20,
      pageToken: "cursor_1",
      fieldNames: ["Name"],
    });
    assert.match(seenUrl, /records\/search\?/);
    assert.match(seenUrl, /page_size=20/);
    assert.match(seenUrl, /page_token=cursor_1/);
    assert.equal(seenBody.page_size, undefined, "pagination belongs in query params, not JSON body");
    assert.equal(seenBody.page_token, undefined, "pagination belongs in query params, not JSON body");
    assert.deepEqual(seenBody.field_names, ["Name"]);
    assert.equal(result.items[0]?.recordId, "rec_1");
    assert.equal(result.pageToken, "next");
  }

  {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/records") && init?.method === "POST") {
        return ok({ record: { record_id: "rec_created", fields: { Name: "Alpha" } } });
      }
      if (url.includes("/records/rec_created?") && (!init?.method || init.method === "GET")) {
        return ok({ record: { record_id: "rec_created", fields: { Name: "Alpha" } } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const record = await larkFeishuDatabaseCreateRecord(env, "feishu", "user-token", "app_1", "tbl_1", { Name: "Alpha" });
    assert.equal(record.recordId, "rec_created");
    assert.equal(calls.length, 2, "create must be followed by provider read-back verification");
  }

  console.log("lark-feishu-base-contract: ok");
} finally {
  globalThis.fetch = originalFetch;
}
