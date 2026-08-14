import type { CSSProperties, ReactNode } from "react";
import Markdown from "react-markdown";

import type {
  ReportBlock,
  ResearchReport,
} from "@/agent/lib/artifact-schema";

import styles from "./artifact.module.css";
import {
  CandlestickFinancialChart,
  DenseBarFinancialChart,
  DepthFinancialChart,
} from "./financial-charts";

const CHART_COLORS = [
  "#e8f16a",
  "#6ee7d2",
  "#94a3ff",
  "#ff9f7a",
  "#d8b4fe",
  "#f9c74f",
] as const;

const TONE_CLASS = {
  info: styles.toneInfo,
  negative: styles.toneNegative,
  neutral: styles.toneNeutral,
  positive: styles.tonePositive,
  warning: styles.toneWarning,
} as const;

type BlockOf<T extends ReportBlock["type"]> = Extract<
  ReportBlock,
  { type: T }
>;

function numericLabel(
  value: number,
  prefix = "",
  suffix = "",
): string {
  return `${prefix}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(value)}${suffix}`;
}

function chartRange(values: number[]): { maximum: number; minimum: number } {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum !== maximum) return { maximum, minimum };
  const padding = Math.abs(minimum) * 0.05 || 1;
  return { maximum: maximum + padding, minimum: minimum - padding };
}

function chartY(
  value: number,
  range: { maximum: number; minimum: number },
  height: number,
  padding: number,
): number {
  return (
    padding +
    ((range.maximum - value) / (range.maximum - range.minimum)) *
      (height - padding * 2)
  );
}

function ChartFrame({
  children,
  heading,
  note,
}: {
  readonly children: ReactNode;
  readonly heading: string;
  readonly note?: string;
}) {
  return (
    <section className={styles.chartCard}>
      <div className={styles.sectionHeading}>
        <p className={styles.sectionKicker}>Visualization</p>
        <h2>{heading}</h2>
      </div>
      {children}
      {note ? <p className={styles.chartNote}>{note}</p> : null}
    </section>
  );
}

function LineChart({ block }: { readonly block: BlockOf<"line-chart"> }) {
  const width = 720;
  const height = 300;
  const padding = 36;
  const values = block.series.flatMap((series) =>
    series.points.map((point) => point.value),
  );
  const range = chartRange(values);
  const longestSeries = Math.max(
    ...block.series.map((series) => series.points.length),
  );
  const xForIndex = (index: number, length: number) =>
    padding + (index / Math.max(1, length - 1)) * (width - padding * 2);
  const labelSeries = block.series.find(
    (series) => series.points.length === longestSeries,
  )!;
  const labelIndexes = [
    0,
    Math.floor((labelSeries.points.length - 1) / 2),
    labelSeries.points.length - 1,
  ];

  return (
    <ChartFrame heading={block.heading} note={block.note}>
      <div className={styles.chartScroll}>
        <svg
          aria-label={block.heading}
          className={styles.chart}
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <title>{block.heading}</title>
          {[0, 1, 2, 3, 4].map((line) => {
            const y = padding + (line / 4) * (height - padding * 2);
            const value =
              range.maximum -
              (line / 4) * (range.maximum - range.minimum);
            return (
              <g key={line}>
                <line
                  className={styles.gridLine}
                  x1={padding}
                  x2={width - padding}
                  y1={y}
                  y2={y}
                />
                <text className={styles.axisLabel} x={4} y={y + 4}>
                  {numericLabel(value, block.valuePrefix, block.valueSuffix)}
                </text>
              </g>
            );
          })}
          {block.series.map((series, seriesIndex) => {
            const points = series.points
              .map(
                (point, index) =>
                  `${xForIndex(index, series.points.length)},${chartY(
                    point.value,
                    range,
                    height,
                    padding,
                  )}`,
              )
              .join(" ");
            return (
              <polyline
                fill="none"
                key={`${series.name}-${seriesIndex}`}
                points={points}
                stroke={CHART_COLORS[seriesIndex % CHART_COLORS.length]}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
              />
            );
          })}
          {labelIndexes.map((index) => (
            <text
              className={styles.axisLabel}
              key={`${labelSeries.points[index]?.label}-${index}`}
              textAnchor={
                index === 0
                  ? "start"
                  : index === labelSeries.points.length - 1
                    ? "end"
                    : "middle"
              }
              x={xForIndex(index, labelSeries.points.length)}
              y={height - 8}
            >
              {labelSeries.points[index]?.label}
            </text>
          ))}
        </svg>
      </div>
      {block.series.length > 1 ? (
        <div className={styles.legend}>
          {block.series.map((series, index) => (
            <span key={`${series.name}-${index}`}>
              <i
                style={{
                  background: CHART_COLORS[index % CHART_COLORS.length],
                }}
              />
              {series.name}
            </span>
          ))}
        </div>
      ) : null}
    </ChartFrame>
  );
}

