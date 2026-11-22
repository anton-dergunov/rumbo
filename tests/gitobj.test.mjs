import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { blobSha, base64ToBytes, bytesToBase64, bytesToText, toBytes } from "../app/gitobj.js";

const root = new URL("..", import.meta.url).pathname;

test("blobSha matches git hash-object", async () => {
  // Values from `git hash-object --stdin`.
  assert.equal(await blobSha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(await blobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
  // UTF-8 counts bytes, not characters; no final newline.
  assert.equal(await blobSha("* TODO Café — naïve\nno newline"), "a0f59a212f1a12d75f0faf59aeb43f6b64bbe6b6");
});

test("blobSha agrees with git on every sample-vault file", async () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const files = walk(join(root, "prototype/sample-vault"));
  const expected = execFileSync("git", ["hash-object", ...files], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const [i, f] of files.entries()) assert.equal(await blobSha(readFileSync(f)), expected[i], f);
});

test("base64 round trip, with the line breaks GitHub puts in blob content", () => {
  const bytes = toBytes("* Heading\nbody — ünïcode\n".repeat(200));
  const b64 = bytesToBase64(bytes);
  const wrapped = b64.replace(/(.{60})/g, "$1\n");
  assert.deepEqual(base64ToBytes(wrapped), bytes);
  assert.equal(bytesToText(base64ToBytes(wrapped)), "* Heading\nbody — ünïcode\n".repeat(200));
});

test("bytesToText refuses invalid UTF-8 instead of mangling it", () => {
  assert.throws(() => bytesToText(new Uint8Array([0x66, 0xff, 0x6f])));
});
