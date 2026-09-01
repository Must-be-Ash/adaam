import { defineDynamic, defineInstructions } from "eve/instructions";

import {
  resolveSessionStrategyPackRuntime,
  STRATEGY_PACK_RUNTIME_UNAVAILABLE_INSTRUCTION,
} from "../lib/strategy-pack-runtime";

export function strategyPackCompatibilityInstruction(pack: { id: string; version: string }): string | null {
  if (pack.id !== "congressional-signals") return null;
  const transactionFirst = pack.version === "1.5.0"
    ? "Every independently verified watched-member House purchase or sale is notified. The configured minimum band and optional GPT-5.4 interpretation describe context only and cannot suppress the factual disclosure notification."
    : null;
  const memberHistory = pack.version === "1.6.0"
    ? "For a question about one member's disclosures, call `query_congressional_history` with that exact member. Never answer a member-specific history question from the latest signal, source checkpoint, or another member's filing. If the tool cannot resolve the member or coverage is incomplete, say so instead of substituting unrelated facts."
    : null;
  const amendments = [transactionFirst, memberHistory].filter((value): value is string => value !== null);
  return amendments.length > 0 ? `Runtime compatibility amendment: ${amendments.join(" ")}` : null;
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const runtime = await resolveSessionStrategyPackRuntime({ ctx });
        if (!runtime || runtime.state === "unbound") return null;
        const compatibilityInstruction = strategyPackCompatibilityInstruction(runtime.pack);
        return defineInstructions({
          markdown: [
            "# Active workspace strategy pack",
            "",
            runtime.workspaceInstruction.trim(),
            ...(compatibilityInstruction ? ["", compatibilityInstruction] : []),
            "",
            "Apply only this exact installed pack. Do not infer missions, playbooks, sources, or capabilities from any other catalog entry.",
          ].join("\n"),
        });
      } catch {
        return defineInstructions({
          markdown: STRATEGY_PACK_RUNTIME_UNAVAILABLE_INSTRUCTION,
        });
      }
    },
  },
});
