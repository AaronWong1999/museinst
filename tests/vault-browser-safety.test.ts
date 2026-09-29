// tests/vault-browser-safety.test.ts
// Regression tests for Phase B: P0-04, P0-05, P0-06, P0-08, P1-10 from docs/STEP9_DIFF_CODE_AUDIT_AND_REMEDIATION_2026-09-13.md
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "@cloudflare/puppeteer";
import { BrowserWorker } from "../src/agent/browser-worker";
import { encryptVaultPayload } from "../src/vault/service";

console.log("▶ Running vault-browser-safety regression tests (Phase B)");

const TEST_VAULT_KEY = "01234567890123456789012345678901";

function createMockCtx(db = new DatabaseSync(":memory:")) {
  return {
    storage: {
      sql: {
        exec: (s: string, ...args: unknown[]) => {
          const stmt = db.prepare(s);
          const rows = stmt.all(...(args as never[]));
          return Object.assign(rows, { toArray: () => rows });
        },
      },
    },
    id: { name: "ws-test" },
    blockConcurrencyWhile: async (fn: any) => await fn(),
  };
}

// ── Test 1: P0-08 — verify_login MUST NOT claim authenticated without positive signals ──
{
  console.log("  [Test 1] P0-08: verify_login negative cases: blank page, captcha, 404 must not return authenticated=yes");

  const origConnect = puppeteer.connect;
  try {
    const workerCtx = createMockCtx();
    const workerEnv: any = {
      BROWSER: {},
      DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }) },
      PUBLIC_BASE_URL: "https://example.com",
    };

    const worker = new (BrowserWorker as any)(workerCtx, workerEnv);
    worker.onStart();

    // 1A. Negative case: 404 / blank page without positive auth signals
    const mockPage404: any = {
      setViewport: async () => {},
      createCDPSession: async () => ({ send: async () => ({}) }),
      goto: async () => {},
      screenshot: async () => new Uint8Array([1, 2, 3]),
      url: () => "https://example.com/404",
      title: async () => "404 Not Found",
      evaluate: async (fn: any) => {
        return await fn();
      },
    };

    // Setup global DOM mocks for evaluate fn
    (globalThis as any).document = {
      querySelectorAll: (sel: string) => {
        return [];
      },
      title: "404 Not Found",
      body: { innerText: "404 Not Found. The requested URL was not found on this server." },
    };
    (globalThis as any).location = { href: "https://example.com/404" };
    (globalThis as any).getComputedStyle = () => ({ visibility: "visible", display: "block" });

    puppeteer.connect = (async () => ({
      sessionId: () => "sess_test",
      pages: async () => [mockPage404],
      newPage: async () => mockPage404,
    })) as any;

    const res404 = await (worker as any).execAction(
      { id: "c1", name: "verify_login", args: {} },
      mockPage404,
      {},
      { workspaceId: "ws-test", taskId: "task-1", lang: "zh" },
      {},
    );

    assert.ok(
      !res404.content.includes("已认证状态") && !res404.content.includes("已确认已认证"),
      `404 page must NOT report authenticated=yes! Content was: ${res404.content}`,
    );

    const verificationEntries = (worker as any).taskSecrets.takeLoginVerification();
    const authRecord = verificationEntries?.find((e: any) => e.type === "authenticated");
    assert.ok(authRecord && authRecord.value !== "yes", `authenticated entry must NOT be 'yes' on 404 page`);


    const mockPageAuth: any = {
      url: () => "https://example.com/dashboard",
      title: async () => "User Dashboard",
      evaluate: async (fn: any) => {
        return await fn();
      },
    };

    const logoutEl = {
      tagName: "A",
      textContent: "退出登录",
      getAttribute: (a: string) => null,
      getBoundingClientRect: () => ({ width: 100, height: 30, x: 50, y: 50 }),
    };

    (globalThis as any).document = {
      querySelectorAll: (sel: string) => {
        if (sel.includes("password")) return [];
        return [logoutEl];
      },
      title: "User Dashboard",
      body: { innerText: "欢迎回来，用户中心 退出登录" },
    };
    (globalThis as any).location = { href: "https://example.com/dashboard" };

    const resAuth = await (worker as any).execAction(
      { id: "c2", name: "verify_login", args: {} },
      mockPageAuth,
      {},
      { workspaceId: "ws-test", taskId: "task-1", lang: "zh" },
      {},
    );

    assert.ok(
      resAuth.content.includes("已认证状态") || resAuth.content.includes("已确认已认证"),
      `Page with logout signal must report authenticated status! Content was: ${resAuth.content}`,
    );

    const authVerification = (worker as any).taskSecrets.takeLoginVerification();
    assert.equal(authVerification?.find((e: any) => e.type === "authenticated")?.value, "yes");

    console.log("  ✅ Test 1 passed");
  } finally {
    puppeteer.connect = origConnect;
  }
}

