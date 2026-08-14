import { artifactIdSchema } from "#artifact-schema";

export const ARTIFACT_PAGE_PATH_PREFIX = "/artifacts/";

export function publicApplicationOrigin(): URL {
  const configured =
    process.env.PHOTON_MINI_APP_BASE_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_URL;
  if (!configured) {
    throw new Error("The public application deployment URL is unavailable.");
  }

  const origin = new URL(
    configured.startsWith("http") ? configured : `https://${configured}`,
  );
  if (
    origin.protocol !== "https:" &&
    !(process.env.NODE_ENV !== "production" && origin.protocol === "http:")
  ) {
    throw new Error("The public application deployment URL must use HTTPS.");
  }
  return origin;
}

export function artifactPageUrl(artifactId: string): string {
  const id = artifactIdSchema.parse(artifactId);
  return new URL(`${ARTIFACT_PAGE_PATH_PREFIX}${id}`, publicApplicationOrigin())
    .toString();
}

export function publicArtifactPageUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    const expectedOrigin = publicApplicationOrigin();
    const artifactId = url.pathname.startsWith(ARTIFACT_PAGE_PATH_PREFIX)
      ? url.pathname.slice(ARTIFACT_PAGE_PATH_PREFIX.length)
      : "";

    return url.origin === expectedOrigin.origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      artifactIdSchema.safeParse(artifactId).success
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
