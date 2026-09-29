// channels/email/trust-control/sign.ts — Ed25519 signing and verification for trust-control protocol.

import { canonicalBytes } from "./canonical";
import type { TrustControlEnvelope } from "./schema";
import { b64urlDecode, b64urlEncode } from "../a2a/codec";
export { generateSigningKey, jwkFromX, xFromJwk, type EdKeyPair } from "../a2a/sign";

export async function signTrustControlEnvelope(privateJwk: JsonWebKey, envelope: TrustControlEnvelope): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  const bytes = canonicalBytes(envelope);
  const sigBuf = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return b64urlEncode(new Uint8Array(sigBuf));
}

export async function verifyTrustControlEnvelopeSig(
  publicJwk: JsonWebKey,
  envelope: TrustControlEnvelope,
  sigB64url: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, ["verify"]);
    const bytes = canonicalBytes(envelope);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64urlDecode(sigB64url).buffer as ArrayBuffer,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  } catch {
    return false;
  }
}
