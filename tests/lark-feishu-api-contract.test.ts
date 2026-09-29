import assert from "node:assert/strict";
import {
  larkFeishuCalendarCreate,
  larkFeishuContactSearch,
  larkFeishuDocumentSearch,
} from "../src/connectors/lark-feishu/index";

const originalFetch = globalThis.fetch;
const env = {} as any;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

try {
  // Contact search must use current Contact v3 POST search, not legacy search/v1/user.
  {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        code: 0,
        data: {
          items: [{
            id: "ou_contact_1",
            display_info: "Alice\nEngineering",
            meta_data: {
              i18n_names: { en_us: "Alice", zh_cn: "爱丽丝" },
              enterprise_mail_address: "alice@example.com",
            },
          }],
        },
      });
    }) as typeof fetch;

    const result = await larkFeishuContactSearch(env, "lark", "user-token", "Alice", 10);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, "ou_contact_1");
    assert.equal(result[0]?.email, "alice@example.com");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /open\.larksuite\.com\/open-apis\/contact\/v3\/users\/search/);
    assert.equal(calls[0]!.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { query: "Alice" });
  }

  // Document search must be server-side Search v2 and preserve the provider token.
  {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        code: 0,
        data: {
          res_units: [{
            title_highlighted: "Project <h>Alpha</h>",
            result_meta: {
              doc_types: "DOCX",
              token: "doccn_contract_1",
              url: "https://example.larksuite.com/docx/doccn_contract_1",
            },
          }],
        },
      });
    }) as typeof fetch;

    const result = await larkFeishuDocumentSearch(env, "lark", "user-token", "Alpha", 10);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.documentId, "doccn_contract_1");
    assert.equal(result[0]?.title, "Project Alpha");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /open\.larksuite\.com\/open-apis\/search\/v2\/doc_wiki\/search$/);
    assert.equal(calls[0]!.init?.method, "POST");
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.equal(body.query, "Alpha");
    assert.deepEqual(body.doc_filter.doc_types, ["DOC", "DOCX"]);
  }

  // Calendar invitees are a separate attendee API operation. A successful event
  // create is not enough to claim the meeting invite succeeded.
  {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/calendar/v4/calendars/primary/events") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.attendees, undefined, "event create must not smuggle invitees into the event payload");
        return jsonResponse({ code: 0, data: { event: { event_id: "evt_contract_1" } } });
      }
      if (url.includes("/evt_contract_1/attendees?") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.attendees, [{ type: "third_party", third_party_email: "guest@example.com" }]);
        assert.equal(body.need_notification, true);
        return jsonResponse({ code: 0, data: {} });
      }
      if (url.endsWith("/evt_contract_1") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          code: 0,
          data: {
            event: {
              event_id: "evt_contract_1",
              summary: "Contract meeting",
              start_time: { timestamp: "1789347600" },
              end_time: { timestamp: "1789351200" },
            },
          },
        });
      }
      if (url.includes("/evt_contract_1/attendees?") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          code: 0,
          data: { items: [{ type: "third_party", third_party_email: "guest@example.com" }] },
        });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const result = await larkFeishuCalendarCreate(env, "lark", "user-token", {
      summary: "Contract meeting",
      startIso: "2026-09-14T09:00:00Z",
      endIso: "2026-09-14T10:00:00Z",
      attendees: ["guest@example.com"],
    });
    assert.equal(result.id, "evt_contract_1");
    assert.equal(calls.filter((c) => c.url.includes("/attendees")).length, 2, "attendee add and read-back must both occur");
  }

  console.log("lark-feishu-api-contract: ok");
} finally {
  globalThis.fetch = originalFetch;
}
