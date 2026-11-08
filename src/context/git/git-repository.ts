import { $ } from "bun";
import type { ChangedFile, Repository } from "@/context/repository";

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
  // `-z` keeps paths unquoted; without it git C-quotes non-ASCII and special characters.
  async changedFilesSince(ref: string) {
    const fields = (await this.#run("diff", "--numstat", "-z", ref)).split(
      "\0",
    );
    const files: ChangedFile[] = [];
    let index = 0;
    while (index < fields.length) {
      // Only the first two tabs separate fields; a path can hold more.
      const [additions = "0", deletions = "0", ...pathParts] = (
        fields[index] ?? ""
      ).split("\t");
      const path = pathParts.join("\t");
      index++;
      if (additions === "") {
        continue;
      }
      // A rename leaves the path empty and gives the old and new paths as the next two fields.
      let current = path;
      if (path === "") {
        current = `${fields[index] ?? ""} => ${fields[index + 1] ?? ""}`;
        index += 2;
      }
      files.push({
        path: current,
        additions: Number(additions) || 0,
        deletions: Number(deletions) || 0,
      });
    }
    return files;
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
