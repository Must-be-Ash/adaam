import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";

import type {
  ChartBlock,
  ReportRequirement,
  ResearchReport,
} from "#artifact-schema";

export interface ArtifactPublicationRejection {
  readonly missingRequirements: string[];
  readonly reason: string;
  readonly retryAllowed: false;
  readonly status: "not_published";
}

export interface ArtifactFinalValidationState {
  readonly rejection: ArtifactPublicationRejection | null;
  readonly turnId: string | null;
}

const artifactFinalValidationState =
  defineState<ArtifactFinalValidationState>(
    "adaam.artifact-publication.final-validation",
    () => ({ rejection: null, turnId: null }),
  );

const CHART_TYPES = new Set<ChartBlock["type"]>([
  "line-chart",
  "bar-chart",
  "pie-chart",
  "candlestick-chart",
  "depth-chart",
]);

function uniqueIssues(issues: readonly string[]): string[] {
  return [
    ...new Set(
      issues
        .map((issue) => issue.trim())
        .filter((issue) => issue.length > 0),
    ),
  ];
}

export function artifactFinalValidationDecision(
  current: ArtifactFinalValidationState,
  turnId: string,
  issues: readonly string[],
): {
  readonly rejection: ArtifactPublicationRejection | null;
  readonly state: ArtifactFinalValidationState;
} {
  if (current.turnId === turnId && current.rejection) {
    return { rejection: current.rejection, state: current };
  }

  const missingRequirements = uniqueIssues(issues);
  if (missingRequirements.length === 0) {
    return { rejection: null, state: current };
  }

  const rejection: ArtifactPublicationRejection = {
    missingRequirements,
    reason: `Artifact publication stopped at final validation because it is missing: ${missingRequirements.join(", ")}. Do not retry an artifact publisher in this turn.`,
    retryAllowed: false,
    status: "not_published",
  };

  return {
    rejection,
    state: { rejection, turnId },
  };
}

export function runArtifactFinalValidation(
  ctx: Pick<ToolContext, "session">,
  issues: readonly string[],
): ArtifactPublicationRejection | null {
  const current = artifactFinalValidationState.get();
  const decision = artifactFinalValidationDecision(
    current,
    ctx.session.turn.id,
    issues,
  );

  if (decision.state !== current) {
    artifactFinalValidationState.update(() => decision.state);
  }

  return decision.rejection;
}

function reportRequirementIsMet(
  report: ResearchReport,
  requirement: ReportRequirement,
): boolean {
  switch (requirement) {
    case "text":
    case "callout":
      return report.blocks.some((block) => block.type === requirement);
    case "metrics":
      return Boolean(
        report.metrics?.length ||
          report.blocks.some((block) => block.type === "metrics"),
      );
    case "table":
      return report.blocks.some((block) => block.type === "table");
    case "chart":
      return report.blocks.some((block) =>
        CHART_TYPES.has(block.type as ChartBlock["type"]),
      );
    case "line-chart":
    case "bar-chart":
    case "pie-chart":
    case "candlestick-chart":
    case "depth-chart":
      return report.blocks.some((block) => block.type === requirement);
    case "sources":
      return report.sources.length > 0;
  }
}

export function validateReportRequirements(
  report: ResearchReport,
  requirements: readonly ReportRequirement[],
): string[] {
  return uniqueIssues(
    requirements
      .filter((requirement) => !reportRequirementIsMet(report, requirement))
      .map((requirement) => requirement),
  );
}

export function validateChartBlocks(charts: readonly ChartBlock[]): string[] {
  const issues: string[] = [];

  if (charts.length === 0) {
    issues.push("at least one chart with numeric data");
  }

  for (const [index, chart] of charts.entries()) {
    const label = `chart ${index + 1} (${chart.type})`;
    switch (chart.type) {
      case "line-chart":
        if (
          chart.series.length === 0 ||
          chart.series.some((series) => series.points.length < 2)
        ) {
          issues.push(`${label}: at least two numeric points per series`);
        }
        break;
      case "bar-chart":
        if (chart.items.length === 0) {
          issues.push(`${label}: numeric bar data`);
        }
        break;
      case "pie-chart":
        if (
          chart.items.length < 2 ||
          chart.items.every((item) => item.value === 0)
        ) {
          issues.push(`${label}: at least two slices with a non-zero total`);
        }
        break;
      case "candlestick-chart":
        if (chart.candles.length < 2) {
          issues.push(`${label}: at least two OHLC candles`);
          break;
        }
        if (
          chart.candles.some(
            (candle) =>
              candle.low > Math.min(candle.open, candle.close) ||
              candle.high < Math.max(candle.open, candle.close) ||
              candle.low > candle.high,
          )
        ) {
          issues.push(`${label}: internally consistent OHLC values`);
        }
        break;
      case "depth-chart":
        if (chart.bids.length === 0 || chart.asks.length === 0) {
          issues.push(`${label}: numeric bid and ask levels`);
        }
        break;
    }
  }

  return uniqueIssues(issues);
}

export function validateReportForPublication(
  report: ResearchReport,
  requirements: readonly ReportRequirement[],
): string[] {
  const charts = report.blocks.filter(
    (block): block is ChartBlock =>
      CHART_TYPES.has(block.type as ChartBlock["type"]),
  );
  return uniqueIssues([
    ...validateReportRequirements(report, requirements),
    ...(charts.length > 0 ? validateChartBlocks(charts) : []),
  ]);
}
