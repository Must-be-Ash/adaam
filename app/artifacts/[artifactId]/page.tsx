import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { readArtifactManifest } from "@/agent/lib/artifact-store";

import styles from "./artifact.module.css";
import { ImageSaveAction } from "./image-save-action";
import { ResearchReportView } from "./report";

export const dynamic = "force-dynamic";

type ArtifactPageProps = {
  readonly params: Promise<{ artifactId: string }>;
};

const loadArtifact = cache(readArtifactManifest);

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export async function generateMetadata({
  params,
}: ArtifactPageProps): Promise<Metadata> {
  const { artifactId } = await params;
  const artifact = await loadArtifact(artifactId);
  if (!artifact) {
    return {
      robots: { follow: false, index: false },
      title: "Artifact not found",
    };
  }

  const image =
    artifact.kind === "image"
      ? [{ alt: artifact.title, url: artifact.media.url }]
      : undefined;
  return {
    description: artifact.description,
    openGraph: {
      description: artifact.description,
      images: image,
      title: artifact.title,
      type: "website",
    },
    robots: { follow: false, index: false },
    title: artifact.title,
    twitter: {
      card: image ? "summary_large_image" : "summary",
      description: artifact.description,
      images: image?.map(({ url }) => url),
      title: artifact.title,
    },
  };
}

export default async function ArtifactPage({ params }: ArtifactPageProps) {
  const { artifactId } = await params;
  const artifact = await loadArtifact(artifactId);
  if (!artifact) notFound();

  if (artifact.kind === "report" || artifact.kind === "chart") {
    return (
      <div className={styles.artifactShell}>
        <ResearchReportView
          presentation={artifact.kind}
          report={artifact.report}
        />
      </div>
    );
  }

  const { media } = artifact;
  return (
    <div className={styles.artifactShell}>
      <main className={styles.mediaPage}>
        <header className={styles.mediaHeader}>
          <p className={styles.eyebrow}>Eve · {artifact.kind} artifact</p>
          <h1>{artifact.title}</h1>
          <p>{artifact.description}</p>
        </header>

        <section className={styles.mediaCard}>
          {artifact.kind === "image" ? (
            // Blob dimensions are not known at publication time.
            // eslint-disable-next-line @next/next/no-img-element
            <img alt={artifact.title} src={media.url} />
          ) : artifact.kind === "audio" ? (
            <audio controls preload="metadata" src={media.url}>
              <track kind="captions" />
            </audio>
          ) : artifact.kind === "video" ? (
            <video controls playsInline preload="metadata" src={media.url}>
              <track kind="captions" />
            </video>
          ) : (
            <div className={styles.filePanel}>
              <p className={styles.eyebrow}>
                {artifact.kind === "pdf" ? "PDF document" : "Downloadable file"}
              </p>
              <strong>{media.fileName}</strong>
              <span>
                {formatBytes(media.byteLength)} · {media.contentType}
              </span>
              <a
                className={styles.artifactButton}
                download={
                  artifact.kind === "file" ? media.fileName : undefined
                }
                href={
                  artifact.kind === "pdf" ? media.url : media.downloadUrl
                }
              >
                {artifact.kind === "pdf" ? "Open PDF" : "Download file"}
              </a>
            </div>
          )}
        </section>

        {artifact.kind === "image" ? (
          <ImageSaveAction
            contentType={media.contentType}
            downloadUrl={media.downloadUrl}
            fileName={media.fileName}
            imageUrl={media.url}
            title={artifact.title}
          />
        ) : artifact.kind === "audio" || artifact.kind === "video" ? (
          <a
            className={styles.artifactButton}
            download={media.fileName}
            href={media.downloadUrl}
          >
            Download original
          </a>
        ) : null}
      </main>
    </div>
  );
}
