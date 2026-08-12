"use client";

import { Check, Copy as CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const CANONICAL_SKILL_URL =
  "https://earnings-call-analyser.vercel.app/skill";

type CopyState = "copied" | "error" | "idle";

export function CopyPrompt() {
  const [skillUrl, setSkillUrl] = useState(CANONICAL_SKILL_URL);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const prompt = `Read ${skillUrl} & help me launch my own agent.`;

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

  const copyLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "error"
        ? "Copy unavailable. Select the prompt manually."
        : "Copy prompt";

  return (
    <section className="prompt-block" aria-labelledby="prompt-label">
      <div className="prompt-card">
        <p className="prompt-text">{prompt}</p>
        <button
          aria-label={copyLabel}
          className="copy-button"
          onClick={copyPrompt}
          title={copyLabel}
          type="button"
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" size={18} strokeWidth={2.2} />
          ) : (
            <CopyIcon aria-hidden="true" size={17} strokeWidth={2} />
          )}
        </button>
        <span className="sr-only" aria-live="polite">
          {copyState === "copied"
            ? "Prompt copied"
            : copyState === "error"
              ? "Copy unavailable"
              : ""}
        </span>
      </div>
      <p className="prompt-label" id="prompt-label">
        Paste into your coding agent
      </p>
    </section>
  );
}
