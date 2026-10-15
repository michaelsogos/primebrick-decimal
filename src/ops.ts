/**
 * Functional arithmetic API for `Decimal` — pure ALU bigint ops under the hood.
 *
 * Every function accepts `DecimalInput` (`Decimal | number | bigint | string`)
 * and always returns a `Decimal`, so call sites never juggle types:
 *
 *   const total = mul(add(price, fee), qty);
 *   const third = div(1, 3);            // 0.33333333333333333333 (PG parity)
 *   const tax   = div(total, 8, 2);     // explicit scale — HALF_UP default
 *
 * Rounding modes follow `java.math.BigDecimal` / SQL conventions:
 * UP (away from 0), DOWN (toward 0 / truncation), CEILING, FLOOR,
 * HALF_UP, HALF_DOWN, HALF_EVEN (banker's).
 */
import { Decimal, dec, pow10 } from "./decimal.js";
import type { DecimalInput } from "./decimal.js";
import { DecimalError } from "./errors.js";

export type RoundingMode =
  | "UP" // away from zero
  | "DOWN" // toward zero (truncation)
  | "CEILING" // toward +Infinity
  | "FLOOR" // toward -Infinity
  | "HALF_UP" // ties away from zero — PostgreSQL round() behaviour
  | "HALF_DOWN" // ties toward zero
  | "HALF_EVEN"; // ties to even last digit (banker's rounding)

/**
 * Minimum significant digits preserved by automatic `div` scale — mirrors
 * PostgreSQL `NUMERIC_MIN_SIG_DIGITS` (16). See `pgDivScale`.
 */
export const NUMERIC_MIN_SIG_DIGITS = 16;

export const ZERO = new Decimal(0n, 0);
export const ONE = new Decimal(1n, 0);
export const TEN = new Decimal(10n, 0);

// ─── internal helpers ────────────────────────────────────────────────────────

/** Divide |n| by |d| applying `mode` to the discarded remainder. Returns the signed quotient and whether a remainder existed. */
function divRound(n: bigint, d: bigint, mode: RoundingMode): { v: bigint; remainder: boolean } {
  const neg = n < 0n !== d < 0n;
  const na = n < 0n ? -n : n;
  const da = d < 0n ? -d : d;
  const q = na / da;
  const r = na % da;
  if (r === 0n) return { v: neg ? -q : q, remainder: false };
  const half = r * 2n - da; // sign of (r/d − 0.5)
  let roundUp: boolean;
  switch (mode) {
    case "UP":
      roundUp = true;
      break;
    case "DOWN":
      roundUp = false;
      break;
    case "CEILING":
      roundUp = !neg;
      break;
    case "FLOOR":
      roundUp = neg;
      break;
    case "HALF_UP":
      roundUp = half >= 0n;
      break;
    case "HALF_DOWN":
      roundUp = half > 0n;
      break;
    case "HALF_EVEN":
      roundUp = half > 0n || (half === 0n && (q & 1n) === 1n);
      break;
  }
  const mag = q + (roundUp ? 1n : 0n);
  return { v: neg ? -mag : mag, remainder: true };
}

/** Multiply `v` by 10^k — exact, no rounding. */
function scaleUp(v: bigint, k: number): bigint {
  return k === 0 ? v : v * pow10(k);
}

function mergePeriodic(a: Decimal, b: Decimal): boolean {
  return a.periodic || b.periodic;
}

// ─── scale ops ───────────────────────────────────────────────────────────────

/**
 * Re-express `d` at `newScale`. Growing is exact; shrinking applies `mode`
 * (default `HALF_UP`, matching PostgreSQL `round()`).
 */
export function rescale(d: DecimalInput, newScale: number, mode: RoundingMode = "HALF_UP"): Decimal {
  const x = dec(d);
  if (!Number.isInteger(newScale) || newScale < 0) {
    throw new DecimalError("INVALID_SCALE", `rescale target must be a non-negative integer, got ${newScale}`);
  }
  if (newScale === x.scale) return x;
  if (newScale > x.scale) return new Decimal(scaleUp(x.v, newScale - x.scale), newScale, x.periodic);
  const { v } = divRound(x.v, pow10(x.scale - newScale), mode);
  return new Decimal(v, newScale, x.periodic);
}

