#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pkg from "#package.json";

const main = defineCommand({
  meta: {
    name: "diffcop",
    version: pkg.version,
    description: "Local AI code reviewer",
  },
  subCommands: {
    review: () => {
      return import("@/commands/review").then((m) => {
        return m.default;
      });
    },
  },
});

// runMain catches its own errors and exits non-zero, so there's nothing to await.
void runMain(main);
