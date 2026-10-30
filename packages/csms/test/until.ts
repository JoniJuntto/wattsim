/**
 * Poll `cond` with real sleeps until it holds. The only real-time wait tests use: socket I/O is real even though
 * every CSMS and station timer runs on a virtual clock.
 */
export async function until(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const step = 5;
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    if (cond()) return;
    await Bun.sleep(step);
  }
  throw new Error(`until: timed out after ${timeoutMs} ms waiting for ${what}`);
}