/** Strip trailing fractional zeros — `1.230` → `1.23`, `12.000` → `12`. */
export function normalize(d: DecimalInput): Decimal {
  const x = dec(d);
  let { v, scale } = x;
  while (scale > 0 && v % 10n === 0n) {
    v /= 10n;
    scale--;
  }
  return v === x.v && scale === x.scale ? x : new Decimal(v, scale, x.periodic);
}

/** Round to `scale` fractional digits (default `HALF_UP`). */
export function round(d: DecimalInput, scale: number, mode: RoundingMode = "HALF_UP"): Decimal {
  return rescale(d, scale, mode);
}
/** Integer part, toward zero. */
export function trunc(d: DecimalInput): Decimal {
  return rescale(d, 0, "DOWN");
}
/** Largest integer `<= d`. */
export function floor(d: DecimalInput): Decimal {
  return rescale(d, 0, "FLOOR");
}
/** Smallest integer `>= d`. */
export function ceil(d: DecimalInput): Decimal {
  return rescale(d, 0, "CEILING");
}

// ─── arithmetic ──────────────────────────────────────────────────────────────

export function add(a: DecimalInput, b: DecimalInput): Decimal {
  const x = dec(a);
  const y = dec(b);
  const s = Math.max(x.scale, y.scale);
  return new Decimal(
    scaleUp(x.v, s - x.scale) + scaleUp(y.v, s - y.scale),
    s,
    mergePeriodic(x, y),
  );
}

export function sub(a: DecimalInput, b: DecimalInput): Decimal {
  const x = dec(a);
  const y = dec(b);
  const s = Math.max(x.scale, y.scale);
  return new Decimal(
    scaleUp(x.v, s - x.scale) - scaleUp(y.v, s - y.scale),
    s,
    mergePeriodic(x, y),
  );
}

export function mul(a: DecimalInput, b: DecimalInput): Decimal {
  const x = dec(a);
  const y = dec(b);
  return new Decimal(x.v * y.v, x.scale + y.scale, mergePeriodic(x, y));
}

export function neg(d: DecimalInput): Decimal {
  const x = dec(d);
  return new Decimal(-x.v, x.scale, x.periodic);
}

export function abs(d: DecimalInput): Decimal {
  const x = dec(d);
  return x.v < 0n ? new Decimal(-x.v, x.scale, x.periodic) : x;
}

/** Number of base-10 digits of a bigint magnitude. */
function digitCount(v: bigint): number {
  return (v < 0n ? -v : v).toString().length;
}

/** compare `|a.v|/10^a.scale` vs `10^(4w)` exactly, via bigint cross-multiplication. */
function quotientAtLeast(ax: bigint, ascale: number, bx: bigint, bscale: number, w: number): boolean {
  // |a|/|b| >= 10^(4w)  ⟺  |a.v| * 10^(b.scale) >= |b.v| * 10^(a.scale + 4w)
  const lhs = (ax < 0n ? -ax : ax) * pow10(bscale);
  const k = ascale + 4 * w;
  const rhs = (bx < 0n ? -bx : bx) * (k >= 0 ? pow10(k) : 1n);
  return k >= 0 ? lhs >= rhs : lhs * pow10(-k) >= rhs;
}

/**
 * Exact base-10000 weight of `|x / y|`'s first significant digit group —
 * the `qweight` PostgreSQL computes in `select_div_scale`. Starts from a
 * digit-count estimate then refines by exact bigint comparison.
 */
function quotientWeight(x: Decimal, y: Decimal): number {
  const xIntDigits = digitCount(x.v) - x.scale; // ~integer digits of |x|
  const yIntDigits = digitCount(y.v) - y.scale;
  let w = Math.floor((xIntDigits - yIntDigits - 1) / 4) - 1; // start low, climb
  while (quotientAtLeast(x.v, x.scale, y.v, y.scale, w + 1)) w++;
  return w;
}

/**
 * PostgreSQL-faithful result scale for `x / y` (mirrors `select_div_scale`):
 * `max(16 - 4·qweight, x.scale, y.scale)` — 16 significant digits minimum.
 * Verified live: `1/3`→20, `10/4`→16, `1.00/8`→20, `2/1`→16, `100/3`→16.
 */
