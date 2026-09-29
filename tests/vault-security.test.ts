import assert from "node:assert/strict";
import {
  putItem,
  encryptVaultPayload,
  decryptVaultPayload,
} from "../src/vault/service";
import type { Env } from "../src/env";

console.log("▶ Testing Vault PCI DSS 3.2 Compliance (CVV Stripping & Cryptographic Roundtrip)...");

let savedCiphertext = "";

const mockEnv: Env = {
  VAULT_MASTER_KEY: "super-secure-master-key-32-bytes-long!",
  OPENINST_SECRET: "mock-secret-key-12345",
  DB: {
    prepare: (sql: string) => {
      return {
        bind: (...params: unknown[]) => {
          if (sql.includes("encrypted_secrets")) {
            savedCiphertext = params[2] as string;
          }
          return { sql, params };
        },
      };
    },
    batch: async (statements: any[]) => {
      return statements.map(() => ({ success: true }));
    },
  } as any,
} as any;

async function runTests() {
  // 1. Payment Card Storage with CVV/securityCode
  const result = await putItem(mockEnv, "ws_test_123", {
    kind: "payment",
    label: "My Visa Card",
    account: "card",
    fields: {
      number: "4111 1111 1111 1111",
      expMonth: "12",
      expYear: "2030",
      cvv: "123",
      securityCode: "123",
      cardholderName: "Aaron Wong",
    },
  });

  assert.equal(result.kind, "payment");
  assert.equal(result.account, "visa (•••• 1111)");
  assert.ok(savedCiphertext.length > 0, "Ciphertext must be generated");

  // 2. Decrypt saved ciphertext and verify CVV/securityCode is ABSENT
  const decryptedJson = await decryptVaultPayload(mockEnv, "ws_test_123", result.id, savedCiphertext);
  const decryptedFields = JSON.parse(decryptedJson);

  // Assert sensitive card data is stored safely
  assert.equal(decryptedFields.number, "4111 1111 1111 1111");
  assert.equal(decryptedFields.expMonth, "12");
  assert.equal(decryptedFields.expYear, "2030");
  assert.equal(decryptedFields.brand, "visa");
  assert.equal(decryptedFields.cardholderName, "Aaron Wong");

  // CRITICAL PCI DSS Requirement 3.2: CVV and securityCode must NEVER exist in stored ciphertext!
  assert.equal(decryptedFields.cvv, undefined, "CVV must be stripped before encryption!");
  assert.equal(decryptedFields.securityCode, undefined, "securityCode must be stripped before encryption!");

  // 3. Encrypt / Decrypt Roundtrip
  const testPayload = JSON.stringify({ username: "testuser", token: "secret-token-123" });
  const ct = await encryptVaultPayload(mockEnv, "ws_test_123", "item_custom", testPayload);
  const pt = await decryptVaultPayload(mockEnv, "ws_test_123", "item_custom", ct);
  assert.equal(pt, testPayload);

  // 4. Workspace isolation: decrypting with different workspace ID must fail
  await assert.rejects(
    async () => {
      await decryptVaultPayload(mockEnv, "ws_DIFFERENT_999", "item_custom", ct);
    },
    "Ciphertext encrypted under one workspace must fail decryption under another workspace"
  );

  console.log("✔ Vault PCI DSS & encryption tests passed!");
}

runTests();
