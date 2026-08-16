import { defineDynamic, defineSkill } from "eve/skills";

import { resolveSessionStrategyPackRuntime } from "../lib/strategy-pack-runtime";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const runtime = await resolveSessionStrategyPackRuntime({ ctx });
        if (!runtime || runtime.state === "unbound") return null;
        return Object.fromEntries(
          runtime.skills.map((skill) => [
            skill.id,
            defineSkill({
              description: skill.description,
              markdown: skill.instruction,
            }),
          ]),
        );
      } catch {
        return null;
      }
    },
  },
});
