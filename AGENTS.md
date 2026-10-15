# AI AGENT INSTRUCTIONS - @primebrick/decimal

## ⚠️ CRITICAL: NEVER COMMIT AUTOMATICALLY

**AI agents MUST NEVER commit changes without explicit user instruction.**
Wait for the user to explicitly say "commit" before running `git commit`.
See [docs/gitflow rules](../primebrick-dal-v3/docs/gitflow.md) — this repo follows the same GitFlow conventions.

## Repository overview

`@primebrick/decimal` is a **zero-dependency leaf library** for exact base-10 decimal arithmetic on native `bigint` (`v × 10^-scale` — Java `BigDecimal` semantics). It is the canonical `numeric`/`decimal` value type across the Primebrick stack: dal-pg hydrates `numeric` columns into `Decimal`, services compute with the functional API, and the FE can import it (pure ESM, browser-safe, no Node APIs).

**It MUST NOT depend on any other Primebrick package** — it is the root of the dependency graph. Do not add runtime dependencies.

## Commands

| Action | Command |
|--------|---------|
| Install | `pnpm install` |
| Build | `pnpm run build` |
| Type check | `pnpm run typecheck` |
| Test | `pnpm test` |

## Conventions

- **Functional API only** — `add(a, b)`, never `a.add(b)`. All ops accept `DecimalInput` (`Decimal | number | bigint | string`) and return `Decimal`.
- **Immutability** — `Decimal` instances are frozen value objects; ops return new instances.
- **PG parity** — `div` default scale follows `select_div_scale` (≥16 significant digits). `HALF_UP` is the default rounding (= PG `round()`).
- **Precision is never lost silently** — no float parsing paths; `NaN`/`Infinity` throw `DecimalError`; truncated divisions set `periodic`.
- **Wire format** — `toJSON()`/`toWire()` emit `"12.34d"` (self-describing string); `toPG()` emits plain `"12.34"`. Never serialize as a JSON number.
- **Docs** — English. Every public API needs TSDoc on the function, not the class.
- **Tests** — battle-test style: extend the matrix tables in `test/decimal.test.ts` when adding behaviours; golden values verified live against PostgreSQL where applicable.

## Adding a new operation

1. Implement in `src/ops.ts` (or a new `src/` module) — pure bigint math, no `Math.pow`/`Number` arithmetic on the value.
2. Export from `src/index.ts`.
3. Add matrix rows / cases in `test/decimal.test.ts` — include negative, zero, scale-mismatched, and boundary cases.
4. Update README API list if public.
