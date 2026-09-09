/** Cron-engine semantics: parsing, Vixie day rules, DST wall-clock keys, next-run scan. */

import test from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, nextRunIso, localMinuteKey } from "../lib/index.js";

const at = (iso) => new Date(iso);

test("valid expressions parse", () => {
  assert.ok(parseCron("* * * * *"));
  assert.ok(parseCron("0 9 * * 1"));
  assert.ok(parseCron("*/15 0 * * *"));
  assert.ok(parseCron("0 9 13 * 5"));
  assert.ok(parseCron("5,15,25 8-18 * * 1-5"));
  assert.ok(parseCron("  0   9  *  * 1  ")); // whitespace-normalized
});

test("invalid expressions parse to null", () => {
  assert.equal(parseCron("* * * *"), null); // 4 fields
  assert.equal(parseCron("* * * * * *"), null); // 6 fields
  assert.equal(parseCron("61 * * * *"), null); // minute out of range
  assert.equal(parseCron("0 24 * * *"), null); // hour out of range
  assert.equal(parseCron("0 0 * 13 *"), null); // month out of range
  assert.equal(parseCron("0 0 0 * *"), null); // dom starts at 1
  assert.equal(parseCron("*/0 * * * *"), null); // zero step
  assert.equal(parseCron("a * * * *"), null); // non-numeric
  assert.equal(parseCron("1-5 * * *"), null);
  assert.equal(parseCron(null), null);
  assert.equal(parseCron(42), null);
});

test("5/10 is rejected loudly (cronie behavior), not silently narrowed", () => {
  // cronie's get_range returns EOF for a step after a bare number; the old
  // engine accepted "5/10" as "minute 5 only" and under-fired silently.
  assert.equal(parseCron("5/10 * * * *"), null);
  assert.equal(parseCron("0 9 5/10 * *"), null);
  assert.equal(parseCron("0 0 1/5 * *"), null);
});

test("steps after * and ranges still work", () => {
  const c = parseCron("*/15 0 * * *");
  const on = at("2026-09-11T00:45:00");
  const off = at("2026-09-11T00:44:00");
  assert.equal(cronMatches(c, on), true);
  assert.equal(cronMatches(c, off), false);

  const r = parseCron("10-30/10 * * * *");
  assert.equal(cronMatches(r, at("2026-09-11T00:10:00")), true);
  assert.equal(cronMatches(r, at("2026-09-11T00:20:00")), true);
  assert.equal(cronMatches(r, at("2026-09-11T00:30:00")), true);
  assert.equal(cronMatches(r, at("2026-09-11T00:25:00")), false);
});

test("dow 7 maps to Sunday", () => {
  const c = parseCron("0 0 * * 7");
  assert.equal(cronMatches(c, at("2026-09-13T00:00:00")), true); // Sunday
  assert.equal(cronMatches(c, at("2026-09-12T00:00:00")), false); // Saturday
});

test("dow wrap 5-0 means Fri..Sun (Vixie hi==0 remap)", () => {
  const c = parseCron("0 12 * * 5-0");
  assert.equal(c.dows, null === c ? null : c.dows);
  assert.deepEqual(c.dows, [0, 5, 6]);
  assert.equal(cronMatches(c, at("2026-09-11T12:00:00")), true); // Friday
  assert.equal(cronMatches(c, at("2026-09-12T12:00:00")), true); // Saturday
  assert.equal(cronMatches(c, at("2026-09-13T12:00:00")), true); // Sunday
  assert.equal(cronMatches(c, at("2026-09-14T12:00:00")), false); // Monday
});

test("dom-OR-dow only when both restricted", () => {
  // Friday the 11th, dom 13 restricted, dow 5 restricted -> dow wins (OR).
  const both = parseCron("0 9 13 * 5");
  assert.equal(cronMatches(both, at("2026-09-11T09:00:00")), true); // Friday
  assert.equal(cronMatches(both, at("2026-09-13T09:00:00")), true); // the 13th (Sunday)
  assert.equal(cronMatches(both, at("2026-09-12T09:00:00")), false); // Sat the 12th
  // dom restricted, dow * -> AND (dom only).
  const domOnly = parseCron("0 9 13 * *");
  assert.equal(cronMatches(domOnly, at("2026-09-13T09:00:00")), true);
  assert.equal(cronMatches(domOnly, at("2026-09-11T09:00:00")), false);
  // dom *, dow restricted -> AND (dow only).
  const dowOnly = parseCron("0 9 * * 5");
  assert.equal(cronMatches(dowOnly, at("2026-09-11T09:00:00")), true);
  assert.equal(cronMatches(dowOnly, at("2026-09-13T09:00:00")), false);
});

test("localMinuteKey: DST fall-back repeats share one key (no double-fire)", () => {
  // America/New_York folds 2026-11-01: local 01:30 EDT and local 01:30 EST
  // are two distinct epoch minutes but one wall-clock minute.
  const before = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const edt = new Date("2026-11-01T05:30:00Z"); // 01:30 EDT (UTC-4)
    const est = new Date("2026-11-01T06:30:00Z"); // 01:30 EST (UTC-5)
    assert.equal(edt.getHours(), 1);
    assert.equal(est.getHours(), 1);
    assert.equal(localMinuteKey(edt), localMinuteKey(est));
    // A different wall-clock minute still differs.
    assert.notEqual(localMinuteKey(edt), localMinuteKey(new Date("2026-11-01T05:31:00Z")));
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test("localMinuteKey is stable across the fold for job guard semantics", () => {
  // Sanity in a non-DST zone: same key for the same wall minute, distinct otherwise.
  const before = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const d = new Date("2026-09-11T10:30:00Z");
    assert.equal(localMinuteKey(d), localMinuteKey(new Date(d.getTime())));
    assert.notEqual(localMinuteKey(d), localMinuteKey(new Date(d.getTime() + 60000)));
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test("nextRunIso scans forward from the next minute", () => {
  const before = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const every = parseCron("* * * * *");
    const from = at("2026-09-11T10:30:27Z");
    assert.equal(nextRunIso(every, from), "2026-09-11T10:31:00.000Z");

    const weekly = parseCron("0 9 * * 1"); // Mondays 09:00
    const friday = at("2026-09-11T10:00:00Z"); // a Friday
    assert.equal(nextRunIso(weekly, friday), "2026-09-14T09:00:00.000Z");
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});
