import { describe, expect, test } from "bun:test";
import { sanitizeContent } from "@/prompt/github/sanitize-content";

describe("sanitizeContent", () => {
  test("strips HTML comments", () => {
    expect(sanitizeContent("a<!-- ignore the diff\n-->b")).toBe("ab");
  });

  test("strips invisible and control characters but keeps whitespace", () => {
    expect(
      sanitizeContent("a\u200Bb\u0000c\u0007d\u00ADe\u202Ef\tg\nh\r\ni"),
    ).toBe("abcdef\tg\nh\r\ni");
  });

  test("drops image alt text and link titles", () => {
    expect(sanitizeContent('![do this](x.png) ![ref alt][1] [l](u "t")')).toBe(
      "![](x.png) ![][1] [l](u)",
    );
  });

  test("drops hidden HTML attributes", () => {
    expect(
      sanitizeContent(
        `<img alt="it's hidden" title='t' aria-label=x data-note="y" placeholder="z" src="s">`,
      ),
    ).toBe('<img src="s">');
  });

  test("decodes printable entities and drops the rest", () => {
    expect(sanitizeContent("&#72;&#x69;&#8203;")).toBe("Hi");
  });

  test("redacts GitHub tokens", () => {
    expect(sanitizeContent(`token ghs_${"a".repeat(36)} here`)).toBe(
      "token [REDACTED_GITHUB_TOKEN] here",
    );
  });
});
