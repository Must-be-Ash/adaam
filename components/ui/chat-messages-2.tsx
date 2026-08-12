"use client";

import { useEffect, useState } from "react";

import Chat, { type User } from "@/components/ui/chat-messages-2-utils/chat";
import type { Message } from "@/components/ui/chat-messages-2-utils/chat-message";
import IphoneFrame from "@/components/ui/chat-messages-2-utils/iphone-frame";

const users: User[] = [
  {
    accent: "#4b5563",
    icon: "landmark",
    name: "Pelosi Watch",
    shortName: "Pelosi Watch",
  },
  {
    accent: "#7c4a3b",
    icon: "radio",
    name: "Inverse Cramer",
    shortName: "Inverse Cramer",
  },
  {
    accent: "#505056",
    icon: "bot",
    name: "Eve",
    shortName: "Eve",
  },
];

const conversation: Message[] = [
  {
    id: "start-strategy",
    message: "Run Pelosi Watch on NVDA and TSLA.",
    name: "You",
  },
  {
    detail: "Strategy live · NVDA + TSLA",
    id: "strategy-live",
    message: "Done. I’ll monitor new disclosures and momentum.",
    name: "Eve",
  },
  {
    detail: "Public filing · NVDA",
    id: "signal-pelosi",
    message: "New filing: NVDA calls reported. Source verified.",
    name: "Pelosi Watch",
  },
  {
    id: "prepare-nvda",
    message: "Prepare a $500 NVDA buy. Keep TSLA watching.",
    name: "You",
  },
  {
    detail: "Order preview · NVDA",
    id: "nvda-preview",
    message: "$500 NVDA order ready at market. Approve?",
    name: "Eve",
  },
  {
    id: "approve-nvda",
    message: "Approve NVDA.",
    name: "You",
  },
  {
    detail: "Order submitted · TSLA still watching",
    id: "nvda-submitted",
    message: "NVDA order submitted.",
    name: "Eve",
  },
  {
    id: "start-inverse-cramer",
    message: "Start Inverse Cramer too.",
    name: "You",
  },
  {
    detail: "2 strategies running in parallel",
    id: "inverse-cramer-live",
    message: "Inverse Cramer is live alongside Pelosi Watch.",
    name: "Eve",
  },
  {
    detail: "Inverse signal · order preview",
    id: "signal-cramer",
    message: "Cramer turned bearish on BTC. $250 inverse order ready. Approve?",
    name: "Inverse Cramer",
  },
  {
    id: "approve-order",
    message: "Approve.",
    name: "You",
  },
  {
    detail: "Order submitted · strategies still live",
    id: "btc-submitted",
    message: "BTC order submitted. Both strategies keep running.",
    name: "Eve",
  },
];

export default function ChatMessages() {
  const [visibleCount, setVisibleCount] = useState(0);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (reduceMotion) {
      if (isResetting) setIsResetting(false);
      if (visibleCount < conversation.length) {
        setVisibleCount(conversation.length);
      }
      return;
    }

    let delay = visibleCount === 0 ? 700 : 2_000;
    let next = () => {
      setVisibleCount((count) => Math.min(count + 1, conversation.length));
    };

    if (isResetting) {
      delay = 850;
      next = () => {
        setVisibleCount(0);
        setIsResetting(false);
      };
    } else if (visibleCount >= conversation.length) {
      delay = 6_000;
      next = () => setIsResetting(true);
    }

    const timer = window.setTimeout(next, delay);

    return () => window.clearTimeout(timer);
  }, [isResetting, visibleCount]);

  return (
    <div
      className="relative flex items-center justify-center"
      aria-label="Eve in iMessage"
    >
      <div
        className="mx-auto h-[430px] w-[300px] overflow-hidden sm:h-[500px] sm:w-[350px] lg:h-[560px]"
        style={{
          maskImage:
            "linear-gradient(to bottom, black 0%, black 78%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 0%, black 78%, transparent 100%)",
        }}
      >
        <IphoneFrame>
          <div
            className={`h-full transition-opacity duration-700 ease-in-out motion-reduce:transition-none ${
              isResetting ? "opacity-0" : "opacity-100"
            }`}
          >
            <Chat
              currentUser="You"
              messages={conversation.slice(0, visibleCount)}
              users={users}
            />
          </div>
        </IphoneFrame>
      </div>
    </div>
  );
}
