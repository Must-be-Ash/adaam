import { z } from "zod";

const numericProviderIdSchema = z.string().regex(/^\d{1,20}$/u);

export const inverseCramerSprint0ContractSchema = z.object({
  activation: z.object({
    baselineBackfillAlerts: z.literal(false),
    firstFetchEstablishesBaseline: z.literal(true),
    watermarkRecordedBeforeAcquisition: z.literal(true),
  }).strict(),
  allowedPostRoles: z.object({
    original: z.literal(true),
    quote: z.literal("owner_configurable"),
    reply: z.literal("owner_configurable"),
    repost: z.literal(false),
  }).strict(),
  editFinalizationDelayMinutes: z.literal(30),
  executionFlag: z.literal("EVE_INVERSE_CRAMER_EXECUTION_ENABLED"),
  identity: z.discriminatedUnion("approvalState", [
    z.object({
      approvalState: z.literal("pending_owner_verification"),
      displayLabel: z.literal("Jim Cramer"),
      expectedUsername: z.literal("jimcramer"),
      numericUserId: z.null(),
    }).strict(),
    z.object({
      approvalState: z.literal("verified"),
      displayLabel: z.literal("Jim Cramer"),
      expectedUsername: z.literal("jimcramer"),
      numericUserId: numericProviderIdSchema,
    }).strict(),
  ]),
  identityCatalogRevision: z.literal(1),
  maximumCadenceMinutes: z.literal(60),
  minimumCadenceMinutes: z.literal(10),
  packId: z.literal("inverse-cramer"),
  packVersion: z.literal("1.0.0"),
  pagination: z.object({
    maximumPagesPerPoll: z.literal(2),
    maximumPostsPerPoll: z.literal(200),
  }).strict(),
  policyVersion: z.literal("1.0.0"),
  recordType: z.literal("inverse_cramer_sprint_0_contract"),
  referenceCadenceMinutes: z.literal(10),
  schemaVersion: z.literal(1),
  sourceAdapterVersion: z.literal("1.0.0"),
}).strict();

export const INVERSE_CRAMER_SPRINT_0_CONTRACT = inverseCramerSprint0ContractSchema.parse({
  activation: {
    baselineBackfillAlerts: false,
    firstFetchEstablishesBaseline: true,
    watermarkRecordedBeforeAcquisition: true,
  },
  allowedPostRoles: {
    original: true,
    quote: "owner_configurable",
    reply: "owner_configurable",
    repost: false,
  },
  editFinalizationDelayMinutes: 30,
  executionFlag: "EVE_INVERSE_CRAMER_EXECUTION_ENABLED",
  identity: {
    approvalState: "pending_owner_verification",
    displayLabel: "Jim Cramer",
    expectedUsername: "jimcramer",
    numericUserId: null,
  },
  identityCatalogRevision: 1,
  maximumCadenceMinutes: 60,
  minimumCadenceMinutes: 10,
  packId: "inverse-cramer",
  packVersion: "1.0.0",
  pagination: {
    maximumPagesPerPoll: 2,
    maximumPostsPerPoll: 200,
  },
  policyVersion: "1.0.0",
  recordType: "inverse_cramer_sprint_0_contract",
  referenceCadenceMinutes: 10,
  schemaVersion: 1,
  sourceAdapterVersion: "1.0.0",
});
