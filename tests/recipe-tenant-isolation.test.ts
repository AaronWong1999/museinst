import assert from "node:assert/strict";
import { createTestD1, d1Exec } from "./helpers/d1";
import { createSession, sessionCookieHeader } from "../src/session";
import { coreApiApp } from "../src/core/router";

async function runTests() {
  console.log("▶ Core Recipes authentication & tenant isolation test suite");

  const d1 = createTestD1();
  const env: any = {
    DB: d1,
    OPENINST_SECRET: "test-secret-at-least-16-chars-long",
    PUBLIC_BASE_URL: "https://agent.example.com",
  };

  // Insert workspaces and users
  d1Exec(d1, `INSERT INTO users (id, display_name, created_at) VALUES ('u_a', 'User A', 1000)`);
  d1Exec(d1, `INSERT INTO users (id, display_name, created_at) VALUES ('u_b', 'User B', 1000)`);
  d1Exec(d1, `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_a', 'u_a', 1000)`);
  d1Exec(d1, `INSERT INTO workspaces (id, owner_user_id, created_at) VALUES ('ws_b', 'u_b', 1000)`);

  // Insert Recipe A (owned by ws_a) and Recipe B (owned by ws_b)
  const templateA = JSON.stringify({ title: "Template A", steps: ["step 1"], evidence: [] });
  const templateB = JSON.stringify({ title: "Template B", steps: ["step 2"], evidence: [] });
  d1Exec(
    d1,
    `INSERT INTO recipes (id, source_task_id, slug, title, description, template_json, connectors, locale, public, author_workspace, created_at)
     VALUES ('rec_a', 'task_1', 'slug-a', 'Recipe A', 'Description A', ?, '[]', 'zh', 1, 'ws_a', 1000)`,
    templateA,
  );
  d1Exec(
    d1,
    `INSERT INTO recipes (id, source_task_id, slug, title, description, template_json, connectors, locale, public, author_workspace, created_at)
     VALUES ('rec_b', 'task_2', 'slug-b', 'Recipe B', 'Description B', ?, '[]', 'zh', 1, 'ws_b', 1000)`,
    templateB,
  );

  // 1. Unauthenticated requests must return 401
  const unauthListRes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipes"), env);
  assert.equal(unauthListRes.status, 401, "Unauthenticated /api/recipes must return 401");

  const unauthDetailRes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipe/slug-a"), env);
  assert.equal(unauthDetailRes.status, 401, "Unauthenticated /api/recipe/:slug must return 401");

  // Create sessions for ws_a and ws_b
  const sessionA = await createSession(env, "u_a", "ws_a");
  const headersA = { cookie: sessionCookieHeader(sessionA.cookie) };

  const sessionB = await createSession(env, "u_b", "ws_b");
  const headersB = { cookie: sessionCookieHeader(sessionB.cookie) };

  // 2. User A can list only recipes in ws_a
  const listARes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipes", { headers: headersA }), env);
  assert.equal(listARes.status, 200);
  const listAJson = await listARes.json() as any;
  assert.ok(Array.isArray(listAJson.recipes));
  assert.equal(listAJson.recipes.length, 1);
  assert.equal(listAJson.recipes[0].slug, "slug-a");

  // 3. User A can get slug-a, returned as direct RecipeDetail shape (not wrapped in { recipe: ... })
  const detailARes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipe/slug-a", { headers: headersA }), env);
  assert.equal(detailARes.status, 200);
  const detailAJson = await detailARes.json() as any;
  assert.equal(detailAJson.slug, "slug-a");
  assert.equal(detailAJson.title, "Recipe A");
  assert.equal(detailAJson.recipe, undefined, "Detail response must not be nested in { recipe: ... }");

  // 4. User A cannot get slug-b (must return 404, preserving tenant isolation)
  const detailCrossRes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipe/slug-b", { headers: headersA }), env);
  assert.equal(detailCrossRes.status, 404, "Accessing other workspace's recipe must return 404");

  // 5. User B can list only recipes in ws_b and get slug-b
  const listBRes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipes", { headers: headersB }), env);
  assert.equal(listBRes.status, 200);
  const listBJson = await listBRes.json() as any;
  assert.equal(listBJson.recipes.length, 1);
  assert.equal(listBJson.recipes[0].slug, "slug-b");

  const detailBRes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipe/slug-b", { headers: headersB }), env);
  assert.equal(detailBRes.status, 200);
  const detailBJson = await detailBRes.json() as any;
  assert.equal(detailBJson.slug, "slug-b");
  assert.equal(detailBJson.title, "Recipe B");

  const detailBCrossRes = await coreApiApp.fetch(new Request("https://agent.example.com/api/recipe/slug-a", { headers: headersB }), env);
  assert.equal(detailBCrossRes.status, 404, "User B accessing User A recipe must return 404");

  console.log("  ✅ Recipes authentication, unwrapped detail response, and tenant isolation verified");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
