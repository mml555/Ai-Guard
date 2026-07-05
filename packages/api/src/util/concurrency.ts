/**
 * Map `items` through `fn` with at most `limit` calls in flight at once, keeping
 * results in input order.
 *
 * Used for the maintenance delivery sweeps (webhook POSTs, Stripe meter
 * reports): the work is independent and network-bound, so running it fully
 * sequentially lets one slow/hung endpoint stall the whole batch, while an
 * unbounded `Promise.all` could open hundreds of sockets at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
