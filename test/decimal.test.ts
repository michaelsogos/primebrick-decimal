/**
 * Battle-test matrix for @primebrick/decimal.
 *
 * Adding coverage for a new behaviour = append rows to the tables below or add
 * a focused `it` — every row runs through parse/serialize/ops round-trips.
 */
import { describe, expect, it } from "vitest";
import {
  Decimal, DecimalError, dec, fromPG, fromWire, fromNumber, fromBigInt,
  isDecimal, isPeriodic, toPG, toWire,
  add, sub, mul, div, mod, neg, abs, cmp, eq, strictEq, signum, min, max,
  rescale, normalize, round, trunc, floor, ceil, ZERO, ONE,
} from "../src/index.js";

// ─── parse / serialize matrix ────────────────────────────────────────────────

const PARSE_CASES: Array<[input: string, expectedV: bigint, expectedScale: number, expectedStr: string]> = [
  ["0", 0n, 0, "0"],
  ["42", 42n, 0, "42"],
  ["-42", -42n, 0, "-42"],
  ["+42", 42n, 0, "42"],
  ["0.5", 5n, 1, "0.5"],
  [".5", 5n, 1, "0.5"],
  ["5.", 5n, 0, "5"],
  ["-0.5", -5n, 1, "-0.5"],
  ["-.5", -5n, 1, "-0.5"],
  ["12.3400", 123400n, 4, "12.3400"],
  ["0.10", 10n, 2, "0.10"],
  ["9007199254740993", 9007199254740993n, 0, "9007199254740993"],
  ["1234567890.123456789", 1234567890123456789n, 9, "1234567890.123456789"],
  ["1.5e3", 1500n, 0, "1500"],
  ["1.5E+3", 1500n, 0, "1500"],
  ["1e-3", 1n, 3, "0.001"],
  ["-2.5e-2", -25n, 3, "-0.025"],
  ["000123.4500", 1234500n, 4, "123.4500"],
];

describe("fromPG / parsing", () => {
  it.each(PARSE_CASES)("parses %j", (input, v, scale, str) => {
    const d = fromPG(input);
    expect(d.v).toBe(v);
    expect(d.scale).toBe(scale);
    expect(d.toString()).toBe(str);
    expect(toPG(d)).toBe(str);
  });

  it.each(["NaN", "Infinity", "-Infinity", "abc", "", "  ", "0x10", "1.2.3", "--5", "e5", "1e", ".", "-"])(
    "rejects %j",
    (input) => expect(() => fromPG(input)).toThrow(DecimalError),
  );

  it("rejects non-finite numbers", () => {
    expect(() => dec(Number.NaN)).toThrow(DecimalError);
    expect(() => dec(Infinity)).toThrow(DecimalError);
  });
});

// ─── coercion matrix ─────────────────────────────────────────────────────────

describe("dec() coercion", () => {
  it("passes Decimal through unchanged", () => {
    const d = dec("1.23");
    expect(dec(d)).toBe(d);
  });
  it.each([
    [0.1, "0.1"],
    [0.3, "0.3"],
    [1.5, "1.5"],
    [-12.25, "-12.25"],
    [42, "42"],
    [1e21, "1000000000000000000000"],
  ])("number %s → %s", (n, str) => expect(dec(n).toString()).toBe(str));
  it("bigint → scale 0", () => {
    expect(dec(42n)).toMatchObject({ v: 42n, scale: 0 });
    expect(fromBigInt(12345n, 3).toString()).toBe("12.345");
  });
  it("fromNumber uses shortest round-trip (no float garbage)", () => {
    expect(fromNumber(0.1).toString()).toBe("0.1");
    expect(fromNumber(0.1 + 0.2).toString()).toBe("0.30000000000000004"); // honest: the float itself is imprecise
  });
});

// ─── wire format ─────────────────────────────────────────────────────────────

