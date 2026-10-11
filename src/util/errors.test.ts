import { describe, expect, test } from "bun:test";
import { toError } from "@/util/errors";

describe("toError", () => {
  test("returns an Error as is", () => {
    const error = new Error("boom");
    expect(toError(error)).toBe(error);
  });

  test("wraps anything else, keeping it as the cause", () => {
    const error = toError("boom");
    expect(error.message).toBe("boom");
    expect(error.cause).toBe("boom");
  });
});
