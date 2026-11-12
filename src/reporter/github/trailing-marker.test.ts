import { describe, expect, test } from "bun:test";
import { trailingMarker } from "@/reporter/github/trailing-marker";

describe("trailingMarker", () => {
  test("reads a marker from the lines the comment ends with", () => {
    const body =
      "## diffcop review\n\ntext\n<!-- diffcop:ledger=AAAA -->\n<!-- diffcop:saved=BBBB -->";

    expect(trailingMarker(body, "ledger")).toBe("AAAA");
    expect(trailingMarker(body, "saved")).toBe("BBBB");
  });

  test("ignores a marker anywhere above them", () => {
    const body =
      "<!-- diffcop:saved=AAAA -->\ntext\n<!-- diffcop:ledger=BBBB -->";

    expect(trailingMarker(body, "saved")).toBeUndefined();
    expect(trailingMarker(body, "ledger")).toBe("BBBB");
  });

  test("ignores a marker that shares its line with other text", () => {
    expect(
      trailingMarker("text <!-- diffcop:saved=AAAA -->", "saved"),
    ).toBeUndefined();
  });

  test("reads past a trailing newline and CRLF line endings", () => {
    const body = "text\r\n<!-- diffcop:saved=AAAA -->\r\n";

    expect(trailingMarker(body, "saved")).toBe("AAAA");
  });

  test("is undefined for a comment that ends with none", () => {
    expect(trailingMarker("## diffcop review", "saved")).toBeUndefined();
    expect(trailingMarker("", "saved")).toBeUndefined();
  });
});