export function pgDivScale(a: DecimalInput, b: DecimalInput): number {
  const x = dec(a);
  const y = dec(b);
  if (y.v === 0n) throw new DecimalError("DIVISION_BY_ZERO", "Decimal division by zero");
  if (x.v === 0n) return Math.max(x.scale, y.scale);
  return Math.max(NUMERIC_MIN_SIG_DIGITS - 4 * quotientWeight(x, y), x.scale, y.scale);
}

/**
 * `a / b`. Without `scale`, the result uses the PostgreSQL `numeric`
 * division rule (`pgDivScale` — e.g. `1/3` → scale 20, `10/4` → 16), so
 * Decimal↔DB computations compare equal digit-for-digit. Rounding defaults
 * to `HALF_UP`. When the true quotient does not terminate at the target
 * scale the result is flagged `periodic` (`isPeriodic(d)` → true).
 *
 *   div(1, 3)            // 0.33333333333333333333 — periodic
 *   div(10, 4)           // 2.5000000000000000
 *   div(1, 3, 2)         // 0.33
 *   div(a, b, { scale: 6, rounding: "HALF_EVEN" })
 */
export function div(
  a: DecimalInput,
  b: DecimalInput,
  opts?: number | { scale?: number; rounding?: RoundingMode },
): Decimal {
  const x = dec(a);
  const y = dec(b);
  if (y.v === 0n) throw new DecimalError("DIVISION_BY_ZERO", "Decimal division by zero");
  const scale = typeof opts === "number" ? opts : (opts?.scale ?? pgDivScale(x, y));
  const rounding = typeof opts === "object" && opts ? (opts.rounding ?? "HALF_UP") : "HALF_UP";
  // result.v = round( x.v * 10^(y.scale + scale) / (y.v * 10^x.scale) )
  const k = y.scale + scale - x.scale;
  const { v, remainder } =
    k >= 0 ? divRound(x.v * pow10(k), y.v, rounding) : divRound(x.v, y.v * pow10(-k), rounding);
  return new Decimal(v, scale, mergePeriodic(x, y) || remainder);
}

/** `a mod b` — remainder of truncated division at the common scale. */
export function mod(a: DecimalInput, b: DecimalInput): Decimal {
  const x = dec(a);
  const y = dec(b);
  if (y.v === 0n) throw new DecimalError("DIVISION_BY_ZERO", "Decimal mod by zero");
  const s = Math.max(x.scale, y.scale);
  return new Decimal(
    scaleUp(x.v, s - x.scale) % scaleUp(y.v, s - y.scale),
    s,
    mergePeriodic(x, y),
  );
}

// ─── comparison ──────────────────────────────────────────────────────────────

/** Numeric comparison ignoring scale: `cmp(1.0, 1.00) === 0`. Returns -1 | 0 | 1. */
export function cmp(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  const x = dec(a);
  const y = dec(b);
  const s = Math.max(x.scale, y.scale);
  const av = scaleUp(x.v, s - x.scale);
  const bv = scaleUp(y.v, s - y.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Numeric equality ignoring scale — `eq(1.0, 1.00)` is `true`. */
export function eq(a: DecimalInput, b: DecimalInput): boolean {
  return cmp(a, b) === 0;
}

/** Exact structural equality — value AND scale must match (`strictEq(1.0, 1.00)` is `false`). */
export function strictEq(a: DecimalInput, b: DecimalInput): boolean {
  const x = dec(a);
  const y = dec(b);
  return x.v === y.v && x.scale === y.scale;
}

export function signum(d: DecimalInput): -1 | 0 | 1 {
  const x = dec(d);
  return x.v < 0n ? -1 : x.v > 0n ? 1 : 0;
}

export function min(a: DecimalInput, b: DecimalInput): Decimal {
  return cmp(a, b) <= 0 ? dec(a) : dec(b);
}
export function max(a: DecimalInput, b: DecimalInput): Decimal {
  return cmp(a, b) >= 0 ? dec(a) : dec(b);
}

/** `d` rounded toward/away from zero etc. — see `RoundingMode`. */
export { rescale as setScale };