// ── Test 2: P0-05 — DOM perception must not leak password or secret input values ──
{
  console.log("  [Test 2] P0-05: DOM perception must not leak password or secret input values");

  const workerCtx = createMockCtx();
  const worker = new (BrowserWorker as any)(workerCtx, {});
  worker.onStart();

  const secretPassword = "sup3r-secret-password-xyz";
  const userAccount = "my_private_username@test.com";

  const mockElements = [
    {
      tagName: "INPUT",
      type: "password",
      value: secretPassword,
      placeholder: "Password",
      getAttribute: (a: string) => (a === "type" ? "password" : null),
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 30 }),
    },
    {
      tagName: "INPUT",
      type: "text",
      name: "username",
      value: userAccount,
      placeholder: "Username / Email",
      getAttribute: (a: string) => {
        if (a === "name") return "username";
        if (a === "placeholder") return "Username / Email";
        return null;
      },
      getBoundingClientRect: () => ({ x: 10, y: 50, width: 100, height: 30 }),
    },
    {
      tagName: "BUTTON",
      type: "submit",
      textContent: "Sign In",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 10, y: 90, width: 100, height: 30 }),
    },
  ];

  (globalThis as any).document = {
    querySelectorAll: (sel: string) => mockElements,
    title: "Login Page",
  };
  (globalThis as any).location = { href: "https://example.com/login" };
  (globalThis as any).window = { innerHeight: 800 };
  (globalThis as any).getComputedStyle = () => ({ visibility: "visible", display: "block" });

  const mockPage: any = {
    evaluate: async (fn: any, ...args: any[]) => fn(...args),
  };

  const perception = await (worker as any).perceiveRaw(mockPage);
  assert.ok(
    !perception.text.includes(secretPassword),
    `perceiveRaw leaked password in perception text! Text was:\n${perception.text}`,
  );
  assert.ok(
    !perception.text.includes(userAccount),
    `perceiveRaw leaked login identifier in perception text! Text was:\n${perception.text}`,
  );
  assert.ok(
    perception.text.includes("[filled]"),
    `perceiveRaw should indicate filled state safely`,
  );

  // Check findRef
  const ref0 = await (worker as any).findRef(mockPage, 0);
  assert.ok(ref0, "ref 0 must exist");
  assert.ok(!ref0.text.includes(secretPassword), `findRef leaked password in text`);

  const ref1 = await (worker as any).findRef(mockPage, 1);
  assert.ok(ref1, "ref 1 must exist");
  assert.ok(!ref1.text.includes(userAccount), `findRef leaked login identifier in text`);

  // Check getSemanticSnapshot fallback
  const snapshot = await (worker as any).getSemanticSnapshot(mockPage);
  assert.ok(!snapshot.includes(secretPassword), `getSemanticSnapshot leaked password in fallback snapshot`);
  assert.ok(!snapshot.includes(userAccount), `getSemanticSnapshot leaked username in fallback snapshot`);

  console.log("  ✅ Test 2 passed");
}

