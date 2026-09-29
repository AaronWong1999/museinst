// tests/vault-totp.test.ts — RFC 6238 TOTP test vectors, Base32 validation, and Vault internal-field preservation.

import assert from "node:assert/strict";
import {
  parseBase32Secret,
  parseOtpAuthUri,
  generateTotp,
  setLoginTotpPending,
  activateLoginTotp,
  removeLoginTotp,
  getLoginTotpStatus,
  getLoginTotpCode,
} from "../src/vault/totp";
import { putItem, getItemFields, getItemMeta } from "../src/vault/service";
import { createTestD1 } from "./helpers/d1";
import type { Env } from "../src/env";

console.log("▶ Testing RFC 6238 TOTP, Base32, and Vault __totp preservation...");

const RFC_SECRET_SHA1_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_SECRET_SHA256_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
const RFC_SECRET_SHA512_B32 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

const RFC_VECTORS = [
  { timeSec: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
  { timeSec: 1111111109, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
  { timeSec: 1111111111, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
  { timeSec: 1234567890, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
  { timeSec: 2000000000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
];

for (const v of RFC_VECTORS) {
  const timeMs = v.timeSec * 1000;
  assert.equal(await generateTotp({ secretBase32: RFC_SECRET_SHA1_B32, algorithm: "SHA1", digits: 8, period: 30 }, timeMs), v.sha1);
  assert.equal(await generateTotp({ secretBase32: RFC_SECRET_SHA256_B32, algorithm: "SHA256", digits: 8, period: 30 }, timeMs), v.sha256);
  assert.equal(await generateTotp({ secretBase32: RFC_SECRET_SHA512_B32, algorithm: "SHA512", digits: 8, period: 30 }, timeMs), v.sha512);
}

{
  const timeMs = 59 * 1000;
  const code8 = await generateTotp({ secretBase32: RFC_SECRET_SHA1_B32, digits: 8, period: 30 }, timeMs);
  const code6 = await generateTotp({ secretBase32: RFC_SECRET_SHA1_B32, digits: 6, period: 30 }, timeMs);
  assert.equal(code8, "94287082");
  assert.equal(code6, "287082");
  assert.equal(code8.slice(2), code6);
}

{
  const codeAt59 = await generateTotp({ secretBase32: RFC_SECRET_SHA1_B32, period: 60 }, 59000);
  const codeAt30 = await generateTotp({ secretBase32: RFC_SECRET_SHA1_B32, period: 60 }, 30000);
  assert.equal(codeAt59, codeAt30);
}

{
  const parsed1 = parseBase32Secret("gez-dgn-bvgy 3tqojq gez-dgn-bvgy 3tqojq");
  const parsed2 = parseBase32Secret(RFC_SECRET_SHA1_B32);
  assert.deepEqual(parsed1, parsed2);
  assert.throws(() => parseBase32Secret("INVALID890"), /invalid_totp_secret/);
  assert.throws(() => parseBase32Secret("!@#$%^"), /invalid_totp_secret/);
  assert.throws(() => parseBase32Secret("JBSWY3DP_EHPK3PXP"), /invalid_totp_secret/);
}

{
  const hotp = parseOtpAuthUri("otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=1");
  assert.equal(hotp.ok, false);
  if (!hotp.ok) assert.equal(hotp.error, "unsupported_otp_type");

  const valid = parseOtpAuthUri("otpauth://totp/Acme%20Corp:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Corp&algorithm=SHA256&digits=8&period=60");
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.config.secretBase32, "JBSWY3DPEHPK3PXP");
    assert.equal(valid.config.issuer, "Acme Corp");
    assert.equal(valid.config.accountName, "alice@example.com");
    assert.equal(valid.config.algorithm, "SHA256");
    assert.equal(valid.config.digits, 8);
    assert.equal(valid.config.period, 60);
  }
  assert.equal(parseOtpAuthUri("otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&period=5").ok, false);
  assert.equal(parseOtpAuthUri("otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&algorithm=MD5").ok, false);
}

{
  const d1 = createTestD1();
  const env = {
    DB: d1,
    VAULT_MASTER_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
    TOTP_ENABLED: "1",
    TOTP_ENROLLMENT_ENABLED: "1",
  } as unknown as Env;
  const ws = "ws_vault_test";

  const item = await putItem(env, ws, {
    kind: "login",
    label: "GitHub",
    account: "alice",
    origin: "https://github.com",
    fields: { username: "alice", password: "password123" },
  });
  assert.ok(item.id);
  assert.equal(item.hasTotp, false);

  const setPendingRes = await setLoginTotpPending(env, ws, item.id, {
    secretBase32: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    issuer: "GitHub",
  });
  assert.equal(setPendingRes.ok, true);

  const metaAfterPending = await getItemMeta(env, ws, item.id);
  assert.equal(metaAfterPending?.hasTotp, false);
  const statusPending = await getLoginTotpStatus(env, ws, item.id);
  assert.equal(statusPending?.configured, false);
  assert.equal(statusPending?.status, "pending");
  const codePending = await getLoginTotpCode(env, ws, item.id);
  assert.equal(codePending.ok, false);
  assert.equal(codePending.error, "totp_not_active");

  const actRes = await activateLoginTotp(env, ws, item.id);
  assert.equal(actRes.ok, true);
  assert.equal((await getItemMeta(env, ws, item.id))?.hasTotp, true);
  const statusActive = await getLoginTotpStatus(env, ws, item.id);
  assert.equal(statusActive?.configured, true);
  assert.equal(statusActive?.status, "active");
  const codeActive = await getLoginTotpCode(env, ws, item.id);
  assert.equal(codeActive.ok, true);
  assert.match(codeActive.code!, /^\d{6}$/);

  const updatedItem = await putItem(env, ws, {
    id: item.id,
    kind: "login",
    label: "GitHub Work",
    account: "alice_work",
    origin: "https://github.com",
    fields: { username: "alice_work", password: "new_secure_password_456" },
  });
  assert.equal(updatedItem.label, "GitHub Work");
  assert.equal((await getItemMeta(env, ws, item.id))?.hasTotp, true);
  const statusAfterEdit = await getLoginTotpStatus(env, ws, item.id);
  assert.equal(statusAfterEdit?.configured, true);
  assert.equal(statusAfterEdit?.status, "active");
  const codeAfterEdit = await getLoginTotpCode(env, ws, item.id);
  assert.equal(codeAfterEdit.ok, true);
  assert.match(codeAfterEdit.code!, /^\d{6}$/);
  const fields = await getItemFields(env, ws, item.id);
  assert.equal(fields?.password, "new_secure_password_456");
  assert.ok(fields?.__totp);

  const removeRes = await removeLoginTotp(env, ws, item.id);
  assert.equal(removeRes.ok, true);
  assert.equal((await getItemMeta(env, ws, item.id))?.hasTotp, false);
  assert.equal((await getLoginTotpStatus(env, ws, item.id))?.configured, false);

  // Runtime kill switch: encrypted config remains readable/removable, code generation fails closed.
  env.TOTP_ENABLED = "0";
  const disabled = await getLoginTotpCode(env, ws, item.id);
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error, "totp_disabled");
}

console.log("✔ Vault TOTP primitive and preservation tests passed!");
