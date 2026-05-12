/**
 * Minimal concurrency limiter (p-limit shim for Deno).
 *
 * Used to cap the per-line Anthropic matcher calls in extractor.ts.
 * A 50-line PO previously fired 50 concurrent matchers via Promise.all —
 * which both blew Anthropic rate limits and made debugging painful. With
 * pLimit(5) the matchers run 5 at a time; throughput stays high for small
 * POs while large POs queue gracefully.
 */

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function pLimit(concurrency: number): Limiter {
  if (concurrency < 1) throw new Error("concurrency must be >= 1");

  let active = 0;
  const queue: Array<() => void> = [];

  const drain = () => {
    while (active < concurrency && queue.length > 0) {
      const run = queue.shift()!;
      active++;
      run();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          drain();
        });
      });
      drain();
    });
}