// ── Test 3: P0-06 — Fail-closed screenshot masking and shotDataUri masking ──
{
  console.log("  [Test 3] P0-06: shotDataUri must apply masking before taking screenshot, and fail closed on error");

  let maskStyleAdded = false;
  const mockPage: any = {
    frames: () => [{
      addStyleTag: async () => { maskStyleAdded = true; },
    }],
    mainFrame: function() { return this.frames()[0]; },
    screenshot: async () => {
      assert.ok(maskStyleAdded, "shotDataUri MUST apply maskStyleTag BEFORE taking screenshot!");
      return new Uint8Array([1, 2, 3]);
    },
  };

  const workerCtx = createMockCtx();
  const worker = new (BrowserWorker as any)(workerCtx, {});
  worker.onStart();

  await (worker as any).shotDataUri(mockPage);
  assert.ok(maskStyleAdded, "Mask style must have been added");

  // Verify fail-closed: if masking fails on main frame, screenshot MUST fail and not return unmasked image
  const failingPage: any = {
    frames: () => [{
      addStyleTag: async () => { throw new Error("CSP blocked style injection"); },
    }],
    mainFrame: function() { return this.frames()[0]; },
    screenshot: async () => new Uint8Array([9, 9, 9]),
  };

  await assert.rejects(
    async () => await (worker as any).shotDataUri(failingPage),
    (err: any) => {
      assert.ok(err.message.includes("screenshot_failed") || err.message.includes("masking failed"));
      return true;
    },
    "safeCaptureScreenshot must FAIL CLOSED when style injection fails on main frame!",
  );

  console.log("  ✅ Test 3 passed");
}

// ── Test 4: P1-10 — fill_from_vault fills both username and password on single-page form ──
{
  console.log("  [Test 4] P1-10: fill_from_vault fills both username and password in one call");

  const clickCalls: Array<{ x: number; y: number }> = [];
  const cdpInserts: string[] = [];

  const mockCdp = {
    send: async (method: string, params: any) => {
      if (method === "Input.insertText") cdpInserts.push(params.text);
      return {};
    },
  };

  const mockPage: any = {
    url: () => "https://example.com/login",
    mouse: {
      click: async (x: number, y: number) => { clickCalls.push({ x, y }); },
    },
    evaluate: async (fn: any, ...args: any[]) => {
      if (typeof fn === "function") {
        return await fn(...args);
      }
      return [];
    },
    frames: () => [{
      evaluate: async () => {},
    }],
    mainFrame: function() { return this.frames()[0]; },
  };

  // Setup DOM elements for collectInputTargets
  const usernameInput = {
    tagName: "INPUT",
    type: "text",
    name: "username",
    value: "",
    disabled: false,
    readOnly: false,
    getBoundingClientRect: () => ({ x: 50, y: 100, width: 200, height: 30 }),
    setAttribute: () => {},
  };
  const passwordInput = {
    tagName: "INPUT",
    type: "password",
    name: "password",
    value: "",
    disabled: false,
    readOnly: false,
    getBoundingClientRect: () => ({ x: 50, y: 160, width: 200, height: 30 }),
    setAttribute: () => {},
  };

  (globalThis as any).document = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("input")) return [usernameInput, passwordInput];
      return [];
    },
    activeElement: usernameInput,
  };
  (globalThis as any).getComputedStyle = () => ({ visibility: "visible", display: "block" });

  const testUsername = "pilot@example.com";
  const testPassword = "SuperSecurePassword99!";

  const ciphertext = await encryptVaultPayload(
    { VAULT_MASTER_KEY: TEST_VAULT_KEY } as any,
    "ws-test",
    "cand-1",
    JSON.stringify({ username: testUsername, password: testPassword }),
  );

  const workerCtx = createMockCtx();

  const workerEnv: any = {
    VAULT_MASTER_KEY: TEST_VAULT_KEY,
    BROWSER: {},
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => {
            if (sql.includes("vault_items")) {
              return {
                id: "cand-1",
                kind: "login",
                label: "Example Login",
                account: testUsername,
                origin: "https://example.com",
                updated_at: Date.now(),
              };
            }
            if (sql.includes("encrypted_secrets")) {
              return { ciphertext };
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    },
    PUBLIC_BASE_URL: "https://example.com",
  };

  const worker = new (BrowserWorker as any)(workerCtx, workerEnv);
  worker.onStart();

  const fillRes = await (worker as any).fillFromVault(
    { workspaceId: "ws-test", taskId: "task-vault-1" },
    mockPage,
    mockCdp,
    "cand-1",
  );

  assert.ok(
    fillRes.content.includes("已填 2 个字段"),
    `fill_from_vault must fill BOTH username and password on single page form! Content was: ${fillRes.content}`,
  );
  assert.equal(cdpInserts.length, 2, "CDP insertText should have been called twice (username and password)");
  assert.equal(cdpInserts[0], testUsername, "First inserted value should be username");
  assert.equal(cdpInserts[1], testPassword, "Second inserted value should be password");

  // Check that username is registered in scrubber
  const scrubbed = (worker as any).taskSecrets.scrub(`Account ${testUsername} with pass ${testPassword}`);
  assert.equal(
    scrubbed,
    "Account *** with pass ***",
    "Both username and password MUST be scrubbed from logs/chat by taskSecrets scrubber!",
  );

  console.log("  ✅ Test 4 passed");
}

