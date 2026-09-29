import assert from "node:assert/strict";
import { extractOrigin, parseChromePasswordsCsv, parseCsv } from "../src/vault/csv-import";

console.log("▶ Testing Vault CSV Import & RFC 4180 Parser...");

// 1. RFC 4180 CSV Parsing
const simpleCsv = "a,b,c\n1,2,3\n4,5,6";
assert.deepEqual(parseCsv(simpleCsv), [
  ["a", "b", "c"],
  ["1", "2", "3"],
  ["4", "5", "6"],
]);

// Quoted fields with commas and escaped quotes
const complexCsv = 'name,notes,value\n"Google, Inc.","Hello ""World""",123\nSimple,"Line 1\nLine 2",456';
const parsedComplex = parseCsv(complexCsv);
assert.equal(parsedComplex.length, 3);
assert.equal(parsedComplex[1][0], "Google, Inc.");
assert.equal(parsedComplex[1][1], 'Hello "World"');
assert.equal(parsedComplex[1][2], "123");
assert.equal(parsedComplex[2][1], "Line 1\nLine 2");

// CRLF line endings
const crlfCsv = "col1,col2\r\nval1,val2\r\nval3,val4\r\n";
assert.deepEqual(parseCsv(crlfCsv), [
  ["col1", "col2"],
  ["val1", "val2"],
  ["val3", "val4"],
]);

// 2. Origin Extraction
assert.equal(extractOrigin("https://github.com/login?return_to=%2F"), "https://github.com");
assert.equal(extractOrigin("https://console.anthropic.com:8443/settings"), "https://console.anthropic.com:8443");
assert.equal(extractOrigin("http://localhost:3000/dashboard"), "http://localhost:3000");
assert.equal(extractOrigin("github.com/login"), "https://github.com");
assert.equal(extractOrigin(""), undefined);
assert.equal(extractOrigin("http://:::invalid:::"), undefined);

// 3. Chrome Passwords CSV Import
const chromeCsv = `name,url,username,password,note
GitHub,https://github.com/login,alice@example.com,secretPass123,personal account
AWS Console,https://signin.aws.amazon.com/console,bob@corp.com,awsSecret999,"multi
line
note"
Empty Pass,https://empty.org,nobody,,
`;

const imported = parseChromePasswordsCsv(chromeCsv);
assert.equal(imported.length, 2, "Rows with empty passwords should be skipped");
assert.deepEqual(imported[0], {
  name: "GitHub",
  url: "https://github.com/login",
  origin: "https://github.com",
  username: "alice@example.com",
  password: "secretPass123",
  note: "personal account",
});
assert.equal(imported[1].name, "AWS Console");
assert.equal(imported[1].url, "https://signin.aws.amazon.com/console");
assert.equal(imported[1].origin, "https://signin.aws.amazon.com");
assert.equal(imported[1].username, "bob@corp.com");
assert.equal(imported[1].password, "awsSecret999");
assert.equal(imported[1].note, "multi\nline\nnote");

console.log("✔ CSV import & RFC 4180 tests passed!");
