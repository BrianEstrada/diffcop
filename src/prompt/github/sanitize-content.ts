// Port of claude-code-action's sanitizeContent (src/github/utils/sanitizer.ts at
// ed670b4). It strips the places a PR author can hide instructions from readers.

const GITHUB_TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9]{36}\b/g,
  /gho_[A-Za-z0-9]{36}\b/g,
  /ghu_[A-Za-z0-9]{36}\b/g,
  /ghs_[A-Za-z0-9]{36}\b/g,
  /ghr_[A-Za-z0-9]{36}\b/g,
  /github_pat_[A-Za-z0-9_]{11,221}\b/g,
];

// Matched per quote type, so an apostrophe inside a double-quoted value doesn't
// end the match early.
const HIDDEN_ATTRIBUTES = [
  "alt",
  "title",
  "aria-label",
  "data-[a-zA-Z0-9-]+",
  "placeholder",
].flatMap((name) => {
  return [
    new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`, "gi"),
    new RegExp(`\\s${name}\\s*=\\s*'[^']*'`, "gi"),
    new RegExp(`\\s${name}\\s*=\\s*[^\\s>]+`, "gi"),
  ];
});

function stripHtmlComments(content: string) {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

// Control characters, except the whitespace that shapes the text.
function stripControl(char: string) {
  if (char === "\t" || char === "\n" || char === "\r") {
    return char;
  }
  return "";
}

function stripInvisibleCharacters(content: string) {
  return content
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/\p{Cc}/gu, stripControl)
    .replace(/\u00AD/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}

function stripMarkdownImageAltText(content: string) {
  return content
    .replace(/!\[[^\]]*\]\(/g, "![](")
    .replace(/!\[[^\]]*\](\[[^\]]*\])/g, "![]$1");
}

function stripMarkdownLinkTitles(content: string) {
  return content
    .replace(/(\[[^\]]*\]\([^)]+)\s+"[^"]*"/g, "$1")
    .replace(/(\[[^\]]*\]\([^)]+)\s+'[^']*'/g, "$1");
}

function stripHiddenAttributes(content: string) {
  let stripped = content;
  for (const pattern of HIDDEN_ATTRIBUTES) {
    stripped = stripped.replace(pattern, "");
  }
  return stripped;
}

// Printable ASCII entities are decoded so they can't spell out hidden text;
// everything else is dropped.
function decodePrintable(code: number) {
  if (code >= 32 && code <= 126) {
    return String.fromCharCode(code);
  }
  return "";
}

function normalizeHtmlEntities(content: string) {
  return content
    .replace(/&#(\d+);/g, (_, dec: string) => {
      return decodePrintable(Number.parseInt(dec, 10));
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      return decodePrintable(Number.parseInt(hex, 16));
    });
}

function redactGitHubTokens(content: string) {
  let redacted = content;
  for (const pattern of GITHUB_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_GITHUB_TOKEN]");
  }
  return redacted;
}

export function sanitizeContent(content: string) {
  return [
    stripHtmlComments,
    stripInvisibleCharacters,
    stripMarkdownImageAltText,
    stripMarkdownLinkTitles,
    stripHiddenAttributes,
    normalizeHtmlEntities,
    redactGitHubTokens,
  ].reduce((text, step) => {
    return step(text);
  }, content);
}
