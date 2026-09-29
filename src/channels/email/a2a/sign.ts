


import { canonicalBytes } from "./canonical";
import type { A2aEnvelope } from "./schema";
import { b64urlDecode, b64urlEncode } from "./codec";

export interface EdKeyPair {
  kid: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

export async function generateSigningKey(kid: string): Promise<EdKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { kid, publicJwk, privateJwk };
}

export function envelopeWithoutSig(e: A2aEnvelope): Record<string, unknown> {
  const { sig: _sig, ...rest } = e as A2aEnvelope & { sig?: string };
  void _sig;
  return rest as Record<string, unknown>;
}

export async function signEnvelope(privateJwk: JsonWebKey, envelope: A2aEnvelope): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  const bytes = canonicalBytes(envelopeWithoutSig(envelope));
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return b64urlEncode(new Uint8Array(sigBuf));
}

export async function verifyEnvelopeSig(publicJwk: JsonWebKey, envelope: A2aEnvelope, sigB64url: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, ["verify"]);
    const bytes = canonicalBytes(envelopeWithoutSig(envelope));
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


export function jwkFromX(x: string): JsonWebKey {
  return { kty: "OKP", crv: "Ed25519", x, ext: true, key_ops: ["verify"] };
}

export function xFromJwk(jwk: JsonWebKey): string {
  return String((jwk as { x?: string }).x ?? "");
}