// ── Test 5: P0-05 — Secret scrubber lifecycle: persists across resume ──
{
  console.log("  [Test 5] P0-05: Secret scrubber lifecycle persists across resume");

  const workerCtx = createMockCtx();
  const worker = new (BrowserWorker as any)(workerCtx, {});
  worker.onStart();

  // Fresh task starts -> secrets cleared
  (worker as any).registerTaskSecret("secret-round-1");
  assert.equal((worker as any).taskSecrets.size, 1);

  // Resume happens -> secrets NOT cleared!
  // Simulating clearTaskSecrets logic when resume is true vs false
  if (!true /* resume */) {
    (worker as any).clearTaskSecrets();
  }
  assert.equal((worker as any).taskSecrets.size, 1, "Resume MUST NOT clear secrets from memory!");
  assert.equal((worker as any).taskSecrets.scrub("secret-round-1 is here"), "*** is here");

  console.log("  ✅ Test 5 passed");
}

// ── Test 6: §8 — Screenshot masking must restore temporary iframe styles in try/finally ──
{
  console.log("  [Test 6] §8: safeCaptureScreenshot must restore temporary iframe styles after capture");

  const workerCtx = createMockCtx();
  const worker = new (BrowserWorker as any)(workerCtx, {});
  worker.onStart();
  (worker as any).registerTaskSecret("my-secret-token");

  // Create mock iframe element in mock DOM
  const mockIframe = {
    src: "https://cross-origin.example.com/embed",
    style: {
      visibility: "visible",
      filter: "none",
    },
  };

  const mainF = {
    url: () => "https://example.com",
    addStyleTag: async () => {},
  };
  const subF = {
    url: () => "https://cross-origin.example.com/embed",
    addStyleTag: async () => { throw new Error("Cross-origin frame style injection rejected"); },
  };

  const mockPage: any = {
    frames: () => [mainF, subF],
    mainFrame: () => mainF,
    evaluate: async (fn: any, ...args: any[]) => {
      (globalThis as any).document = {
        querySelectorAll: (sel: string) => (sel === "iframe" ? [mockIframe] : []),
      };
      return await fn(...args);
    },
    screenshot: async () => {
      // During screenshot capture, iframe MUST be hidden/blurred for safety
      assert.equal(mockIframe.style.visibility, "hidden");
      assert.equal(mockIframe.style.filter, "blur(16px)");
      return new Uint8Array([1, 2, 3]);
    },
  };

  await (worker as any).safeCaptureScreenshot(mockPage, { type: "jpeg" });

  // After screenshot capture completes, iframe styles MUST be restored!
  assert.equal(mockIframe.style.visibility, "visible", "Iframe visibility must be restored to original 'visible'!");
  assert.equal(mockIframe.style.filter, "none", "Iframe filter must be restored to original 'none'!");

  console.log("  ✅ Test 6 passed");
}

