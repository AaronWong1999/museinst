import assert from "node:assert/strict";
import { detectCardBrand, validateLuhn, validatePaymentCard } from "../src/vault/card";

console.log("▶ Testing Vault Card Validation & Luhn Algorithm...");

// 1. Luhn Validation
assert.equal(validateLuhn("49927398716"), true, "Valid Luhn vector 1");
assert.equal(validateLuhn("49927398717"), false, "Invalid Luhn vector 1 (corrupted check digit)");
assert.equal(validateLuhn("79927398713"), true, "Valid Luhn vector 2");
assert.equal(validateLuhn("79927398710"), false, "Invalid Luhn vector 2");
assert.equal(validateLuhn("4111 1111 1111 1111"), true, "Valid Visa test card with spaces");
assert.equal(validateLuhn("4111-1111-1111-1112"), false, "Invalid Visa test card with dashes");

// 2. Brand Detection
assert.equal(detectCardBrand("4111111111111111"), "visa");
assert.equal(detectCardBrand("5105105105105100"), "mastercard");
assert.equal(detectCardBrand("2221000000000000"), "mastercard"); // MC 2-series
assert.equal(detectCardBrand("378282246310005"), "american-express");
assert.equal(detectCardBrand("340000000000000"), "american-express");
assert.equal(detectCardBrand("6011000000000000"), "discover");
assert.equal(detectCardBrand("3528000000000000"), "jcb");
assert.equal(detectCardBrand("36000000000000"), "diners-club");
assert.equal(detectCardBrand("6200000000000000"), "unionpay");
assert.equal(detectCardBrand("9999000000000000"), "unknown");

// 3. Full Payment Card Validation
const validCard = validatePaymentCard({
  number: "4111 1111 1111 1111",
  expirationMonth: 12,
  expirationYear: 2030,
  securityCode: "123",
});
assert.equal(validCard.valid, true);
assert.equal(validCard.brand, "visa");

const amexCard = validatePaymentCard({
  number: "378282246310005",
  expirationMonth: 5,
  expirationYear: 2029,
  securityCode: "1234",
});
assert.equal(amexCard.valid, true);
assert.equal(amexCard.brand, "american-express");

// Amex with 3 digit CVV should fail
const badAmex = validatePaymentCard({
  number: "378282246310005",
  expirationMonth: 5,
  expirationYear: 2029,
  securityCode: "123",
});
assert.equal(badAmex.valid, false);
assert.equal(badAmex.error, "invalid_security_code");

// Expired card should fail
const expired = validatePaymentCard({
  number: "4111 1111 1111 1111",
  expirationMonth: 1,
  expirationYear: 2020,
  securityCode: "123",
});
assert.equal(expired.valid, false);
assert.equal(expired.error, "expired_or_invalid_date");

// Invalid month should fail
const badMonth = validatePaymentCard({
  number: "4111 1111 1111 1111",
  expirationMonth: 13,
  expirationYear: 2030,
  securityCode: "123",
});
assert.equal(badMonth.valid, false);
assert.equal(badMonth.error, "expired_or_invalid_date");

console.log("✔ Card validation tests passed!");
