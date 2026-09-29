//
// PDF / Form Document workflow (spec §15.5, §15.6, §15.7).
//
// This module intentionally supports a conservative subset of digital PDF
// forms: unencrypted AcroForm PDFs with a classic xref table and directly
// addressable text/choice field objects. Unsupported PDFs fail closed instead
// of being rewritten as text (which corrupts binary streams and xref offsets).
//
import type { Env } from "../env";
import { type ArtifactRow, newArtifactId, r2KeyFor } from "./service";

export interface PdfFieldInfo {
  name: string;
  type: "text" | "checkbox" | "choice" | "signature" | "unknown";
  currentValue?: string;
  options?: string[];
  readOnly?: boolean;
  required?: boolean;
}

export interface PdfInspectionResult {
  isPdf: boolean;
  isEncrypted: boolean;
  pageCount: number;
  fields: PdfFieldInfo[];
  supportedForFilling: boolean;
  formType: "AcroForm" | "XFA" | "none";
}

interface ParsedObject {
  objectNumber: number;
  generation: number;
  body: string;
}

interface ParsedField extends PdfFieldInfo {
  objectNumber: number;
  generation: number;
}

interface ClassicTrailer {
  startXref: number;
  size: number;
  rootObject: number;
  rootGeneration: number;
  infoRef?: string;
  idEntry?: string;
}

function binaryText(bytes: Uint8Array): string {
  // We only inspect ASCII PDF syntax. The decoded string is never encoded back
  // into the original document, so non-ASCII stream bytes remain untouched.
  return new TextDecoder("latin1").decode(bytes);
}

function parseObjects(text: string): Map<string, ParsedObject> {
  const objects = new Map<string, ParsedObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const objectNumber = Number(m[1]);
    const generation = Number(m[2]);
    objects.set(`${objectNumber}:${generation}`, { objectNumber, generation, body: m[3] });
  }
  return objects;
}

function decodePdfLiteral(raw: string): string {
  return raw.replace(/\\([nrtbf()\\])/g, (_m, c: string) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    if (c === "b") return "\b";
    if (c === "f") return "\f";
    return c;
  });
}

function parseLiteralAfter(body: string, key: string): string | undefined {
  const re = new RegExp(`\\/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`);
  const m = body.match(re);
  return m ? decodePdfLiteral(m[1]) : undefined;
}

function parseCurrentValue(body: string): string | undefined {
  const literal = parseLiteralAfter(body, "V");
  if (literal !== undefined) return literal;
  const name = body.match(/\/V\s*\/([^\s<>\[\]()]+)/);
  return name?.[1];
}

function parseFields(objects: Map<string, ParsedObject>): ParsedField[] {
  const fields: ParsedField[] = [];
  for (const obj of objects.values()) {
    const name = parseLiteralAfter(obj.body, "T");
    if (!name) continue;
    const ft = obj.body.match(/\/FT\s*\/([A-Za-z]+)/)?.[1];
    if (!ft) continue; // inherited/packed fields are inspectable only with a full PDF parser

    let type: PdfFieldInfo["type"] = "unknown";
    if (ft === "Tx") type = "text";
    else if (ft === "Btn") type = "checkbox";
    else if (ft === "Ch") type = "choice";
    else if (ft === "Sig") type = "signature";

    const flags = Number(obj.body.match(/\/Ff\s+(\d+)/)?.[1] ?? 0);
    fields.push({
      name,
      type,
      currentValue: parseCurrentValue(obj.body),
      readOnly: (flags & 1) !== 0,
      required: (flags & 2) !== 0,
      objectNumber: obj.objectNumber,
      generation: obj.generation,
    });
  }
  return fields;
}

function parseClassicTrailer(text: string): ClassicTrailer | null {
  const startMatches = Array.from(text.matchAll(/startxref\s+(\d+)\s+%%EOF/g));
  const last = startMatches.at(-1);
  if (!last) return null;
  const startXref = Number(last[1]);
  if (!Number.isSafeInteger(startXref) || startXref < 0) return null;
  if (text.slice(startXref, startXref + 4) !== "xref") return null; // xref stream unsupported

  const tail = text.slice(startXref, last.index);
  if (/\/XRefStm\b/.test(tail)) return null; // hybrid-reference PDF unsupported
  const trailerMatches = Array.from(tail.matchAll(/trailer\s*<<([\s\S]*?)>>/g));
  const dict = trailerMatches.at(-1)?.[1];
  if (!dict || /\/Encrypt\b/.test(dict)) return null;

  const size = Number(dict.match(/\/Size\s+(\d+)/)?.[1]);
  const root = dict.match(/\/Root\s+(\d+)\s+(\d+)\s+R/);
  if (!Number.isSafeInteger(size) || !root) return null;

  const info = dict.match(/\/Info\s+(\d+)\s+(\d+)\s+R/);
  const id = dict.match(/\/ID\s*(\[[\s\S]*?\])/);
  return {
    startXref,
    size,
    rootObject: Number(root[1]),
    rootGeneration: Number(root[2]),
    infoRef: info ? `${info[1]} ${info[2]} R` : undefined,
    idEntry: id?.[1],
  };
}

