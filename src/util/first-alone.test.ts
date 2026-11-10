import { describe, expect, test } from "bun:test";
import { FirstAlone } from "@/util/first-alone";

// Sends one caller per entry of `opens` through the gate at once; each logs
// when it gets in, then reports its entry after a tick.
async function enterAll(gate: FirstAlone, opens: boolean[]) {
  const log: string[] = [];
  await Promise.all(
    opens.map(async (open, index) => {
      const done = await gate.enter();
      log.push(`in ${index}`);
      await Bun.sleep(1);
      log.push(`done ${index}`);
      done(open);
    }),
  );
  return log;
}

describe("FirstAlone", () => {
  test("holds the others until the first caller opens the gate, then lets them in at once", async () => {
    expect(await enterAll(new FirstAlone(), [true, true, true])).toEqual([
      "in 0",
      "done 0",
      "in 1",
      "in 2",
      "done 1",
      "done 2",
    ]);
  });

  test("passes the turn on, one caller at a time, until one opens the gate", async () => {
    expect(
      await enterAll(new FirstAlone(), [false, false, true, true]),
    ).toEqual([
      "in 0",
      "done 0",
      "in 1",
      "done 1",
      "in 2",
      "done 2",
      "in 3",
      "done 3",
    ]);
  });

  test("lets later callers straight in once it's open", async () => {
    const gate = new FirstAlone();
    await enterAll(gate, [true]);
    expect(await enterAll(gate, [false, false])).toEqual([
      "in 0",
      "in 1",
      "done 0",
      "done 1",
    ]);
  });

  test("ignores a report after the gate is open", async () => {
    const gate = new FirstAlone();
    const done = await gate.enter();
    done(true);
    done(false);
    expect(await enterAll(gate, [false, false])).toEqual([
      "in 0",
      "in 1",
      "done 0",
      "done 1",
    ]);
  });
});
