/**
 * `Result<T, E>` — the pure functional result monad of the domain layer.
 *
 * Expected, boundary-level failures are modeled as values (`{ ok: false, error }`)
 * instead of thrown exceptions, so no untyped error ever crosses a module or process
 * boundary. This module is dependency-free by design: it imports nothing and may
 * only be imported *into* — never outward (Clean Inward Architecture).
 */

/** Success branch: carries the produced value and never an error. */
export interface Ok<T, E> {
  readonly ok: true;
  readonly value: T;
  /** Present as `undefined` so `result.error` narrows safely after `isOk`. */
  readonly error?: undefined;
}

/** Failure branch: carries the typed error and never a value. */
export interface Err<T, E> {
  readonly ok: false;
  /** Present as `undefined` so `result.value` narrows safely after `isErr`. */
  readonly value?: undefined;
  readonly error: E;
}

/**
 * A value that is either a success (`Ok<T>`) or a typed failure (`Err<E>`).
 * Discriminated by the boolean `ok` field; `isOk`/`isErr` narrow it further.
 */
export type Result<T, E> = Ok<T, E> | Err<T, E>;

/**
 * Wrap a success value into a `Result`.
 *
 * @typeParam T - The success value type.
 * @typeParam E - The error type of the target `Result`; defaults to `never` so the
 *   value assigns to any `Result<T, E>`.
 */
export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

/**
 * Wrap a failure into a `Result`.
 *
 * @typeParam T - The success type of the target `Result`; defaults to `never` so the
 *   value assigns to any `Result<T, E>`.
 * @typeParam E - The error value type, inferred from the argument.
 */
export function err<T = never, E = unknown>(error: E): Result<T, E> {
  return { ok: false, error };
}

/**
 * Type guard: `true` when the result is the success branch.
 *
 * @param result - The result to inspect.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T, E> {
  return result.ok;
}

/**
 * Type guard: `true` when the result is the failure branch.
 *
 * @param result - The result to inspect.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<T, E> {
  return !result.ok;
}

/**
 * Lift a synchronous transform over the success value, leaving failures untouched.
 *
 * @param result - The result to transform.
 * @param fn - Pure function applied to the success value.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Transform the error type/value of a failure, leaving successes untouched.
 * Typical use: re-tagging a low-level error before it crosses a boundary.
 *
 * @param result - The result to transform.
 * @param fn - Pure function applied to the error value.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Chain a fallible continuation onto a result (the monadic bind).
 * A failed input short-circuits: `fn` is never invoked.
 *
 * @param result - The result to chain from.
 * @param fn - Pure function turning the success value into the next result.
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Exhaustively fold a result into a single value of type `R`.
 *
 * @param result - The result to fold.
 * @param onOk - Applied to the value when the result is a success.
 * @param onErr - Applied to the error when the result is a failure.
 */
export function match<T, E, R>(
  result: Result<T, E>,
  onOk: (value: T) => R,
  onErr: (error: E) => R
): R {
  return result.ok ? onOk(result.value) : onErr(result.error);
}

/**
 * Extract the success value, substituting `fallback` on failure.
 * The throwing-free counterpart of `unwrap` — preferred at module boundaries.
 *
 * @param result - The result to unwrap.
 * @param fallback - Value returned when the result is a failure.
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
