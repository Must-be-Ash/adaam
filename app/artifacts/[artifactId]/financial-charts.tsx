"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { ReportBlock } from "@/agent/lib/artifact-schema";

import styles from "./artifact.module.css";
import {
  chartNiceTicks,
  chartPricePrecision,
  cumulativeDepthPoints,
  inferredChartPricePrefix,
  type DepthLevel,
} from "./chart-display";

type BlockOf<T extends ReportBlock["type"]> = Extract<
  ReportBlock,
  { type: T }
>;
type BarBlock = BlockOf<"bar-chart">;
type CandlestickBlock = BlockOf<"candlestick-chart">;
type DepthBlock = BlockOf<"depth-chart">;
type PlottedDepthPoint = DepthLevel & {
  side: "ask" | "bid";
  x: number;
  y: number;
};

const RISING_COLOR = "#6ee7d2";
const FALLING_COLOR = "#ff7e79";
const BAR_COLORS = {
  info: "#94a3ff",
  negative: FALLING_COLOR,
  neutral: "#9aa1a1",
  positive: RISING_COLOR,
  warning: "#f9c74f",
} as const;
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function paddedRange(
  values: readonly number[],
  ratio = 0.06,
): { maximum: number; minimum: number } {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const padding = span * ratio || Math.abs(maximum) * 0.01 || 1;
  return { maximum: maximum + padding, minimum: minimum - padding };
}

function numberLabel(
  value: number,
  options: {
    readonly compact?: boolean;
    readonly fixed?: boolean;
    readonly precision?: number;
    readonly prefix?: string;
    readonly suffix?: string;
  } = {},
): string {
  const precision = options.precision ?? 2;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: options.compact ? 2 : precision,
    minimumFractionDigits:
      options.compact || options.fixed === false ? 0 : precision,
    notation: options.compact ? "compact" : "standard",
  }).format(value);
  return `${options.prefix ?? ""}${formatted}${options.suffix ?? ""}`;
}

function shortDateLabel(label: string): string {
  const match = label.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) return label.length > 12 ? `${label.slice(0, 11)}…` : label;
  const [, year, month, day] = match;
  return DATE_FORMAT.format(
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
  );
}

function labelIndexes(length: number, width: number): number[] {
  const count = width < 520 ? 3 : 5;
  return [
    ...new Set(
      Array.from({ length: Math.min(count, length) }, (_, index) =>
        Math.round((index / Math.max(1, Math.min(count, length) - 1)) * (length - 1)),
      ),
    ),
  ];
}