function findAcroFormObject(objects: Map<string, ParsedObject>, trailer: ClassicTrailer): ParsedObject | null {
  const root = objects.get(`${trailer.rootObject}:${trailer.rootGeneration}`);
  if (!root) return null;
  const ref = root.body.match(/\/AcroForm\s+(\d+)\s+(\d+)\s+R/);
  if (!ref) return null; // direct AcroForm dictionaries fail closed
  return objects.get(`${Number(ref[1])}:${Number(ref[2])}`) ?? null;
}

/** Inspect a PDF without mutating/re-encoding its bytes. */
export function inspectPdfBytes(bytes: Uint8Array): PdfInspectionResult {
  const text = binaryText(bytes);
  if (!text.startsWith("%PDF-")) {
    return { isPdf: false, isEncrypted: false, pageCount: 0, fields: [], supportedForFilling: false, formType: "none" };
  }

  const isEncrypted = /\/Encrypt\b/.test(text);
  const isXFA = /\/XFA\b/.test(text);
  const pageMatches = text.match(/\/Type\s*\/Page\b/g);
  const pageCount = pageMatches ? pageMatches.length : 1;
  const objects = parseObjects(text);
  const parsedFields = parseFields(objects);
  const fields: PdfFieldInfo[] = parsedFields.map(({ objectNumber: _n, generation: _g, ...field }) => field);
  const hasAcroForm = /\/AcroForm\b/.test(text) || fields.length > 0;
  const formType = isXFA ? "XFA" : hasAcroForm ? "AcroForm" : "none";

  const trailer = !isEncrypted && !isXFA ? parseClassicTrailer(text) : null;
  const acroFormObject = trailer ? findAcroFormObject(objects, trailer) : null;
  const hasWritableSupportedField = parsedFields.some(
    (f) => !f.readOnly && (f.type === "text" || f.type === "choice"),
  );

  return {
    isPdf: true,
    isEncrypted,
    pageCount: Math.max(pageCount, 1),
    fields,
    supportedForFilling:
      !isEncrypted &&
      !isXFA &&
      formType === "AcroForm" &&
      !!trailer &&
      !!acroFormObject &&
      hasWritableSupportedField,
    formType,
  };
}

function utf16BeHex(value: string): string {
  const units: number[] = [0xfe, 0xff];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    units.push((code >> 8) & 0xff, code & 0xff);
  }
  return `<${units.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("")}>`;
}

function replaceFieldValue(body: string, encodedValue: string): string {
  const valueRe = /\/V\s*(?:\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\/[^\s<>\[\]()]+|\d+\s+\d+\s+R)/;
  if (valueRe.test(body)) return body.replace(valueRe, `/V ${encodedValue}`);
  const end = body.lastIndexOf(">>");
  if (end < 0) throw new Error("pdf_field_dictionary_invalid");
  return `${body.slice(0, end)} /V ${encodedValue} ${body.slice(end)}`;
}

function enableNeedAppearances(body: string): string {
  if (/\/NeedAppearances\s+(?:true|false)/.test(body)) {
    return body.replace(/\/NeedAppearances\s+(?:true|false)/, "/NeedAppearances true");
  }
  const end = body.lastIndexOf(">>");
  if (end < 0) throw new Error("pdf_acroform_dictionary_invalid");
  return `${body.slice(0, end)} /NeedAppearances true ${body.slice(end)}`;
}

