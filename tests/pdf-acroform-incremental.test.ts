import assert from "node:assert/strict";
import { fillPdfAcroForm, inspectPdfBytes } from "../src/files/pdf";
import { r2KeyFor } from "../src/files/service";

console.log("▶ PDF AcroForm incremental-update regression");

function fixture(): Uint8Array {
  const enc = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
    "4 0 obj\n<< /Fields [5 0 R 6 0 R] >>\nendobj\n",
    "5 0 obj\n<< /T (FullName) /FT /Tx /V () >>\nendobj\n",
    "6 0 obj\n<< /T (Country) /FT /Ch /V () >>\nendobj\n",
  ];

  let pdf = "%PDF-1.7\n% OpenInst binary-safe fixture\n";
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(enc.encode(pdf).byteLength);
    pdf += object;
  }
  const xrefOffset = enc.encode(pdf).byteLength;
  pdf += "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc.encode(pdf);
}

function mockEnv(sourceId: string, sourceBytes: Uint8Array): any {
  const objects = new Map<string, Uint8Array>();
  const sourceKey = r2KeyFor("ws_pdf", sourceId);
  objects.set(sourceKey, sourceBytes.slice());
  const inserts: any[][] = [];
  return {
    ARTIFACTS: {
      _objects: objects,
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return { arrayBuffer: async () => bytes.slice().buffer };
      },
      async put(key: string, value: Uint8Array) { objects.set(key, value.slice()); },
      async delete(key: string) { objects.delete(key); },
    },
    DB: {
      _inserts: inserts,
      prepare(_sql: string) {
        return {
          _bindings: [] as any[],
          bind(...args: any[]) { this._bindings = args; return this; },
          async run() { inserts.push(this._bindings); return { meta: { changes: 1 } }; },
        };
      },
    },
  };
}

{
  const sourceId = "f_source";
  const original = fixture();
  assert.equal(inspectPdfBytes(original).supportedForFilling, true);
  const env = mockEnv(sourceId, original);

  const result = await fillPdfAcroForm(env, {
    workspaceId: "ws_pdf",
    sourceArtifactId: sourceId,
    fieldValues: { FullName: "王小明", Country: "Taiwan" },
    outputFilename: "filled.pdf",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error);

  const sourceAfter = env.ARTIFACTS._objects.get(r2KeyFor("ws_pdf", sourceId)) as Uint8Array;
  assert.deepEqual(sourceAfter, original, "source PDF must remain byte-for-byte unchanged");

  const output = env.ARTIFACTS._objects.get(result.newArtifact.r2_key) as Uint8Array;
  assert.ok(output.byteLength > original.byteLength);
  assert.deepEqual(output.slice(0, original.byteLength), original, "incremental update must preserve every original byte");

  const tail = new TextDecoder().decode(output.slice(original.byteLength));
  assert.ok(tail.includes("/V <FEFF738B5C0F660E>"), "Unicode value must be represented as UTF-16BE hex");
  assert.ok(tail.includes("/V <FEFF00540061006900770061006E>"));
  assert.ok(tail.includes("/NeedAppearances true"));
  assert.ok(tail.includes("/Prev "));
  assert.ok(tail.includes("xref\n"));
  assert.equal(inspectPdfBytes(output).supportedForFilling, true);
  assert.equal(env.DB._inserts.length, 1);
}

{
  // A PDF-like byte stream without a classic xref cannot be safely rewritten.
  const broken = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /AcroForm << /Fields [] >> >>\nendobj\n%%EOF");
  assert.equal(inspectPdfBytes(broken).supportedForFilling, false);
}

console.log("✅ PDF AcroForm incremental-update regression passed");
