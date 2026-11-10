import { reviewLedgerSchema } from "@/review/review-ledger";
import type { ReviewLedger } from "@/review/review-ledger";

// The ledger of a local run, which has no PR comment to keep it in.
export class LedgerFile {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  // Undefined for a file that doesn't exist yet: the first round creates it.
  async load(): Promise<ReviewLedger | undefined> {
    const file = Bun.file(this.#path);
    if (!(await file.exists())) {
      return undefined;
    }
    const content: unknown = await file.json().catch(() => {
      return undefined;
    });
    const ledger = reviewLedgerSchema.safeParse(content);
    if (!ledger.success) {
      throw new Error(`${this.#path} isn't a diffcop ledger.`);
    }
    return ledger.data;
  }

  async save(ledger: ReviewLedger) {
    await Bun.write(this.#path, `${JSON.stringify(ledger, null, 2)}\n`);
  }
}