function useChartWidth() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const update = () =>
      setWidth(Math.max(280, Math.floor(element.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [containerRef, width] as const;
}

function candleIndexAtPointer(
  event: ReactPointerEvent<SVGSVGElement>,
  input: {
    readonly count: number;
    readonly plotLeft: number;
    readonly plotRight: number;
    readonly width: number;
  },
): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  const localX =
    ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * input.width;
  const ratio =
    (clamp(localX, input.plotLeft, input.plotRight) - input.plotLeft) /
    Math.max(1, input.plotRight - input.plotLeft);
  return clamp(Math.floor(ratio * input.count), 0, input.count - 1);
}

export function CandlestickFinancialChart({
  block,
}: {
  readonly block: CandlestickBlock;
}) {
  const candles = block.candles.slice(-90);
  const [containerRef, width] = useChartWidth();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const height = width < 520 ? 340 : 380;
  const margin = { bottom: 34, left: 10, right: 76, top: 22 };
  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const plotHeight = plotBottom - plotTop;
  const plotWidth = plotRight - plotLeft;
  const values = candles.flatMap((candle) => [candle.low, candle.high]);
  const ticks = chartNiceTicks(values);
  const range = { maximum: ticks.at(-1)!, minimum: ticks[0]! };
  const precision = chartPricePrecision(values);
  const pricePrefix = inferredChartPricePrefix(block.valuePrefix, block.heading);
  const xStep = plotWidth / candles.length;
  const candleWidth = clamp(xStep * 0.58, 2.5, 10);
  const x = (index: number) => plotLeft + xStep * index + xStep / 2;
  const y = (value: number) =>
    plotTop +
    ((range.maximum - value) / (range.maximum - range.minimum)) * plotHeight;
  const activeIndex = hoveredIndex ?? candles.length - 1;
  const active = candles[activeIndex]!;
  const activeColor =
    active.close >= active.open ? RISING_COLOR : FALLING_COLOR;
  const change =
    active.open === 0 ? 0 : ((active.close - active.open) / active.open) * 100;
  const last = candles.at(-1)!;
  const lastColor = last.close >= last.open ? RISING_COLOR : FALLING_COLOR;
  const lastY = y(last.close);
  const lastLabelY = clamp(lastY, plotTop + 11, plotBottom - 11);

  const moveSelection = (
    event: ReactKeyboardEvent<SVGSVGElement>,
    direction: -1 | 1,
  ) => {
    event.preventDefault();
    setHoveredIndex((current) =>
      clamp((current ?? candles.length - 1) + direction, 0, candles.length - 1),
    );
  };

  return (
    <div className={styles.traderChart} ref={containerRef}>
      <div className={styles.chartReadout}>
        <strong>{shortDateLabel(active.label)}</strong>
        <div className={styles.chartReadoutValues}>
          {[
            ["O", active.open],
            ["H", active.high],
            ["L", active.low],
            ["C", active.close],
          ].map(([label, value]) => (
            <span key={label}>
              <small>{label}</small>
              {numberLabel(value as number, {
                precision,
                prefix: pricePrefix,
              })}
            </span>
          ))}
          <span
            className={
              change >= 0 ? styles.chartPositive : styles.chartNegative
            }
          >
            <small>Δ</small>
            {change >= 0 ? "+" : ""}
            {change.toFixed(2)}%
          </span>
        </div>
      </div>

      <svg
        aria-label={`${block.heading}. Use arrow keys or move across the chart to inspect OHLC values.`}
        className={styles.traderChartSvg}
        onBlur={() => setHoveredIndex(null)}
        onFocus={() => setHoveredIndex(candles.length - 1)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") moveSelection(event, -1);
          if (event.key === "ArrowRight") moveSelection(event, 1);
        }}
        onPointerLeave={() => setHoveredIndex(null)}
        onPointerMove={(event) =>
          setHoveredIndex(
            candleIndexAtPointer(event, {
              count: candles.length,
              plotLeft,
              plotRight,
              width,
            }),
          )
        }
        role="img"
        tabIndex={0}
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>{block.heading}</title>
        <desc>
          Candlestick chart with {candles.length} observations. The selected
          candle values are shown above the plot.
        </desc>

        {[...ticks].reverse().map((value) => {
          const tickY = y(value);
          return (
            <g key={value}>
              <line
                className={styles.traderGridLine}
                x1={plotLeft}
                x2={plotRight}
                y1={tickY}
                y2={tickY}
              />
              <text
                className={styles.traderAxisLabel}
                dominantBaseline="middle"
                x={plotRight + 8}
                y={tickY}
              >
                {numberLabel(value, {
                  fixed: false,
                  precision,
                  prefix: pricePrefix,
                })}
              </text>
            </g>
          );
        })}

        <line
          className={styles.lastPriceLine}
          x1={plotLeft}
          x2={plotRight}
          y1={lastY}
          y2={lastY}
        />

        {candles.map((candle, index) => {
          const candleX = x(index);
          const openY = y(candle.open);
          const closeY = y(candle.close);
          const color =
            candle.close >= candle.open ? RISING_COLOR : FALLING_COLOR;
          return (
            <g key={`${candle.label}-${index}`}>
              <title>
                {`${candle.label}: open ${candle.open}, high ${candle.high}, low ${candle.low}, close ${candle.close}`}
              </title>
              <line
                stroke={color}
                strokeWidth="1.4"
                vectorEffect="non-scaling-stroke"
                x1={candleX}
                x2={candleX}
                y1={y(candle.high)}
                y2={y(candle.low)}
              />
              <rect
                fill={color}
                height={Math.max(1.5, Math.abs(closeY - openY))}
                width={candleWidth}
                x={candleX - candleWidth / 2}
                y={Math.min(openY, closeY)}
              />
            </g>
          );
        })}

        {labelIndexes(candles.length, width).map((index) => (
          <text
            className={styles.traderAxisLabel}
            key={`${candles[index]?.label}-${index}`}
            textAnchor={
              index === 0
                ? "start"
                : index === candles.length - 1
                  ? "end"
                  : "middle"
            }
            x={x(index)}
            y={height - 8}
          >
            {shortDateLabel(candles[index]!.label)}
          </text>
        ))}

        <g>
          <rect
            fill={lastColor}
            height="22"
            rx="4"
            width={margin.right - 8}
            x={plotRight + 4}
            y={lastLabelY - 11}
          />
          <text
            className={styles.lastPriceLabel}
            dominantBaseline="middle"
            textAnchor="middle"
            x={plotRight + margin.right / 2}
            y={lastLabelY}
          >
            {numberLabel(last.close, {
              precision,
              prefix: pricePrefix,
            })}
          </text>
        </g>

        {hoveredIndex !== null ? (
          <g pointerEvents="none">
            <line
              className={styles.chartCrosshair}
              x1={x(activeIndex)}
              x2={x(activeIndex)}
              y1={plotTop}
              y2={plotBottom}
            />
            <circle
              fill={activeColor}
              r="3.5"
              stroke="#0c0d0d"
              strokeWidth="1.5"
              cx={x(activeIndex)}
              cy={y(active.close)}
            />
          </g>
        ) : null}
      </svg>
      <p className={styles.chartInteractionHint}>
        Move across the chart or use the arrow keys to inspect each candle.
      </p>
    </div>
  );
}

