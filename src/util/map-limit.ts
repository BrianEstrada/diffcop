// Like Promise.all over `items.map(fn)`, with at most `limit` calls running at once.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  // Shared by every worker, so each item is taken exactly once.
  const pending = items.entries();
  // Promise.all rejects on the first failure, so the other workers stop taking items.
  let failed = false;
  async function worker() {
    for (const [index, item] of pending) {
      if (failed) {
        return;
      }
      try {
        results[index] = await fn(item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}
