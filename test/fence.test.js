/** Request fence: the Host/Origin checks plugin routes must apply themselves. */

import test from "node:test";
import assert from "node:assert/strict";
import { fenceRequest } from "../lib/index.js";

const req = (headers) => ({ headers });
const loopback = "127.0.0.1";

test("plain curl (no Origin, no Sec-Fetch) passes", () => {
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080" }), loopback, []), true);
  assert.equal(fenceRequest(req({ host: "localhost:3080" }), loopback, []), true);
  assert.equal(fenceRequest(req({ host: "[::1]:3080" }), loopback, []), true); // bracketed IPv6 loopback
});

test("missing or unparseable Host is rejected", () => {
  assert.equal(fenceRequest(req({}), loopback, []), false);
  assert.equal(fenceRequest(req({ host: "not a host" }), loopback, []), false);
});

test("DNS rebinding Host is rejected", () => {
  assert.equal(fenceRequest(req({ host: "evil.com" }), loopback, []), false);
  assert.equal(fenceRequest(req({ host: "evil.com:3080" }), loopback, []), false);
  assert.equal(fenceRequest(req({ host: "127.0.0.1.evil.com" }), loopback, []), false);
});

test("non-loopback Host rejected on loopback bind", () => {
  assert.equal(fenceRequest(req({ host: "192.168.1.10:3080" }), loopback, []), false);
});

test("non-loopback Host accepted when it names this machine on an all-interfaces bind", () => {
  assert.equal(fenceRequest(req({ host: "192.168.1.10:3080" }), "0.0.0.0", ["192.168.1.10"]), true);
  assert.equal(fenceRequest(req({ host: "10.0.0.5" }), "0.0.0.0", ["192.168.1.10"]), false); // not ours
  assert.equal(fenceRequest(req({ host: "192.168.1.10:3080" }), loopback, ["192.168.1.10"]), false); // loopback bind stays strict
});

test("Sec-Fetch-Site: cross-site is rejected (form POST CSRF)", () => {
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" }), loopback, []), false);
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" }), loopback, []), true);
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080", "sec-fetch-site": "none" }), loopback, []), true);
});

test("Origin must match Host; missing Origin passes (curl)", () => {
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }), loopback, []), true);
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080", origin: "http://evil.com" }), loopback, []), false);
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:9999" }), loopback, []), false);
  assert.equal(fenceRequest(req({ host: "127.0.0.1:3080", origin: "null" }), loopback, []), false);
});

test("text/plain CSRF shape: cross-site marker catches it even without Origin", () => {
  // The verified exploit shape: a simple CORS request from any web page.
  assert.equal(
    fenceRequest(req({ host: "127.0.0.1:3080", "content-type": "text/plain", "sec-fetch-site": "cross-site" }), loopback, []),
    false,
  );
});