export function DenseBarFinancialChart({
  block,
}: {
  readonly block: BarBlock;
}) {
  const [containerRef, width] = useChartWidth();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const values = block.items.map((item) => item.value);
  const ticks = chartNiceTicks([0, ...values]);
  const maximum = ticks.at(-1)!;
  const precision = chartPricePrecision(values);
  const height = width < 520 ? 280 : 330;
  const margin = { bottom: 34, left: 10, right: 64, top: 18 };
  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const xStep = plotWidth / block.items.length;
  const barWidth = clamp(xStep * 0.68, 2.5, 16);
  const x = (index: number) => plotLeft + xStep * index + xStep / 2;
  const y = (value: number) =>
    plotBottom - (Math.max(0, value) / maximum) * plotHeight;
  const activeIndex = hoveredIndex ?? block.items.length - 1;
  const active = block.items[activeIndex]!;

  const moveSelection = (
    event: ReactKeyboardEvent<SVGSVGElement>,
    direction: -1 | 1,
  ) => {
    event.preventDefault();
    setHoveredIndex((current) =>
      clamp(
        (current ?? block.items.length - 1) + direction,
        0,
        block.items.length - 1,
      ),
    );
  };

  return (
    <div className={styles.traderChart} ref={containerRef}>
      <div className={styles.chartReadout}>
        <strong>{shortDateLabel(active.label)}</strong>
        <div className={styles.chartReadoutValues}>
          <span>
            <small>Value</small>
            {numberLabel(active.value, {
              precision,
              prefix: block.valuePrefix,
              suffix: block.valueSuffix,
            })}
          </span>
        </div>
      </div>

      <svg
        aria-label={`${block.heading}. Use arrow keys or move across the chart to inspect each bar.`}
        className={styles.traderChartSvg}
        onBlur={() => setHoveredIndex(null)}
        onFocus={() => setHoveredIndex(block.items.length - 1)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") moveSelection(event, -1);
          if (event.key === "ArrowRight") moveSelection(event, 1);
        }}
        onPointerLeave={() => setHoveredIndex(null)}
        onPointerMove={(event) =>
          setHoveredIndex(
            candleIndexAtPointer(event, {
              count: block.items.length,
              plotLeft,
              plotRight,
              width,
            }),
          )
        }
        role="img"
        tabIndex={0}
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>{block.heading}</title>
        <desc>
          Vertical bar chart with {block.items.length} observations. The
          selected value is shown above the plot.
        </desc>

        {[...ticks].reverse().map((value) => {
          const tickY = y(value);
          return (
            <g key={value}>
              <line
                className={styles.traderGridLine}
                x1={plotLeft}
                x2={plotRight}
                y1={tickY}
                y2={tickY}
              />
              <text
                className={styles.traderAxisLabel}
                dominantBaseline="middle"
                x={plotRight + 8}
                y={tickY}
              >
                {numberLabel(value, {
                  compact: true,
                  prefix: block.valuePrefix,
                  suffix: block.valueSuffix,
                })}
              </text>
            </g>
          );
        })}

        {block.items.map((item, index) => {
          const barY = y(item.value);
          return (
            <rect
              fill={BAR_COLORS[item.tone ?? "info"]}
              height={Math.max(1, plotBottom - barY)}
              key={`${item.label}-${index}`}
              opacity={hoveredIndex === null || hoveredIndex === index ? 1 : 0.38}
              rx={Math.min(2, barWidth / 3)}
              width={barWidth}
              x={x(index) - barWidth / 2}
              y={barY}
            >
              <title>
                {`${item.label}: ${numberLabel(item.value, {
                  precision,
                  prefix: block.valuePrefix,
                  suffix: block.valueSuffix,
                })}`}
              </title>
            </rect>
          );
        })}

        {labelIndexes(block.items.length, width).map((index) => (
          <text
            className={styles.traderAxisLabel}
            key={`${block.items[index]?.label}-${index}`}
            textAnchor={
              index === 0
                ? "start"
                : index === block.items.length - 1
                  ? "end"
                  : "middle"
            }
            x={x(index)}
            y={height - 8}
          >
            {shortDateLabel(block.items[index]!.label)}
          </text>
        ))}

        {hoveredIndex !== null ? (
          <line
            className={styles.chartCrosshair}
            pointerEvents="none"
            x1={x(activeIndex)}
            x2={x(activeIndex)}
            y1={plotTop}
            y2={plotBottom}
          />
        ) : null}
      </svg>
      <p className={styles.chartInteractionHint}>
        Move across the chart or use the arrow keys to inspect each bar.
      </p>
    </div>
  );
}