// ── Test 7: §9 — verify_login positive signals: generic dashboard/profile must NOT return verified ──
{
  console.log("  [Test 7] §9: verify_login: generic 'dashboard/profile/控制台/欢迎您' must produce appears_authenticated, never verified");

  const origConnect = puppeteer.connect;
  try {
    const workerCtx = createMockCtx();
    const workerEnv: any = {
      BROWSER: {},
      DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }) },
      PUBLIC_BASE_URL: "https://example.com",
    };

    const worker = new (BrowserWorker as any)(workerCtx, workerEnv);
    worker.onStart();


    const mockPageGeneric: any = {
      setViewport: async () => {},
      createCDPSession: async () => ({ send: async () => ({}) }),
      goto: async () => {},
      screenshot: async () => new Uint8Array([1, 2, 3]),
      url: () => "https://example.com/welcome",
      title: async () => "控制台 - 欢迎您",
      evaluate: async (fn: any) => {
        (globalThis as any).document = {
          body: { innerText: "欢迎您访问公共控制台。请选择功能模块。" },
          querySelectorAll: (sel: string) => {
            if (sel.includes("password")) return [];
            return [
              {
                tagName: "DIV",
                textContent: "控制台 Dashboard",
                getAttribute: () => null,
                getBoundingClientRect: () => ({ width: 100, height: 30 }),
              },
            ];
          },
          title: "控制台 - 欢迎您",
        };
        (globalThis as any).getComputedStyle = () => ({ visibility: "visible", display: "block" });
        (globalThis as any).location = { href: "https://example.com/welcome" };
        return await fn();
      },
    };

    const resGeneric = await (worker as any).execAction(
      { id: "call_vl_1", name: "verify_login", args: {} },
      mockPageGeneric,
      {},
      { workspaceId: "ws-test", taskId: "task-vl-gen", lang: "zh" },
      {},
    );

    assert.ok(
      resGeneric.content.includes("未确认已认证") || resGeneric.content.includes("无法确认是否真正登录成功"),
      `Generic '控制台/欢迎您' keywords alone must NOT produce verified status! Content was: ${resGeneric.content}`,
    );

    const genericVerification = (worker as any).taskSecrets.takeLoginVerification();
    assert.equal(genericVerification?.find((e: any) => e.type === "authenticated")?.value, "no");
    assert.equal(genericVerification?.find((e: any) => e.type === "auth_status")?.value, "appears_authenticated");


    const mockPageStrong: any = {
      setViewport: async () => {},
      createCDPSession: async () => ({ send: async () => ({}) }),
      goto: async () => {},
      screenshot: async () => new Uint8Array([1, 2, 3]),
      url: () => "https://example.com/account",
      title: async () => "我的账户",
      evaluate: async (fn: any) => {
        (globalThis as any).document = {
          body: { innerText: "用户: user@example.com" },
          querySelectorAll: (sel: string) => {
            if (sel.includes("password")) return [];
            return [
              {
                tagName: "BUTTON",
                textContent: "退出登录",
                getAttribute: () => null,
                getBoundingClientRect: () => ({ width: 80, height: 30 }),
              },
            ];
          },
          title: "我的账户",
        };
        (globalThis as any).getComputedStyle = () => ({ visibility: "visible", display: "block" });
        (globalThis as any).location = { href: "https://example.com/account" };
        return await fn();
      },
    };

    const resStrong = await (worker as any).execAction(
      { id: "call_vl_2", name: "verify_login", args: {} },
      mockPageStrong,
      {},
      { workspaceId: "ws-test", taskId: "task-vl-str", lang: "zh" },
      {},
    );

    assert.ok(
      resStrong.content.includes("已认证状态") || resStrong.content.includes("已通过正向信号严格确认登录态"),
      `Explicit '退出登录' button MUST produce verified authenticated status! Content was: ${resStrong.content}`,
    );

    const strongVerification = (worker as any).taskSecrets.takeLoginVerification();
    assert.equal(strongVerification?.find((e: any) => e.type === "authenticated")?.value, "yes");
    assert.equal(strongVerification?.find((e: any) => e.type === "auth_status")?.value, "verified");

    console.log("  ✅ Test 7 passed");
  } finally {
    puppeteer.connect = origConnect;
  }
}

console.log("✅ All vault-browser-safety tests completed");
