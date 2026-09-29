import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse } from "@babel/parser";
import ts from "typescript";

const CHECK_ONLY = process.argv.includes("--check");
const ROOT = process.cwd();
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".wrangler",
  ".generated",
  ".zcode",
  ".commandcode",
]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".jsonc"]);
const LINE_COMMENT_EXTENSIONS = new Set([".yml", ".yaml", ".toml", ".sh", ".py"]);
const HASH_COMMENT_FILES = new Set(["Dockerfile", ".dev.vars.example"]);

function extension(path) {
  const match = path.match(/(\.[^.\/]+)$/);
  return match?.[1]?.toLowerCase() ?? "";
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function blankPreservingLines(value) {
  return value.replace(/[^\r\n]/g, " ");
}

function scannerCommentRanges(text, jsx) {
  const ranges = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      const value = text.slice(start, end);
      if (CJK.test(value)) ranges.push([start, end]);
    }
  }
  return ranges;
}

function parserCommentRanges(path, text) {
  const ext = extension(path);
  const plugins = ext === ".ts" || ext === ".tsx" ? ["typescript"] : [];
  if (ext === ".tsx" || ext === ".jsx") plugins.push("jsx");
  const parsed = parse(text, {
    sourceType: "unambiguous",
    plugins,
    allowReturnOutsideFunction: true,
  });
  return parsed.comments
    .filter((comment) => CJK.test(comment.value))
    .map((comment) => [comment.start, comment.end]);
}

function regexCommentRanges(text, regex) {
  const ranges = [];
  for (const match of text.matchAll(regex)) {
    if (match.index === undefined || !CJK.test(match[0])) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function rangesFor(path, text) {
  const ext = extension(path);
  if (CODE_EXTENSIONS.has(ext)) {
    return ext === ".jsonc" ? scannerCommentRanges(text, false) : parserCommentRanges(path, text);
  }
  if (ext === ".sql") {
    return [
      ...regexCommentRanges(text, /--[^\r\n]*/gu),
      ...regexCommentRanges(text, /\/\*[\s\S]*?\*\//gu),
    ];
  }
  if (ext === ".css") {
    return regexCommentRanges(text, /\/\*[\s\S]*?\*\//gu);
  }
  if (ext === ".html") {
    return regexCommentRanges(text, /<!--[\s\S]*?-->/gu);
  }
  if (LINE_COMMENT_EXTENSIONS.has(ext) || HASH_COMMENT_FILES.has(basename(path))) {
    return regexCommentRanges(text, /^[ \t]*#[^\r\n]*/gmu);
  }
  return [];
}

function mergeRanges(ranges) {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function lineAt(text, offset) {
  return text.slice(0, offset).split(/\r?\n/u).length;
}

const offenders = [];
let changedFiles = 0;
for (const path of walk(ROOT)) {
  const ext = extension(path);
  const supported =
    CODE_EXTENSIONS.has(ext) ||
    LINE_COMMENT_EXTENSIONS.has(ext) ||
    HASH_COMMENT_FILES.has(basename(path)) ||
    new Set([".sql", ".css", ".html"]).has(ext);
  if (!supported) continue;

  const text = readFileSync(path, "utf8");
  const ranges = mergeRanges(rangesFor(path, text));
  if (ranges.length === 0) continue;
  const display = relative(ROOT, path);
  for (const [start] of ranges) offenders.push(`${display}:${lineAt(text, start)}`);
  if (CHECK_ONLY) continue;

  let next = text;
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + blankPreservingLines(next.slice(start, end)) + next.slice(end);
  }
  writeFileSync(path, next.replace(/[ \t]+(?=\r?$)/gmu, ""), "utf8");
  changedFiles += 1;
}

if (CHECK_ONLY) {
  if (offenders.length > 0) {
    console.error("CJK code comments found:");
    for (const offender of offenders) console.error(`  ${offender}`);
    process.exit(1);
  }
  console.log("No CJK code comments found.");
} else {
  console.log(`Removed CJK comments from ${changedFiles} file(s).`);
}