describe("wire format", () => {
  it('toJSON emits the "…d" self-describing form', () => {
    expect(dec("2.2").toJSON()).toBe("2.2d");
    expect(toWire("0.5")).toBe("0.5d");
    expect(JSON.stringify({ v: dec("12.34") })).toBe('{"v":"12.34d"}');
  });
  it("fromWire accepts both suffixed and plain forms", () => {
    expect(fromWire("2.2d").toString()).toBe("2.2");
    expect(fromWire("2.2").toString()).toBe("2.2");
  });
  it("isDecimal narrows", () => {
    expect(isDecimal(dec(1))).toBe(true);
    expect(isDecimal("1")).toBe(false);
  });
});

// ─── arithmetic matrix ───────────────────────────────────────────────────────

const ADD_CASES: Array<[string, string, string]> = [
  ["0.3", "0.6", "0.9"],
  ["1", "2.05", "3.05"],
  ["-1.5", "1.5", "0.0"],
  ["99999999999999999999", "1", "100000000000000000000"],
  ["0.001", "0.0001", "0.0011"],
];
const SUB_CASES: Array<[string, string, string]> = [
  ["1", "0.9", "0.1"],
  ["0", "0.001", "-0.001"],
  ["2.50", "0.5", "2.00"],
  ["-5", "-5", "0"],
];
const MUL_CASES: Array<[string, string, string]> = [
  ["0.1", "0.1", "0.01"],
  ["1.5", "4", "6.0"],
  ["-2", "3.5", "-7.0"],
  ["99999999999999999999", "99999999999999999999", "9999999999999999999800000000000000000001"],
  ["2.5", "0.4", "1.00"],
];

describe("add/sub/mul — exact, scale-preserving", () => {
  it.each(ADD_CASES)("%s + %s = %s", (a, b, r) => expect(add(a, b).toString()).toBe(r));
  it.each(SUB_CASES)("%s - %s = %s", (a, b, r) => expect(sub(a, b).toString()).toBe(r));
  it.each(MUL_CASES)("%s * %s = %s", (a, b, r) => expect(mul(a, b).toString()).toBe(r));
});

// ─── division ────────────────────────────────────────────────────────────────

describe("div — PG-faithful auto scale, rounding control, periodic flag", () => {
  it("1/3 → 0.33333333333333333333, periodic (PG-verified)", () => {
    const r = div(1, 3);
    expect(r.toString()).toBe("0.33333333333333333333");
    expect(isPeriodic(r)).toBe(true);
  });
  it("10/4 → 2.5000000000000000, scale 16 (PG-verified)", () => {
    expect(div(10, 4).toString()).toBe("2.5000000000000000");
    expect(isPeriodic(div(10, 4))).toBe(false);
  });
  it("1.00/8 → 0.12500000000000000000, scale 20 (PG-verified)", () => {
    expect(div("1.00", 8).toString()).toBe("0.12500000000000000000");
  });
  it("explicit scale", () => {
    expect(div(1, 3, 2).toString()).toBe("0.33");
    expect(div(1, 3, { scale: 6 }).toString()).toBe("0.333333");
    expect(div(7, 2, 0).toString()).toBe("4"); // 3.5 HALF_UP → 4
    expect(div(-7, 2, 0).toString()).toBe("-4");
  });
  it("rounding modes", () => {
    expect(div(5, 2, { scale: 0, rounding: "HALF_EVEN" }).toString()).toBe("2"); // 2.5 → 2
    expect(div(3, 2, { scale: 0, rounding: "HALF_EVEN" }).toString()).toBe("2"); // 1.5 → 2
    expect(div(5, 2, { scale: 0, rounding: "HALF_DOWN" }).toString()).toBe("2"); // 2.5 → 2
    expect(div(7, 2, { scale: 0, rounding: "DOWN" }).toString()).toBe("3");
    expect(div(-7, 2, { scale: 0, rounding: "DOWN" }).toString()).toBe("-3");
    expect(div(-7, 2, { scale: 0, rounding: "UP" }).toString()).toBe("-4");
    expect(div(-7, 2, { scale: 0, rounding: "FLOOR" }).toString()).toBe("-4");
    expect(div(-7, 2, { scale: 0, rounding: "CEILING" }).toString()).toBe("-3");
  });
  it("division by zero throws", () => {
    expect(() => div(1, 0)).toThrow(DecimalError);
    expect(() => mod(1, 0)).toThrow(DecimalError);
  });
  it("periodic propagates through ops", () => {
    const third = div(1, 3);
    expect(isPeriodic(add(third, ONE))).toBe(true);
    expect(isPeriodic(mul(third, ZERO))).toBe(true);
    expect(isPeriodic(add(ONE, ONE))).toBe(false);
  });
});

