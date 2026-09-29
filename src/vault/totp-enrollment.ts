// vault/totp-enrollment.ts — Deterministic authenticator enrollment extraction.
// Extracts seeds from page DOM (otpauth URI / labeled Base32 key) without ever sending QR images to the model.

export interface ExtractedEnrollment {
  ok: boolean;
  source: "otpauth_uri" | "manual_key" | "qr_decode";
  secretBase32?: string;
  otpauthUri?: string;
  error?: string;
}

export interface EnrollmentDomCandidate {
  text?: string;
  value?: string;
  href?: string;
  dataAttrs?: Record<string, string>;
  label?: string;
}

const OTPAUTH_RE = /otpauth:\/\/totp\/[^\s"'<>]+/i;
const BASE32_RE = /\b([A-Z2-7]{16,64})\b/;

function isLikelyBase32(s: string): boolean {
  const clean = s.replace(/[\s\-=]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean)) return false;
  if (clean.length < 16 || clean.length > 64) return false;
  return /[2-7]/.test(clean);
}

export function extractEnrollmentSecret(candidates: EnrollmentDomCandidate[]): ExtractedEnrollment {
  for (const c of candidates) {
    const fields = [c.text, c.value, c.href, ...Object.values(c.dataAttrs ?? {})].filter(Boolean) as string[];
    for (const f of fields) {
      const m = f.match(OTPAUTH_RE);
      if (m) return { ok: true, source: "otpauth_uri", otpauthUri: m[0] };
    }
  }

  const manualLabeled = candidates.some((c) =>
    /setup\s*key|manual\s*(?:setup|entry)|account\s*key|authenticator\s*key|备用码|密钥|设置密钥|无法扫描/i.test(
      [c.label, c.text].filter(Boolean).join(" "),
    ),
  );
  if (manualLabeled) {
    for (const c of candidates) {
      const fields = [c.text, c.value].filter(Boolean) as string[];
      for (const f of fields) {
        const m = f.match(BASE32_RE);
        if (m && isLikelyBase32(m[1])) {
          return { ok: true, source: "manual_key", secretBase32: m[1].replace(/[\s\-=]/g, "").toUpperCase() };
        }
      }
    }
  }

  // A naked input value is not enough: pages contain many Base32-looking IDs/tokens. Only accept it
  // when that exact candidate carries an authenticator/setup-key label.
  for (const c of candidates) {
    const label = [c.label, c.text].filter(Boolean).join(" ");
    if (c.value && /setup\s*key|authenticator\s*key|manual\s*(?:setup|entry)|密钥|设置密钥/i.test(label) && isLikelyBase32(c.value.trim())) {
      return { ok: true, source: "manual_key", secretBase32: c.value.replace(/[\s\-=]/g, "").toUpperCase() };
    }
  }

  return { ok: false, source: "manual_key", error: "no_secret_found" };
}

export interface EnrollmentEvidence {
  enabledCopy: boolean;
  securityEntry: boolean;
  subsequentChallenge: boolean;
}

export function hasEnrollmentSuccessEvidence(ev: EnrollmentEvidence): boolean {
  // Clicking Submit or merely seeing the word "authenticator" is not proof that the server accepted
  // the seed. Require corroborated enabled-state UI, or a subsequent real challenge that succeeded.
  return (ev.enabledCopy && ev.securityEntry) || ev.subsequentChallenge;
}

const HIGH_RISK_LABELS = [
  /add\s*authenticator/i,
  /enable\s*2fa/i,
  /enable\s*two-factor/i,
  /change\s*mfa/i,
  /remove\s*authenticator/i,
  /disable\s*2fa/i,
  /replace\s*authenticator/i,
  /添加身份验证器/,
  /启用两步验证/,
  /修改 MFA/,
  /移除身份验证器/,
  /停用两步验证/,
];

export function isHighRiskMfaAction(label: string): boolean {
  return HIGH_RISK_LABELS.some((re) => re.test(String(label ?? "")));
}

/** Final security-changing submit always requires explicit owner approval; remove/disable/replace MUST. */
export function requiresOwnerApprovalForEnrollment(label: string): boolean {
  const l = String(label ?? "");
  const destructive = /remove\s*authenticator|disable\s*2fa|replace\s*authenticator|移除身份验证器|停用两步验证/i.test(l);
  if (destructive) return true;
  return isHighRiskMfaAction(l);
}
