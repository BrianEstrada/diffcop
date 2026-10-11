import { $ } from "bun";
import type { Repository } from "@/context/repository";

function lines(text: string) {
  return text.split("\n").filter(Boolean);
}

async function git(cwd: string, args: string[]) {
  return (await $`git ${args}`.cwd(cwd).quiet().text()).trim();
}

export class GitRepository implements Repository {
  readonly #cwd: string;
  #root: Promise<string> | undefined;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  // Every command runs from here, no matter where diffcop was started.
  async root() {
    this.#root ??= git(this.#cwd, ["rev-parse", "--show-toplevel"]).catch(
      () => {
        throw new Error(`Not a git repository: ${this.#cwd}`);
      },
    );
    return this.#root;
  }

  async defaultBase() {
    // Resolve the root outside the fallback so "not a git repository" isn't
    // mistaken for a missing origin/HEAD.
    const root = await this.root();
    return git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => {
      return "main";
    });
  }

  async mergeBase(ref: string) {
    return this.#run("merge-base", "HEAD", ref);
  }

  async currentBranch() {
    return this.#run("rev-parse", "--abbrev-ref", "HEAD");
  }

  async commitsSince(ref: string) {
    return lines(await this.#run("log", "--oneline", `${ref}..HEAD`));
  }

  // Covers the working tree, not just commits, so uncommitted edits count.
  async changedFilesSince(ref: string) {
    return lines(await this.#run("diff", "--numstat", ref)).map((line) => {
      const [additions = "0", deletions = "0", path = ""] = line.split("\t");
      return {
        path: path,
        additions: Number(additions) || 0,
        deletions: Number(deletions) || 0,
      };
    });
  }

  async diffSince(ref: string) {
    return this.#run("diff", ref);
  }

  async hashObject(path: string) {
    return this.#run("hash-object", "--", path);
  }

  async #run(...args: string[]) {
    return git(await this.root(), args);
  }
}