function stepPath(points: readonly PlottedDepthPoint[]): string {
  if (points.length === 0) return "";
  return points
    .slice(1)
    .reduce(
      (path, point) => `${path} H ${point.x} V ${point.y}`,
      `M ${points[0]!.x} ${points[0]!.y}`,
    );
}

export function DepthFinancialChart({
  block,
}: {
  readonly block: DepthBlock;
}) {
  const [containerRef, width] = useChartWidth();
  const [selected, setSelected] = useState<PlottedDepthPoint | null>(null);
  const bidCurve = cumulativeDepthPoints(block.bids, "descending").reverse();
  const askCurve = cumulativeDepthPoints(block.asks, "ascending");
  const bestBid = Math.max(...block.bids.map((point) => point.price));
  const bestAsk = Math.min(...block.asks.map((point) => point.price));
  const midpoint = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadPercent = midpoint === 0 ? 0 : (spread / midpoint) * 100;
  const spreadBasisPoints = spreadPercent * 100;
  const allPrices = [...bidCurve, ...askCurve].map((point) => point.price);
  const precision = chartPricePrecision(allPrices);
  const pricePrefix = inferredChartPricePrefix(
    block.valuePrefix,
    block.heading,
  );
  const priceRange = paddedRange(allPrices, 0.035);
  const rawMaximumSize = Math.max(
    ...bidCurve.map((point) => point.size),
    ...askCurve.map((point) => point.size),
    1,
  );
  const sizeTicks = chartNiceTicks([0, rawMaximumSize]);
  const maximumSize = sizeTicks.at(-1)!;
  const height = width < 520 ? 330 : 370;
  const margin = { bottom: 34, left: 10, right: 70, top: 22 };
  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const x = (price: number) =>
    plotLeft +
    ((price - priceRange.minimum) /
      (priceRange.maximum - priceRange.minimum)) *
      plotWidth;
  const y = (size: number) =>
    plotBottom - (size / maximumSize) * plotHeight * 0.95;
  const plottedBids: PlottedDepthPoint[] = bidCurve.map((point) => ({
    ...point,
    side: "bid",
    x: x(point.price),
    y: y(point.size),
  }));
  const plottedAsks: PlottedDepthPoint[] = askCurve.map((point) => ({
    ...point,
    side: "ask",
    x: x(point.price),
    y: y(point.size),
  }));
  const allPoints = [...plottedBids, ...plottedAsks];
  const bidPath = stepPath(plottedBids);
  const askPath = stepPath(plottedAsks);
  const bidArea = `${bidPath} L ${plottedBids.at(-1)!.x} ${plotBottom} L ${plottedBids[0]!.x} ${plotBottom} Z`;
  const askArea = `${askPath} L ${plottedAsks.at(-1)!.x} ${plotBottom} L ${plottedAsks[0]!.x} ${plotBottom} Z`;
  const bidGradientId = useId().replaceAll(":", "");
  const askGradientId = useId().replaceAll(":", "");

  const selectNearest = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = ((event.clientX - bounds.left) / bounds.width) * width;
    setSelected(
      allPoints.reduce((nearest, point) =>
        Math.abs(point.x - localX) < Math.abs(nearest.x - localX)
          ? point
          : nearest,
      ),
    );
  };

  return (
    <div className={styles.traderChart} ref={containerRef}>
      <div className={styles.depthStats}>
        <span>
          <small>Best bid</small>
          <strong>
            {numberLabel(bestBid, {
              precision,
              prefix: pricePrefix,
            })}
          </strong>
        </span>
        <span>
          <small>Best ask</small>
          <strong>
            {numberLabel(bestAsk, {
              precision,
              prefix: pricePrefix,
            })}
          </strong>
        </span>
        <span>
          <small>Spread</small>
          <strong>
            {numberLabel(spread, {
              precision,
              prefix: pricePrefix,
            })}
            <em>{spreadBasisPoints.toFixed(3)} bps</em>
          </strong>
        </span>
      </div>

      <div className={styles.depthSelection} aria-live="polite">
        {selected ? (
          <>
            <strong>{selected.side === "bid" ? "Bid" : "Ask"} level</strong>
            <span>
              Price{" "}
              {numberLabel(selected.price, {
                precision,
                prefix: pricePrefix,
              })}
              {" · "}Cumulative size {numberLabel(selected.size, { compact: true })}
            </span>
          </>
        ) : (
          <>
            <strong>Displayed liquidity</strong>
            <span>Move across the chart to inspect cumulative depth by price.</span>
          </>
        )}
      </div>

      <svg
        aria-label={`${block.heading}. Bid and ask curves show cumulative displayed size by price.`}
        className={styles.traderChartSvg}
        onPointerLeave={() => setSelected(null)}
        onPointerMove={selectNearest}
        role="img"
        tabIndex={0}
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>{block.heading}</title>
        <desc>
          Cumulative order-book depth. Best bid, best ask, and spread are shown
          above the plot.
        </desc>
        <defs>
          <linearGradient id={bidGradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={RISING_COLOR} stopOpacity="0.28" />
            <stop offset="100%" stopColor={RISING_COLOR} stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={askGradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={FALLING_COLOR} stopOpacity="0.28" />
            <stop offset="100%" stopColor={FALLING_COLOR} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <text
          className={styles.traderAxisTitle}
          textAnchor="end"
          x={plotRight}
          y={12}
        >
          Cumulative size
        </text>

        {[...sizeTicks].reverse().map((size) => {
          const tickY = y(size);
          return (
            <g key={size}>
              <line
                className={styles.traderGridLine}
                x1={plotLeft}
                x2={plotRight}
                y1={tickY}
                y2={tickY}
              />
              <text
                className={styles.traderAxisLabel}
                dominantBaseline="middle"
                x={plotRight + 8}
                y={tickY}
              >
                {numberLabel(size, { compact: true })}
              </text>
            </g>
          );
        })}

        <path d={bidArea} fill={`url(#${bidGradientId})`} />
        <path d={askArea} fill={`url(#${askGradientId})`} />
        <path
          className={styles.bidDepthLine}
          d={bidPath}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className={styles.askDepthLine}
          d={askPath}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />

        <line
          className={styles.midPriceLine}
          x1={x(midpoint)}
          x2={x(midpoint)}
          y1={plotTop}
          y2={plotBottom}
        />
        <text
          className={styles.traderAxisLabel}
          textAnchor="middle"
          x={x(midpoint)}
          y={height - 8}
        >
          Mid{" "}
          {numberLabel(midpoint, {
            precision,
            prefix: pricePrefix,
          })}
        </text>
        <text
          className={styles.traderAxisLabel}
          textAnchor="start"
          x={x(Math.min(...allPrices))}
          y={height - 8}
        >
          {numberLabel(Math.min(...allPrices), {
            precision,
            prefix: pricePrefix,
          })}
        </text>
        <text
          className={styles.traderAxisLabel}
          textAnchor="end"
          x={x(Math.max(...allPrices))}
          y={height - 8}
        >
          {numberLabel(Math.max(...allPrices), {
            precision,
            prefix: pricePrefix,
          })}
        </text>

        {selected ? (
          <g pointerEvents="none">
            <line
              className={styles.chartCrosshair}
              x1={selected.x}
              x2={selected.x}
              y1={plotTop}
              y2={plotBottom}
            />
            <circle
              cx={selected.x}
              cy={selected.y}
              fill={selected.side === "bid" ? RISING_COLOR : FALLING_COLOR}
              r="4"
              stroke="#0c0d0d"
              strokeWidth="1.5"
            />
          </g>
        ) : null}
      </svg>

      <div className={styles.legend}>
        <span>
          <i style={{ background: RISING_COLOR }} />
          Cumulative bids
        </span>
        <span>
          <i style={{ background: FALLING_COLOR }} />
          Cumulative asks
        </span>
      </div>
    </div>
  );
}
