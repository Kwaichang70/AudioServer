/**
 * Reject when `promise` has not settled within `ms`.
 *
 * Racing a timer only stops the waiting, not the work: the request keeps its
 * socket and the device keeps receiving commands. Pass `onTimeout` (usually
 * an AbortController's abort) to cancel the work itself as well (P06).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
