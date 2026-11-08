import { describe, expect, test } from "bun:test";
import { mapLimit } from "@/util/map-limit";

describe("mapLimit", () => {
  test("returns results in input order however the calls finish", async () => {
    const results = await mapLimit([30, 10, 20], 3, async (delay, index) => {
      await Bun.sleep(delay);
      return `${index}:${delay}`;
    });

    expect(results).toEqual(["0:30", "1:10", "2:20"]);
  });

  test("never runs more than the limit at once", async () => {
    let running = 0;
    let most = 0;

    await mapLimit([1, 2, 3, 4, 5], 2, async () => {
      running++;
      most = Math.max(most, running);
      await Bun.sleep(5);
      running--;
    });

    expect(most).toBe(2);
  });

  test("handles no items", async () => {
    expect(
      await mapLimit([], 4, async () => {
        return 1;
      }),
    ).toEqual([]);
  });

  test("rejects when a call throws", async () => {
    expect(
      mapLimit([1], 2, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("starts no new calls after one fails", async () => {
    const started: number[] = [];
    const run = mapLimit([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) {
        throw new Error("boom");
      }
      await Bun.sleep(5);
      return item;
    });
    expect(run).rejects.toThrow("boom");
    await Bun.sleep(30);
    expect(started).toEqual([0, 1]);
  });
});
