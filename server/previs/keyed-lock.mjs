// One promise chain per key: work on the same request id stays ordered, different ids run concurrently.
// Replaces one global chain, where a slow Cloud download for one job delayed every other job's submit.
export function keyedLock() {
  const tails = new Map();
  const lock = (key, fn) => {
    const next = (tails.get(key) || Promise.resolve()).then(fn), tail = next.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return next;
  };
  lock.size = () => tails.size;
  return lock;
}
