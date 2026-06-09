#!/usr/bin/env node
/**
 * Integration test for the OpenSandbox provider against a LIVE controller.
 *
 * Exercises the full provider surface (create → execute → exit-code →
 * write/read round-trip → base64 → terminate) end-to-end. No mocks — this
 * requires a reachable OpenSandbox controller.
 *
 * Setup (local kind cluster):
 *   kubectl port-forward -n opensandbox svc/opensandbox-controller 8080:8080
 *
 * Run:
 *   OPENSANDBOX_API_URL=http://localhost:8080 \
 *   OPENSANDBOX_IMAGE=ubuntu:22.04 \
 *   node scripts/test-opensandbox-provider.mjs
 *
 * Exit code 0 = all checks passed, 1 = a check failed.
 */

import assert from "node:assert/strict";
import { OpenSandboxProvider } from "../mcp/sandbox.mjs";

const API_URL = process.env.OPENSANDBOX_API_URL;
const IMAGE   = process.env.OPENSANDBOX_IMAGE || "ubuntu:22.04";
const API_KEY = process.env.OPENSANDBOX_API_KEY;

if (!API_URL) {
  console.error("OPENSANDBOX_API_URL not set. See header for usage.");
  process.exit(1);
}

const p = new OpenSandboxProvider(API_URL, IMAGE, API_KEY);
let id = null;
let passed = 0;

async function step(label, fn) {
  process.stdout.write(`• ${label} ... `);
  await fn();
  console.log("ok");
  passed++;
}

try {
  await step("create", async () => {
    const r = await p.create("qa");
    assert.ok(r.id, "create returned no id");
    assert.match(r.display, /^opensandbox:/);
    id = r.id;
    console.log(`\n    ${r.display}`);
  });

  await step("execute — stdout captured", async () => {
    const out = await p.execute(id, "echo hello-opensandbox");
    assert.match(out, /hello-opensandbox/, `unexpected output: ${out}`);
  });

  await step("execute — stderr captured", async () => {
    const out = await p.execute(id, "echo to-stderr 1>&2");
    assert.match(out, /to-stderr/, `stderr not captured: ${out}`);
  });

  await step("execute — non-zero exit code propagates", async () => {
    const out = await p.execute(id, "exit 42");
    assert.match(out, /\[exit 42\]/, `expected [exit 42], got: ${out}`);
  });

  await step("writeFile + readFile round-trip", async () => {
    const body = "round-trip-ok\nsecond-line";
    await p.writeFile(id, "/tmp/qa.txt", body);
    const back = await p.readFile(id, "/tmp/qa.txt");
    assert.equal(back, body, `round-trip mismatch: ${JSON.stringify(back)}`);
  });

  await step("readBase64 decodes to original bytes", async () => {
    const b64 = await p.readBase64(id, "/tmp/qa.txt");
    const decoded = Buffer.from(b64, "base64").toString("utf-8");
    assert.match(decoded, /round-trip-ok/, `base64 decode mismatch: ${decoded}`);
  });

  await step("execute — reads back written file via cat", async () => {
    const out = await p.execute(id, "cat /tmp/qa.txt");
    assert.match(out, /round-trip-ok/, `cat mismatch: ${out}`);
  });

  await step("terminate", async () => {
    await p.terminate(id);
    id = null;
  });

  console.log(`\n✓ all ${passed} checks passed`);
  process.exit(0);
} catch (e) {
  console.log("FAIL");
  console.error(`\n✗ failed after ${passed} passing checks:\n  ${e.message}`);
  if (id) {
    console.error(`  cleaning up sandbox ${id} ...`);
    await p.terminate(id).catch((err) => console.error(`  cleanup failed: ${err.message}`));
  }
  process.exit(1);
}
