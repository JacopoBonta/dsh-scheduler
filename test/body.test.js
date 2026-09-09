/** readBody contract: byte cap (413) and invalid JSON (400), via a fake request. */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readBody } from "../lib/index.js";

const MAX_BODY_BYTES = 1_000_000;

function fakeReq(chunks) {
  const req = new EventEmitter();
  setImmediate(() => {
    for (const c of chunks) req.emit("data", Buffer.from(c));
    req.emit("end");
  });
  return req;
}

test("valid JSON body resolves to {value}", async () => {
  const r = await readBody(fakeReq(['{"id":"j1"}']));
  assert.deepEqual(r, { value: { id: "j1" } });
});

test("empty body resolves to {value:{}}", async () => {
  const r = await readBody(fakeReq([]));
  assert.deepEqual(r, { value: {} });
});

test("invalid JSON resolves to {invalid:true} -> 400", async () => {
  const r = await readBody(fakeReq(["not json"]));
  assert.deepEqual(r, { invalid: true });
});

test("oversized body resolves to {tooLarge:true} -> 413, not a hang", async () => {
  const big = "x".repeat(MAX_BODY_BYTES + 1);
  const r = await readBody(fakeReq([big]));
  assert.deepEqual(r, { tooLarge: true });
});

test("custom cap applies", async () => {
  const r = await readBody(fakeReq(["x".repeat(11)]), 10);
  assert.deepEqual(r, { tooLarge: true });
});

test("chunked accumulation stays under the cap for legit bodies", async () => {
  const payload = JSON.stringify({ name: "j", cron: "* * * * *", command: "true" });
  const chunks = [];
  for (let i = 0; i < payload.length; i += 7) chunks.push(payload.slice(i, i + 7));
  const r = await readBody(fakeReq(chunks));
  assert.deepEqual(r.value, JSON.parse(payload));
});
