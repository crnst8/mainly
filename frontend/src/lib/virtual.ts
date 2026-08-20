/** Index of the last item starting at or before `y`. Items are ordered by
 *  `top`, so this is a plain lower-bound search. */
export function firstItemAt<T extends { top: number }>(items: T[], y: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.top <= y) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
