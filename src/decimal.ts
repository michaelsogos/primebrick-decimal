/**
 * `Decimal` — immutable arbitrary-precision base-10 number.
 *
 * Representation: `value = v × 10^-scale` (Java `BigDecimal` semantics:
 * unscaled `bigint` + integer `scale`). This is the only in-memory form that
 * round-trips PostgreSQL `numeric` exactly and keeps `+`, `-`, `*`, `cmp`
 * as pure ALU bigint operations.
 *
 * `Decimal` is a value object: every operation returns a NEW instance.
 * Instances are frozen. Two Decimals may differ in `scale` while being
 * numerically equal (`1.0` vs `1.00`) — use `eq()` for value equality and
 * `strictEq()` when scale must match.
 *
 * `periodic` is a provenance flag: it is `true` when a producing operation
 * (today: `div`) truncated a non-terminating base-10 expansion at the chosen
 * scale. It propagates through arithmetic — a value derived from an
 * approximated input stays flagged.
 */
import { DecimalError } from "./errors.js";

/** Anything coercion functions accept: Decimal, native number, bigint, or a decimal string. */
export type DecimalInput = Decimal | number | bigint | string;

export class Decimal {
  /** Unscaled integer: `value = v × 10^-scale`. */
  readonly v: bigint;
  /** Number of base-10 digits after the decimal point. Always `>= 0`. */
  readonly scale: number;
  /** Provenance flag: the producing operation truncated a non-terminating expansion. */
  readonly periodic: boolean;

  /** Internal constructor — prefer `dec()`, `fromPG()`, `fromNumber()`, `fromBigInt()`. */
  constructor(v: bigint, scale: number, periodic = false) {
    if (!Number.isInteger(scale) || scale < 0) {
      throw new DecimalError("INVALID_SCALE", `Decimal scale must be a non-negative integer, got ${scale}`);
    }
    this.v = v;
    this.scale = scale;
    this.periodic = periodic;
    Object.freeze(this);
  }

  /** Canonical plain decimal string, e.g. `-12.3400` (scale preserved). */
  toString(): string {
    const neg = this.v < 0n;
    const s = (neg ? -this.v : this.v).toString().padStart(this.scale + 1, "0");
    const body = this.scale === 0 ? s : `${s.slice(0, -this.scale)}.${s.slice(-this.scale)}`;
    return neg ? `-${body}` : body;
  }

  /**
   * Wire form for ext-json / JSON.stringify: `"12.34d"` — a self-describing
   * string so the value survives naive `JSON.parse` visibly typed and can be
   * revived by schema-aware hydration (`fromWire`).
   */
  toJSON(): string {
    return `${this.toString()}d`;
  }

  /** Lossy coercion — may round. Use only for display hints, never for math. */
  toNumber(): number {
    return Number(this.toString());
  }
}

// ─── powers of ten (lazy cache — ALU-fast rescales) ──────────────────────────

const POW10: bigint[] = [1n];
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) {
    throw new DecimalError("INVALID_SCALE", `pow10 exponent must be a non-negative integer, got ${n}`);
  }
  while (POW10.length <= n) POW10.push(POW10[POW10.length - 1]! * 10n);
  return POW10[n]!;
}

// ─── parsing ─────────────────────────────────────────────────────────────────

const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse a decimal string into unscaled form.
 * Accepts: `"12"`, `"-0.5"`, `".5"`, `"5."`, `"1.5e3"`, `"1E-3"`, `"+4"`.
 * Rejects: `NaN`, `Infinity`, empty strings, hex, non-numeric garbage.
 * Scale is preserved as written (`"1.230"` → scale 3).
 */
export function parseDecimal(input: string): Decimal {
  const s = input.trim();
  if (/nan|inf/i.test(s)) {
    throw new DecimalError("NON_FINITE", `Decimal cannot represent non-finite value: ${JSON.stringify(input)}`);
  }
  const m = DEC_RE.exec(s);
  if (!m || (!m[2] && !m[3])) {
    throw new DecimalError("INVALID_INPUT", `Not a decimal string: ${JSON.stringify(input)}`);
  }
  const [, sign, int = "", frac = "", expStr] = m;
  let digits = int + frac;
  let scale = frac.length;
  if (expStr !== undefined) {
    const exp = Number(expStr);
    scale -= exp;
    if (scale < 0) {
      digits += "0".repeat(-scale);
      scale = 0;
    }
  }
  if (digits === "") {
    throw new DecimalError("INVALID_INPUT", `Not a decimal string: ${JSON.stringify(input)}`);
  }
  const v = BigInt(digits) * (sign === "-" ? -1n : 1n);
  return new Decimal(v, scale);
}

/** `Decimal` — pass-through. `string` — parsed (PG text form or `"…d"` wire form). `number` — via shortest round-trip `toString` so `0.1` stays `"0.1"`. `bigint` — scale 0. */
export function dec(input: DecimalInput): Decimal {
  if (input instanceof Decimal) return input;
  if (typeof input === "bigint") return new Decimal(input, 0);
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new DecimalError("NON_FINITE", `Decimal cannot represent non-finite number: ${input}`);
    }
    return parseDecimal(input.toString());
  }
  if (typeof input === "string") {
    const s = input.trim();
    return parseDecimal(s.endsWith("d") || s.endsWith("D") ? s.slice(0, -1) : s);
  }
  throw new DecimalError("INVALID_INPUT", `Unsupported Decimal input type: ${typeof input}`);
}

/** Alias of `dec()` — parse a PostgreSQL `numeric`/`decimal` text value. */
export const fromPG = dec;
/** Alias of `dec()` — tolerates the `"…d"` wire suffix. */
export const fromWire = dec;
export const fromString = dec;
export function fromNumber(n: number): Decimal {
  return dec(n);
}
export function fromBigInt(v: bigint, scale = 0): Decimal {
  return new Decimal(v, scale);
}

export function isDecimal(v: unknown): v is Decimal {
  return v instanceof Decimal;
}

/** `true` when the value was produced by a truncated non-terminating division. */
export function isPeriodic(d: DecimalInput): boolean {
  return dec(d).periodic;
}

/** PostgreSQL parameter form — plain canonical decimal string, no `d` suffix. */
export function toPG(d: DecimalInput): string {
  return dec(d).toString();
}

/** Wire form — `"…d"` suffixed string. */
export function toWire(d: DecimalInput): string {
  return dec(d).toJSON();
}
