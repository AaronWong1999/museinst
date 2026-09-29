// vault/totp-detector.ts — Deterministic TOTP target detector & negative signal filter.
// Generic OTP fields are intentionally insufficient: SMS/email OTP commonly use the same HTML attributes.

export interface TotpInputAttributes {
  name?: string;
  id?: string;
  type?: string;
  autocomplete?: string;
  ariaLabel?: string;
  placeholder?: string;
  maxlength?: number | string;
}

export interface TotpDetectionContext {
  attributes?: TotpInputAttributes;
  elementText?: string;
  nearbyText?: string;
  inputCount?: number;
}

export interface TotpDetectionResult {
  isTotp: boolean;
  rejectedReason?: string;
  matchedSignals?: string[];
}

const NEGATIVE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "sms", pattern: /\b(sms|text\s*message|phone\s*code|mobile\s*code|短信|手机验证码)\b/i },
  { name: "email", pattern: /\b(email\s*(?:verification\s*)?code|sent\s*to\s*your\s*email|check\s*your\s*email|邮箱验证码|邮件验证码)\b/i },
  { name: "push", pattern: /\b(push\s*notification|approve\s*(?:it\s*)?on\s*(?:your\s*)?phone|推送通知|在手机上确认)\b/i },
  { name: "security_key", pattern: /\b(security\s*key|安全密钥|u2f)\b/i },
  { name: "passkey", pattern: /\b(passkey|通行密钥)\b/i },
  { name: "webauthn", pattern: /\b(webauthn)\b/i },
  { name: "captcha", pattern: /\b(captcha|图形验证码|人机验证)\b/i },
];

const STRONG_TOTP_PATTERN = /\b(totp|time[-\s]*based(?:\s+one[-\s]*time)?|authenticator(?:\s*app)?|google\s*authenticator|microsoft\s*authenticator|authy)\b|身份验证器|谷歌验证器|动态口令/i;
const STRONG_ATTR_PATTERN = /(?:^|[-_\s])(totp|authenticator)(?:$|[-_\s])/i;
const SUPPORTING_2FA_PATTERN = /\b(2fa|mfa|two[-\s]*factor|two[-\s]*step)\b/i;
const CODE_ATTR_PATTERN = /(?:^|[-_\s])(otp|totp|authenticator|verification|code|2fa|mfa)(?:$|[-_\s])/i;

export function detectTotpPrompt(ctx: TotpDetectionContext): TotpDetectionResult {
  const attrs = ctx.attributes ?? {};
  const attrText = [attrs.name, attrs.id, attrs.ariaLabel, attrs.placeholder].filter(Boolean).join(" ");
  const combinedText = [ctx.elementText ?? "", ctx.nearbyText ?? "", attrText].join(" ");

  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.pattern.test(combinedText)) return { isTotp: false, rejectedReason: "not_totp_prompt" };
  }

  const matchedSignals: string[] = [];
  const strongText = STRONG_TOTP_PATTERN.test(combinedText);
  const strongAttr = STRONG_ATTR_PATTERN.test(attrText);
  if (strongText) matchedSignals.push("authenticator_text");
  if (strongAttr) matchedSignals.push("authenticator_attribute");

  const oneTimeAutocomplete = Boolean(attrs.autocomplete && /one-time-code/i.test(attrs.autocomplete));
  const codeAttr = CODE_ATTR_PATTERN.test(attrText);
  const ml = Number(attrs.maxlength);
  const sizedBox = ml === 1 || ml === 6 || ml === 8;
  const splitShape = ctx.inputCount === 6 || ctx.inputCount === 8;

  if (oneTimeAutocomplete) matchedSignals.push("autocomplete_one_time_code");
  if (codeAttr) matchedSignals.push("code_attribute");
  if (SUPPORTING_2FA_PATTERN.test(combinedText)) matchedSignals.push("two_factor_context");
  if (ml === 6 || ml === 8) matchedSignals.push("maxlength_6_or_8");
  if (splitShape) matchedSignals.push("split_input_count");

  if (!strongText && !strongAttr) {
    return {
      isTotp: false,
      rejectedReason: matchedSignals.length > 0 ? "generic_otp_not_proven_totp" : "no_totp_signals",
      matchedSignals,
    };
  }

  // Authenticator copy elsewhere on the page must not authorize writing a code into an unrelated
  // text field (search box, username, coupon, etc.). The target itself must look OTP-shaped.
  if (!strongAttr && !oneTimeAutocomplete && !codeAttr && !sizedBox && !splitShape) {
    return { isTotp: false, rejectedReason: "target_not_otp_shaped", matchedSignals };
  }

  return { isTotp: true, matchedSignals };
}
