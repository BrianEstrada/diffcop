// Anything can be thrown, so turn a caught value into an Error once, at the catch.
export function toError(cause: unknown): Error {
  if (cause instanceof Error) {
    return cause;
  }
  return new Error(String(cause), { cause: cause });
}
