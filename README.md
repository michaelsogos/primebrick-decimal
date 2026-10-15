# @primebrick/decimal

High-performance **base-10** decimal arithmetic on native `bigint` — the missing ring between JavaScript `Number` and SQL `decimal`/`numeric`.

Exact, deterministic, PostgreSQL-faithful: `add(0.1, 0.2)` is `0.3`, always. No floating-point noise, no dependencies, browser-safe.

```ts
import { dec, add, mul, div, toPG } from "@primebrick/decimal";

const price = dec("19.99");
const total = mul(add(price, "4.50"), 3);   // 73.47
const third = div(1, 3);                    // 0.33333333333333333333 — same digits as PG numeric
```

## Why a custom implementation

| Requirement | `Number` | `decimal.js` | `@naviary/bigdecimal` | `@primebrick/decimal` |
|---|---|---|---|---|
| Base-10 exact (0.1 = 0.1) | ❌ | ✅ | ⚠️ binary fixed-point | ✅ |
| PG `numeric` parity | ❌ | ~ | ❌ | ✅ same scale rules |
| ALU-speed (`bigint` ops) | — | digit-array | ✅ | ✅ scaled bigint |
| API funzionale `add(a,b)` | — | class methods | ✅ | ✅ |
| Zero deps, browser-safe | ✅ | ✅ | ✅ | ✅ |

## Model

`Decimal` is `value = v × 10^-scale` — unscaled `bigint` + `scale` (Java `BigDecimal` semantics, the only representation that round-trips `numeric` exactly). Instances are immutable, frozen value objects.

```ts
dec("0.5")    // v=5n,  scale=1
dec(".5")     // → 0.5   (auto-padded)
dec("1.5e3")  // → 1500  (exponents supported)
dec(0.1)      // → 0.1   (number → shortest round-trip string, no float garbage)
dec(42n)      // → 42    (bigint → scale 0)
```

## Functional API

All ops accept `DecimalInput = Decimal | number | bigint | string` and always return `Decimal`:

- **Arithmetic**: `add sub mul div mod neg abs`
- **Comparison**: `cmp eq strictEq signum min max`
- **Scale**: `round rescale setScale normalize trunc floor ceil`
- **Parsing**: `dec fromPG fromString fromNumber fromBigInt fromWire`
- **Serializing**: `toPG` (`"12.34"` plain) · `toWire`/`toJSON` (`"12.34d"` self-describing) · `toString` · `toNumber` (lossy)
- **Inspection**: `isDecimal isPeriodic pgDivScale`
- **Constants**: `ZERO ONE TEN`

### Division — PostgreSQL-faithful scale

`div(a, b)` without a scale uses PostgreSQL's own `select_div_scale` rule (`max(16 − 4·qweight, scale_a, scale_b)`) — output identical digit-for-digit with `numeric` division on the DB:

| PG | `div()` |
|---|---|
| `1/3` → `0.33333333333333333333` | identical, `periodic: true` |
| `10/4` → `2.5000000000000000` | identical |
| `100/3` → `33.3333333333333333` | identical |

Override when you need a fixed scale: `div(total, 8, 2)` or `div(a, b, { scale: 6, rounding: "HALF_EVEN" })`.

`isPeriodic(d)` tells you the last division truncated a non-terminating expansion (`1/3`); the flag propagates through ops.

### Rounding modes

`UP` · `DOWN` · `CEILING` · `FLOOR` · `HALF_UP` (default, = PG `round()`) · `HALF_DOWN` · `HALF_EVEN`.

## Wire format

`Decimal` serializes to a **string** — never a JSON number — so precision never touches the float parser: `"12.34d"` via `toJSON`/`toWire`, plain `"12.34"` via `toPG`. Schema-aware hydration revives `…d` strings back to `Decimal`.

## Non-finite values

`NaN`, `Infinity` (valid `numeric` values in PG ≥14) **cannot** be represented — `fromPG`/`dec` throw `DecimalError` with `code: "NON_FINITE"`. This is deliberate: a `Decimal` must always be a finite base-10 number.

## Development

```bash
pnpm install
pnpm build        # tsc → dist/
pnpm test         # vitest — 84 battle tests incl. live-PG golden values
pnpm typecheck
```

GitFlow: work on `feature/*` from `develop`; releases via `release/X.Y.Z` → tag `X.Y.Z` → CI publishes to npm (OIDC trusted publishing).
