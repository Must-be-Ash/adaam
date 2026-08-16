import { defineDynamic, defineInstructions } from "eve/instructions";

import {
  resolveSessionStrategyPackRuntime,
  STRATEGY_PACK_RUNTIME_UNAVAILABLE_INSTRUCTION,
} from "../lib/strategy-pack-runtime";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const runtime = await resolveSessionStrategyPackRuntime({ ctx });
        if (!runtime || runtime.state === "unbound") return null;
        return defineInstructions({
          markdown: [
            "# Active workspace strategy pack",
            "",
            runtime.workspaceInstruction.trim(),
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
