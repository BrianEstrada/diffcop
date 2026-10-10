import { relative, resolve } from "node:path";
import { z } from "zod";

export interface Search {
  pattern: string;
  path?: string;
}

export interface Explored {
  filesRead: string[];
  searches: Search[];
}

// Claude Code's input shapes for its read, glob and grep tools.
const readInput = z.object({ file_path: z.string() });

const searchInput = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

function searchKey({ pattern, path }: Search) {
  return JSON.stringify([pattern, path]);
}

function uniqueSearches(searches: Search[]) {
  const byKey = new Map<string, Search>();
  for (const search of searches) {
    if (!byKey.has(searchKey(search))) {
      byKey.set(searchKey(search), search);
    }
  }
  return [...byKey.values()];
}

export function mergeExplored(a: Explored, b: Explored): Explored {
  return {
    filesRead: [...new Set([...a.filesRead, ...b.filesRead])],
    searches: uniqueSearches([...a.searches, ...b.searches]),
  };
}

// Collects what a run read and searched from its tool calls, in first-seen order.
export class ExplorationLog {
  readonly #cwd: string;
  readonly #filesRead: string[] = [];
  readonly #searches: Search[] = [];

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  record(toolName: string, input: unknown) {
    switch (toolName) {
      case "read": {
        const read = readInput.safeParse(input);
        if (read.success) {
          this.#filesRead.push(this.#relative(read.data.file_path));
        }
        break;
      }
      case "glob":
      case "grep": {
        const search = searchInput.safeParse(input);
        if (search.success) {
          this.#searches.push(this.#search(search.data));
        }
        break;
      }
    }
  }

  explored(): Explored {
    return {
      filesRead: [...new Set(this.#filesRead)],
      searches: uniqueSearches(this.#searches),
    };
  }

  #search({ pattern, path }: Search): Search {
    const relativePath = path === undefined ? "" : this.#relative(path);
    if (!relativePath) {
      return { pattern: pattern };
    }
    return {
      pattern: pattern,
      path: relativePath,
    };
  }

  #relative(path: string) {
    return relative(this.#cwd, resolve(this.#cwd, path));
  }
}