function BarChart({ block }: { readonly block: BlockOf<"bar-chart"> }) {
  const useDenseChart =
    block.items.length > 10 &&
    block.items.every((item) => item.value >= 0) &&
    block.items.some((item) => item.value > 0);
  if (useDenseChart) {
    return (
      <ChartFrame heading={block.heading} note={block.note}>
        <DenseBarFinancialChart block={block} />
      </ChartFrame>
    );
  }

  const maximum = Math.max(...block.items.map((item) => Math.abs(item.value)), 1);
  return (
    <ChartFrame heading={block.heading} note={block.note}>
      <div className={styles.barChart}>
        {block.items.map((item, index) => (
          <div className={styles.barRow} key={`${item.label}-${index}`}>
            <div className={styles.barLabel}>
              <span>{item.label}</span>
              <strong>
                {numericLabel(
                  item.value,
                  block.valuePrefix,
                  block.valueSuffix,
                )}
              </strong>
            </div>
            <div className={styles.barTrack}>
              <span
                className={item.tone ? TONE_CLASS[item.tone] : styles.toneInfo}
                style={{ width: `${(Math.abs(item.value) / maximum) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartFrame>
  );
}

function PieChart({ block }: { readonly block: BlockOf<"pie-chart"> }) {
  const total = block.items.reduce((sum, item) => sum + item.value, 0);
  let cursor = 0;
  const stops = block.items.map((item, index) => {
    const start = total === 0 ? 0 : (cursor / total) * 100;
    cursor += item.value;
    const end = total === 0 ? 0 : (cursor / total) * 100;
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${end}%`;
  });
  const chartStyle = {
    "--pie-background":
      total === 0 ? "#333 0% 100%" : stops.join(", "),
  } as CSSProperties;

  return (
    <ChartFrame heading={block.heading} note={block.note}>
      <div className={styles.pieLayout}>
        <div
          aria-label={block.heading}
          className={styles.pie}
          role="img"
          style={chartStyle}
        >
          <span>{numericLabel(total)}</span>
          <small>Total</small>
        </div>
        <div className={styles.pieLegend}>
          {block.items.map((item, index) => (
            <div key={`${item.label}-${index}`}>
              <i
                style={{
                  background: CHART_COLORS[index % CHART_COLORS.length],
                }}
              />
              <span>{item.label}</span>
              <strong>
                {total === 0
                  ? "0%"
                  : `${((item.value / total) * 100).toFixed(1)}%`}
              </strong>
            </div>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}

function CandlestickChart({
  block,
}: {
  readonly block: BlockOf<"candlestick-chart">;
}) {
  return (
    <ChartFrame heading={block.heading} note={block.note}>
      <CandlestickFinancialChart block={block} />
    </ChartFrame>
  );
}

function DepthChart({ block }: { readonly block: BlockOf<"depth-chart"> }) {
  return (
    <ChartFrame heading={block.heading} note={block.note}>
      <DepthFinancialChart block={block} />
    </ChartFrame>
  );
}

function publicReportMarkdown(body: string): string {
  return body
    .replace(
      /\s+generated in (?:the )?isolated session\s+["“][^"”\n]+["”]/giu,
      "",
    )
    .replace(/\s*\(\s*isolated turn\s*\)/giu, "")
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/^\s*(?:(?:\*\*|__)?(?:session|workspace)(?:\*\*|__)?):/iu.test(
          line,
        ),
    )
    .join("\n")
    .trim();
}

function ReportMarkdown({ body }: { readonly body: string }) {
  return (
    <div className={styles.markdown}>
      <Markdown
        components={{
          a({ children, href }) {
            return (
              <a href={href} rel="noreferrer" target="_blank">
                {children}
              </a>
            );
          },
          h1() {
            return null;
          },
          h3: "h2",
          h4: "h3",
          h5: "h3",
          h6: "h3",
          img() {
            return null;
          },
        }}
        skipHtml
      >
        {publicReportMarkdown(body)}
      </Markdown>
    </div>
  );
}

function ReportBlockView({ block }: { readonly block: ReportBlock }) {
  switch (block.type) {
    case "text":
      return (
        <section className={styles.textSection}>
          {block.heading ? <h2>{block.heading}</h2> : null}
          <ReportMarkdown body={block.body} />
          {block.bullets?.length ? (
            <ul>
              {block.bullets.map((bullet, index) => (
                <li key={`${bullet}-${index}`}>{bullet}</li>
              ))}
            </ul>
          ) : null}
        </section>
      );
    case "callout":
      return (
        <aside
          className={`${styles.callout} ${TONE_CLASS[block.tone]}`}
          role="note"
        >
          {block.heading ? <h2>{block.heading}</h2> : null}
          <p>{block.body}</p>
        </aside>
      );
    case "metrics":
      return (
        <section>
          {block.heading ? (
            <div className={styles.sectionHeading}>
              <p className={styles.sectionKicker}>Key data</p>
              <h2>{block.heading}</h2>
            </div>
          ) : null}
          <MetricGrid metrics={block.items} />
        </section>
      );
    case "table":
      return (
        <section className={styles.tableSection}>
          {block.heading ? <h2>{block.heading}</h2> : null}
          <div className={styles.tableScroll}>
            <table>
              <thead>
                <tr>
                  {block.columns.map((column, index) => (
                    <th key={`${column}-${index}`}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {block.columns.map((_, columnIndex) => (
                      <td key={columnIndex}>{row[columnIndex] ?? "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.note ? <p className={styles.chartNote}>{block.note}</p> : null}
        </section>
      );
    case "line-chart":
      return <LineChart block={block} />;
    case "bar-chart":
      return <BarChart block={block} />;
    case "pie-chart":
      return <PieChart block={block} />;
    case "candlestick-chart":
      return <CandlestickChart block={block} />;
    case "depth-chart":
      return <DepthChart block={block} />;
  }
}

function MetricGrid({
  metrics,
}: {
  readonly metrics: ResearchReport["metrics"];
}) {
  if (!metrics?.length) return null;
  return (
    <div className={styles.metricGrid}>
      {metrics.map((metric, index) => (
        <article
          className={`${styles.metric} ${
            metric.tone ? TONE_CLASS[metric.tone] : ""
          }`}
          key={`${metric.label}-${index}`}
        >
          <p>{metric.label}</p>
          <strong>{metric.value}</strong>
          {metric.detail ? <span>{metric.detail}</span> : null}
        </article>
      ))}
    </div>
  );
}

export function ResearchReportView({
  presentation = "report",
  report,
}: {
  readonly presentation?: "report" | "chart";
  readonly report: ResearchReport;
}) {
  const identity = [report.subject?.symbol, report.subject?.assetClass]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className={styles.report}>
      <header className={styles.reportHero}>
        <div className={styles.brandRow}>
          <span>{presentation === "chart" ? "Eve Chart" : "Eve Research"}</span>
          {report.asOf ? <time>{report.asOf}</time> : null}
        </div>
        <p className={styles.eyebrow}>
          {report.eyebrow ?? identity ?? "Research dossier"}
        </p>
        <h1>{report.title}</h1>
        <p className={styles.reportDescription}>{report.description}</p>
        <div className={styles.heroMeta}>
          {report.subject?.name ? <span>{report.subject.name}</span> : null}
          {report.confidence ? (
            <span>Confidence: {report.confidence}</span>
          ) : null}
        </div>
      </header>

      <section className={styles.summaryCard}>
        <p className={styles.sectionKicker}>
          {presentation === "chart" ? "Chart summary" : "Executive summary"}
        </p>
        <p>{report.summary}</p>
        {report.verdict ? (
          <div
            className={`${styles.verdict} ${TONE_CLASS[report.verdict.tone]}`}
          >
            <strong>{report.verdict.label}</strong>
            <span>{report.verdict.rationale}</span>
          </div>
        ) : null}
      </section>

      <MetricGrid metrics={report.metrics} />

      <div className={styles.reportBody}>
        {report.blocks.map((block, index) => (
          <ReportBlockView block={block} key={`${block.type}-${index}`} />
        ))}
      </div>

      {report.sources.length ? (
        <section className={styles.sources}>
          <div className={styles.sectionHeading}>
            <p className={styles.sectionKicker}>Provenance</p>
            <h2>Sources</h2>
          </div>
          <ol>
            {report.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a
                  className={styles.sourceLink}
                  href={source.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {source.label}
                  <span aria-hidden className={styles.sourceArrow}>
                    ↗
                  </span>
                </a>
                <span className={styles.sourceMeta}>
                  {[source.publisher, source.publishedAt]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <footer className={styles.reportFooter}>
        <span>Eve</span>
        <p>
          {report.disclosure ??
            "Research support only. Evidence and market conditions can change; this is not personalized investment advice."}
        </p>
      </footer>
    </main>
  );
}
