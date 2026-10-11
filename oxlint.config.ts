import { defineConfig } from "oxlint";
import deslopify from "oxlint-plugin-deslopify";

// noinspection JSUnusedGlobalSymbols
export default defineConfig({
  // Our custom rules plus built-in style and `no-unsafe-*` rules. See
  // https://github.com/BrianEstrada/oxlint-deslopify#what-opinionated-adds
  extends: [deslopify.configs.opinionated],
  // Default rules are all "correctness" rules, which oxlint reports as warnings.
  // Promote them to errors.
  categories: {
    correctness: "error",
  },
  rules: {
    // GitHub's GraphQL responses are `unknown` until a Zod schema parses them.
    "deslopify/no-graphql-cast": "error",
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: String.raw`^\.{1,2}/`,
            message: "Use the `@/` alias instead of a relative import.",
          },
        ],
      },
    ],
  },
  options: {
    // The preset's `no-unsafe-*` and `no-deprecated` rules need type info.
    typeAware: true,
    // Backstop for any rule turned on later as "warn": warnings still fail lint.
    denyWarnings: true,
  },
});
