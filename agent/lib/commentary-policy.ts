import { z } from "zod";

import {
  commentaryExtractionSchema,
  commentaryPolicyDecisionSchema,
  commentaryPolicyDefinitionSchema,
  digestPublicCommentaryValue,
} from "./public-commentary-schema";

const transformSchema = z.object({
  map: z.object({
    bearish: z.literal("bullish"),
    bullish: z.literal("bearish"),
    mixed: z.null(),
    neutral: z.null(),
    no_view: z.null(),
    unclear: z.null(),
  }).strict(),
  transformId: z.string().regex(/^[a-z][a-z0-9.-]+$/u),
  version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
}).strict();

export const COMMENTARY_INVERSION_TRANSFORM = transformSchema.parse({
  map: {
    bearish: "bullish",
    bullish: "bearish",
    mixed: null,
    neutral: null,
    no_view: null,
    unclear: null,
  },
  transformId: "invert-bullish-bearish",
  version: "1.0.0",
});

export type CommentaryTransform = z.infer<typeof transformSchema>;
export type CommentaryPolicyRegistry = Readonly<{
  resolve(transformId: string, version: string): CommentaryTransform | null;
}>;

export function createCommentaryPolicyRegistry(
  transforms: readonly CommentaryTransform[] = [COMMENTARY_INVERSION_TRANSFORM],
): CommentaryPolicyRegistry {
  const parsed = transforms.map((transform) => transformSchema.parse(transform));
  const keys = parsed.map(({ transformId, version }) => `${transformId}@${version}`);
  if (new Set(keys).size !== keys.length) throw new Error("commentary_policy_transform_conflict");
  return Object.freeze({
    resolve(transformId: string, version: string) {
      return parsed.find((item) => item.transformId === transformId && item.version === version) ?? null;
    },
  });
}

export function createCommentaryPolicyDefinition(input: {
  readonly displayName: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly transformId: string;
  readonly transformVersion: string;
}) {
  const core = {
    displayName: z.string().trim().min(1).max(120).parse(input.displayName),
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    supportedAttributions: ["direct", "quoted", "alleged", "conflicting"] as const,
    supportedStances: ["bullish", "bearish", "mixed", "neutral", "no_view", "unclear"] as const,
    transformId: input.transformId,
    transformVersion: input.transformVersion,
  };
  const policy = commentaryPolicyDefinitionSchema.parse({
    definitionDigest: digestPublicCommentaryValue(core),
    policyId: core.policyId,
    policyVersion: core.policyVersion,
    recordType: "commentary_policy_definition",
    schemaVersion: 1,
    supportedAttributions: [...core.supportedAttributions],
    supportedStances: [...core.supportedStances],
  });
  return Object.freeze({ ...core, policy });
}

export function decideCommentaryPolicy(input: {
  readonly extraction: z.infer<typeof commentaryExtractionSchema>;
  readonly policy: ReturnType<typeof createCommentaryPolicyDefinition>;
  readonly registry?: CommentaryPolicyRegistry;
}) {
  const extraction = commentaryExtractionSchema.parse(input.extraction);
  const registry = input.registry ?? createCommentaryPolicyRegistry();
  const transform = registry.resolve(input.policy.transformId, input.policy.transformVersion);
  if (!transform) throw new Error("commentary_policy_transform_unregistered");
  const direction = extraction.voiceOwnership === "speaker" && extraction.topic === "investment_view"
    ? transform.map[extraction.stance]
    : null;
  const decision = commentaryPolicyDecisionSchema.parse({
    decision: direction === null ? "no_view" : "research_candidate",
    decisionId: `commentary-policy-decision.${digestPublicCommentaryValue([input.policy.policy.definitionDigest, extraction])}`,
    inputDigest: digestPublicCommentaryValue(extraction),
    policyDigest: input.policy.policy.definitionDigest,
    policyId: input.policy.policyId,
    policyVersion: input.policy.policyVersion,
    rationaleCodes: direction === null
      ? [extraction.voiceOwnership !== "speaker" ? "quotation_only" : "no_registered_direction"]
      : ["registered_transform_applied"],
    recordType: "commentary_policy_decision",
    researchDirection: direction,
    schemaVersion: 1,
  });
  return Object.freeze({
    decision,
    directionDisclosure: direction === null
      ? `No direction was produced by the ${input.policy.displayName} policy.`
      : `This direction is produced by the ${input.policy.displayName} policy.`,
    transform: Object.freeze({ id: transform.transformId, version: transform.version }),
  });
}
