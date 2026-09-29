import assert from "node:assert/strict";
import {
  formatUserProfileForPrompt,
  mergeUserProfile,
  type UserProfile,
} from "../src/agent/personal-info";

console.log("▶ Testing Personal Info & Structured Memory Engine...");

// 1. Initial Empty Profile
const emptyProfile: UserProfile = {};
assert.equal(formatUserProfileForPrompt(emptyProfile), null, "Empty profile should produce null");

// 2. Merge User Profile
const baseProfile: UserProfile = {
  fullName: "Aaron Wong",
  preferredName: "Aaron",
  email: "aaron@example.com",
  timezone: "Asia/Shanghai",
  addresses: {
    home: {
      recipientName: "Aaron",
      city: "Hangzhou",
      line1: "Xihu District",
    },
  },
  travelPreferences: {
    seat: "window",
  },
  customNotes: {
    diet: "Low sugar",
  },
};

const update: Partial<UserProfile> = {
  timezone: "Asia/Singapore",
  travelPreferences: {
    seat: "aisle",
  },
  addresses: {
    shipping: {
      recipientName: "Aaron W",
      city: "Singapore",
      line1: "Marina Bay",
    },
  },
  customNotes: {
    coffee: "Black",
  },
};

const merged = mergeUserProfile(baseProfile, update);
assert.equal(merged.fullName, "Aaron Wong");
assert.equal(merged.preferredName, "Aaron");
assert.equal(merged.email, "aaron@example.com");
assert.equal(merged.timezone, "Asia/Singapore");
assert.equal(merged.travelPreferences?.seat, "aisle");

// Deep merge of addresses
assert.equal(merged.addresses?.home?.city, "Hangzhou");
assert.equal(merged.addresses?.shipping?.city, "Singapore");

// Deep merge of customNotes
assert.equal(merged.customNotes?.diet, "Low sugar");
assert.equal(merged.customNotes?.coffee, "Black");

// 3. Prompt Formatting
const promptBlock = formatUserProfileForPrompt(merged);
assert.ok(promptBlock !== null);
assert.match(promptBlock, /用户个人信息与常用表单画像/);
assert.match(promptBlock, /Aaron Wong/);
assert.match(promptBlock, /Asia\/Singapore/);
assert.match(promptBlock, /Marina Bay/);

console.log("✔ Personal Info & Structured Memory tests passed!");