function asciiBytes(value: string): Uint8Array {
  // Everything appended by this module is ASCII: user strings are represented
  // as UTF-16BE hexadecimal PDF strings.
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) throw new Error("pdf_incremental_update_non_ascii");
  }
  return new TextEncoder().encode(value);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function buildIncrementalUpdate(
  original: Uint8Array,
  replacements: ParsedObject[],
  trailer: ClassicTrailer,
): Uint8Array {
  const prefix = asciiBytes("\n");
  const objectParts: Uint8Array[] = [prefix];
  const xrefEntries: Array<{ objectNumber: number; generation: number; offset: number }> = [];
  let currentOffset = original.byteLength + prefix.byteLength;

  const sorted = [...replacements].sort((a, b) => a.objectNumber - b.objectNumber || a.generation - b.generation);
  for (const obj of sorted) {
    const serialized = asciiBytes(`${obj.objectNumber} ${obj.generation} obj\n${obj.body.trim()}\nendobj\n`);
    xrefEntries.push({ objectNumber: obj.objectNumber, generation: obj.generation, offset: currentOffset });
    objectParts.push(serialized);
    currentOffset += serialized.byteLength;
  }

  const xrefOffset = currentOffset;
  let xref = "xref\n";
  for (const entry of xrefEntries) {
    xref += `${entry.objectNumber} 1\n${String(entry.offset).padStart(10, "0")} ${String(entry.generation).padStart(5, "0")} n \n`;
  }

  const maxObject = xrefEntries.reduce((m, e) => Math.max(m, e.objectNumber), 0);
  const size = Math.max(trailer.size, maxObject + 1);
  let trailerDict = `/Size ${size} /Root ${trailer.rootObject} ${trailer.rootGeneration} R /Prev ${trailer.startXref}`;
  if (trailer.infoRef) trailerDict += ` /Info ${trailer.infoRef}`;
  if (trailer.idEntry) trailerDict += ` /ID ${trailer.idEntry}`;

  const footer = asciiBytes(`${xref}trailer\n<< ${trailerDict} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return concatBytes([original, ...objectParts, footer]);
}

/**
 * Fill supported text/choice fields using a standards-compliant incremental
 * update. Original bytes and xref entries are never rewritten.
 */
export async function fillPdfAcroForm(
  env: Env,
  input: {
    workspaceId: string;
    sourceArtifactId: string;
    fieldValues: Record<string, string>;
    outputFilename?: string;
  },
): Promise<{ ok: true; newArtifact: ArtifactRow } | { ok: false; error: string }> {
  const entries = Object.entries(input.fieldValues ?? {});
  if (entries.length === 0) return { ok: false, error: "pdf_field_values_required" };
  if (entries.length > 100 || entries.some(([name, value]) => !name || value.length > 10_000)) {
    return { ok: false, error: "pdf_field_values_invalid" };
  }

  const sourceObj = await env.ARTIFACTS.get(r2KeyFor(input.workspaceId, input.sourceArtifactId));
  if (!sourceObj) return { ok: false, error: "source_artifact_not_found" };

  const sourceBytes = new Uint8Array(await sourceObj.arrayBuffer());
  const inspection = inspectPdfBytes(sourceBytes);
  if (!inspection.supportedForFilling) {
    return { ok: false, error: inspection.isEncrypted ? "pdf_encrypted" : "pdf_form_unsupported" };
  }

  const text = binaryText(sourceBytes);
  const objects = parseObjects(text);
  const trailer = parseClassicTrailer(text);
  if (!trailer) return { ok: false, error: "pdf_xref_unsupported" };
  const acroForm = findAcroFormObject(objects, trailer);
  if (!acroForm) return { ok: false, error: "pdf_form_unsupported" };

  const fields = parseFields(objects);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const replacements = new Map<string, ParsedObject>();

  try {
    for (const [fieldName, value] of entries) {
      const field = byName.get(fieldName);
      if (!field) return { ok: false, error: `pdf_field_not_found:${fieldName}` };
      if (field.readOnly) return { ok: false, error: `pdf_field_read_only:${fieldName}` };
      if (field.type !== "text" && field.type !== "choice") {
        return { ok: false, error: `pdf_field_type_unsupported:${fieldName}` };
      }
      const key = `${field.objectNumber}:${field.generation}`;
      const original = replacements.get(key) ?? objects.get(key);
      if (!original) return { ok: false, error: `pdf_field_object_missing:${fieldName}` };
      replacements.set(key, {
        ...original,
        body: replaceFieldValue(original.body, utf16BeHex(String(value))),
      });
    }

    const acroKey = `${acroForm.objectNumber}:${acroForm.generation}`;
    const maybeUpdatedAcro = replacements.get(acroKey) ?? acroForm;
    replacements.set(acroKey, { ...maybeUpdatedAcro, body: enableNeedAppearances(maybeUpdatedAcro.body) });
  } catch (e: any) {
    return { ok: false, error: e?.message || "pdf_form_update_failed" };
  }

  let filledBytes: Uint8Array;
  try {
    filledBytes = buildIncrementalUpdate(sourceBytes, Array.from(replacements.values()), trailer);
  } catch (e: any) {
    return { ok: false, error: e?.message || "pdf_form_update_failed" };
  }

  const validation = inspectPdfBytes(filledBytes);
  if (!validation.isPdf || validation.isEncrypted || !validation.supportedForFilling) {
    return { ok: false, error: "pdf_output_validation_failed" };
  }

  const newId = newArtifactId();
  const newKey = r2KeyFor(input.workspaceId, newId);
  const filename = input.outputFilename || `filled_${input.sourceArtifactId}.pdf`;

  await env.ARTIFACTS.put(newKey, filledBytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { sourceArtifactId: input.sourceArtifactId, filledAt: String(Date.now()) },
  });

  const now = Date.now();
  const row: ArtifactRow = {
    id: newId,
    workspace_id: input.workspaceId,
    thread_id: null,
    task_id: null,
    kind: "generated",
    filename,
    mime_type: "application/pdf",
    size_bytes: filledBytes.byteLength,
    r2_key: newKey,
    source: "pdf_form_fill",
    source_ref: input.sourceArtifactId,
    created_at: now,
    deleted_at: null,
  };

  try {
    await env.DB.prepare(
      `INSERT INTO artifacts (id, workspace_id, thread_id, task_id, kind, filename, mime_type, size_bytes, r2_key, source, source_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.workspace_id,
        row.thread_id,
        row.task_id,
        row.kind,
        row.filename,
        row.mime_type,
        row.size_bytes,
        row.r2_key,
        row.source,
        row.source_ref,
        row.created_at,
      )
      .run();
  } catch (e) {
    await env.ARTIFACTS.delete(newKey).catch(() => {});
    throw e;
  }

  return { ok: true, newArtifact: row };
}
