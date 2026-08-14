"use client";

import {
  type MouseEvent as ReactMouseEvent,
  useRef,
  useState,
} from "react";

import styles from "./artifact.module.css";

type ImageSaveActionProps = {
  readonly contentType: string;
  readonly downloadUrl: string;
  readonly fileName: string;
  readonly imageUrl: string;
  readonly title: string;
};

function isShareCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function downloadFile(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.download = file.name;
  anchor.href = objectUrl;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function ImageSaveAction({
  contentType,
  downloadUrl,
  fileName,
  imageUrl,
  title,
}: ImageSaveActionProps) {
  const filePromise = useRef<Promise<File> | null>(null);
  const [preparing, setPreparing] = useState(false);

  const prepareFile = () => {
    filePromise.current ??= fetch(imageUrl, { cache: "force-cache" }).then(
      async (response) => {
        if (!response.ok) {
          throw new Error(`Image download failed with ${response.status}.`);
        }
        const blob = await response.blob();
        return new File([blob], fileName, {
          type: blob.type || contentType,
        });
      },
    );
    return filePromise.current;
  };

  const saveImage = async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (preparing) return;
    setPreparing(true);

    try {
      const file = await prepareFile();
      const shareData = { files: [file], title };
      if (
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare(shareData)
      ) {
        try {
          await navigator.share(shareData);
        } catch (error) {
          if (!isShareCancellation(error)) downloadFile(file);
        }
      } else {
        downloadFile(file);
      }
    } catch (error) {
      if (!isShareCancellation(error)) window.location.assign(downloadUrl);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className={styles.imageSaveAction}>
      <a
        aria-disabled={preparing}
        className={styles.artifactButton}
        download={fileName}
        href={downloadUrl}
        onClick={saveImage}
        onPointerDown={() => {
          void prepareFile().catch(() => undefined);
        }}
      >
        {preparing ? "Preparing image…" : "Save or share image"}
      </a>
      <p>
        On iPhone, choose <strong>Save Image</strong> in the share sheet.
      </p>
    </div>
  );
}
