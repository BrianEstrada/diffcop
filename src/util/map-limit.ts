// Like Promise.all over `items.map(fn)`, with at most `limit` calls running at once.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  // Shared by every worker, so each item is taken exactly once.
  const pending = items.entries();
  async function worker() {
    for (const [index, item] of pending) {
      results[index] = await fn(item, index);
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}
