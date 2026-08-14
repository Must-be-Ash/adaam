export type DepthLevel = { price: number; size: number };

export function chartNiceTicks(
  values: readonly number[],
  targetIntervals = 4,
): number[] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) return [minimum - 1, minimum, minimum + 1];

  const rawStep = (maximum - minimum) / targetIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const niceMinimum = Math.floor(minimum / step) * step;
  const niceMaximum = Math.ceil(maximum / step) * step;
  const ticks: number[] = [];
  for (let value = niceMinimum; value <= niceMaximum + step / 2; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

export function chartPricePrecision(values: readonly number[]): number {
  const largest = Math.max(...values.map((value) => Math.abs(value)));
  if (largest >= 1) return 2;
  if (largest >= 0.01) return 4;
  return 6;
}

export function inferredChartPricePrefix(
  explicitPrefix: string | undefined,
  heading: string,
): string {
  if (explicitPrefix !== undefined) return explicitPrefix;
  if (/(?:-|\/|\b)USD(?:\b|\))/iu.test(heading)) return "$";
  if (/(?:-|\/|\b)EUR(?:\b|\))/iu.test(heading)) return "€";
  if (/(?:-|\/|\b)GBP(?:\b|\))/iu.test(heading)) return "£";
  if (/(?:-|\/|\b)JPY(?:\b|\))/iu.test(heading)) return "¥";
  return "";
}

export function cumulativeDepthPoints(
  points: readonly DepthLevel[],
  direction: "ascending" | "descending",
): DepthLevel[] {
  const sorted = [...points].sort((left, right) =>
    direction === "ascending"
      ? left.price - right.price
      : right.price - left.price,
  );
  let cumulative = 0;
  return sorted.map((point) => {
    cumulative += point.size;
    return { price: point.price, size: cumulative };
  });
}
