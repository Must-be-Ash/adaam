import { defineDynamic, defineInstructions } from "eve/instructions";

import {
  resolveSessionStrategyPackRuntime,
  STRATEGY_PACK_RUNTIME_UNAVAILABLE_INSTRUCTION,
} from "../lib/strategy-pack-runtime";

export function strategyPackCompatibilityInstruction(pack: { id: string; version: string }): string | null {
  return pack.id === "congressional-signals" && pack.version === "1.5.0"
    ? "Runtime compatibility amendment: every independently verified watched-member House purchase or sale is notified. The configured minimum band and optional GPT-5.4 interpretation describe context only and cannot suppress the factual disclosure notification."
    : null;
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
