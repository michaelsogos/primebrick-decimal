/** Errors raised by @primebrick/decimal. */
export class DecimalError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "NON_FINITE"
    | "DIVISION_BY_ZERO"
    | "INVALID_SCALE"
    | "INVALID_ROUNDING";

  constructor(code: DecimalError["code"], message: string) {
    super(message);
    this.name = "DecimalError";
    this.code = code;
  }
}
