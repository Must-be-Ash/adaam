import { artifactIdSchema } from "#artifact-schema";

const ARTIFACT_REFERENCE_PREFIX = "artifact:";

export function artifactReferenceForId(artifactId: string): string {
  if (!artifactIdSchema.safeParse(artifactId).success) {
    throw new Error("artifact_reference_invalid");
  }
  return `${ARTIFACT_REFERENCE_PREFIX}${artifactId}`;
}

export function artifactIdFromReference(reference: string): string | null {
  const artifactId = reference.startsWith(ARTIFACT_REFERENCE_PREFIX)
    ? reference.slice(ARTIFACT_REFERENCE_PREFIX.length)
    : "";
  return artifactIdSchema.safeParse(artifactId).success ? artifactId : null;
}
