"use client";

import { useEffect, useRef, useState } from "react";

const CANONICAL_SKILL_URL =
  "https://earnings-call-analyser.vercel.app/skill";
const DEPLOY_URL =
  "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMust-be-Ash%2Fearnings-call-analyser&project-name=eve-agent&repository-name=eve-agent";

type CopyState = "copied" | "error" | "idle";

export function CopyPrompt() {
  const [skillUrl, setSkillUrl] = useState(CANONICAL_SKILL_URL);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const prompt = `Read ${skillUrl} and help me launch my own Eve.`;

  useEffect(() => {
    setSkillUrl(new URL("/skill", window.location.origin).href);
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2_000);
  }

  const buttonLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "error"
        ? "Select text"
        : "Copy prompt";

  return (
    <section className="prompt-block" aria-labelledby="prompt-label">
      <div className="prompt-label">
        <span id="prompt-label">Paste into your coding agent</span>
        <span aria-live="polite">
          {copyState === "copied"
            ? "Ready"
            : copyState === "error"
              ? "Copy unavailable"
              : "One prompt"}
        </span>
      </div>
      <div className="prompt-card">
        <p className="prompt-text">{prompt}</p>
        <button className="copy-button" onClick={copyPrompt} type="button">
          {buttonLabel}
        </button>
      </div>
      <div className="deploy-row">
        <a
          className="deploy-link"
          href={DEPLOY_URL}
          rel="noreferrer"
          target="_blank"
        >
          Or deploy the template on Vercel
        </a>
      </div>
    </section>
  );
}