describe("mod", () => {
  it.each([
    ["10", "3", "1"],
    ["10.5", "3", "1.5"],
    ["-10", "3", "-1"],
    ["7.5", "2.5", "0.0"],
  ])("%s mod %s = %s", (a, b, r) => expect(mod(a, b).toString()).toBe(r));
});

// ─── comparison / equality ───────────────────────────────────────────────────

describe("cmp/eq/strictEq", () => {
  it("scale-blind value equality", () => {
    expect(eq("1.0", "1.00")).toBe(true);
    expect(cmp("1.0", "1.00")).toBe(0);
    expect(strictEq("1.0", "1.00")).toBe(false);
  });
  it("ordering", () => {
    expect(cmp("-1", "0")).toBe(-1);
    expect(cmp("0.1", "0.09")).toBe(1);
    expect(cmp("5", "5")).toBe(0);
    expect(signum("-0.5")).toBe(-1);
    expect(signum("0")).toBe(0);
    expect(signum("42")).toBe(1);
  });
  it("min/max", () => {
    expect(min("1.5", 2).toString()).toBe("1.5");
    expect(max("1.5", 2).toString()).toBe("2");
  });
});

// ─── rescale / round / int parts ─────────────────────────────────────────────

describe("scale ops", () => {
  it("rescale up is exact", () => {
    expect(rescale("1.5", 4).toString()).toBe("1.5000");
  });
  it("rescale down rounds per mode", () => {
    expect(rescale("2.5", 0, "HALF_UP").toString()).toBe("3");
    expect(rescale("2.5", 0, "HALF_EVEN").toString()).toBe("2");
    expect(rescale("2.5", 0, "DOWN").toString()).toBe("2");
    expect(rescale("-2.5", 0, "FLOOR").toString()).toBe("-3");
    expect(rescale("-2.5", 0, "CEILING").toString()).toBe("-2");
  });
  it("normalize strips trailing zeros", () => {
    expect(normalize("1.230").toString()).toBe("1.23");
    expect(normalize("12.000").toString()).toBe("12");
    expect(normalize("0.00").toString()).toBe("0");
  });
  it("round/trunc/floor/ceil", () => {
    expect(round("2.567", 2).toString()).toBe("2.57");
    expect(round("2.564", 2).toString()).toBe("2.56");
    expect(trunc("2.9").toString()).toBe("2");
    expect(trunc("-2.9").toString()).toBe("-2");
    expect(floor("2.1").toString()).toBe("2");
    expect(floor("-2.1").toString()).toBe("-3");
    expect(ceil("2.1").toString()).toBe("3");
    expect(ceil("-2.1").toString()).toBe("-2");
  });
  it("neg/abs", () => {
    expect(neg("1.5").toString()).toBe("-1.5");
    expect(neg("-1.5").toString()).toBe("1.5");
    expect(abs("-1.5").toString()).toBe("1.5");
  });
});

// ─── PG numeric parity — the contract that matters ───────────────────────────

describe("PostgreSQL numeric parity", () => {
  // Golden values verified live against PostgreSQL `numeric` division.
  const PG_DIV_CASES: Array<[a: string, b: string, expected: string]> = [
    ["1", "3", "0.33333333333333333333"],
    ["10", "4", "2.5000000000000000"],
    ["1.00", "8", "0.12500000000000000000"],
    ["2", "1", "2.0000000000000000"],
    ["1", "7", "0.14285714285714285714"],
    ["100", "3", "33.3333333333333333"],
  ];
  it.each(PG_DIV_CASES)("div(%s, %s) = %s — identical to PG", (a, b, expected) => {
    expect(div(a, b).toString()).toBe(expected);
  });
  it("toPG output re-parses identically (round-trip)", () => {
    for (const s of ["1234567890.123456789", "-0.00000000000000001", "9007199254740993"]) {
      const d = fromPG(s);
      expect(fromPG(toPG(d)).toString()).toBe(d.toString());
    }
  });
});
