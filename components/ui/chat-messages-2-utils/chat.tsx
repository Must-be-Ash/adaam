"use client";

import { useEffect, useRef } from "react";

import ChatMessage, {
  type ChatUser,
  type Message,
} from "@/components/ui/chat-messages-2-utils/chat-message";

export type User = ChatUser;

interface ChatProps {
  currentUser: string;
  messages: Message[];
  users: User[];
}

export default function Chat({
  currentUser,
  messages,
  users,
}: ChatProps) {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;

    if (messages.length === 0) {
      element.scrollTop = 0;
      return;
    }

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const start = element.scrollTop;
    const target = Math.max(0, element.scrollHeight - element.clientHeight);

    if (reduceMotion || Math.abs(target - start) < 1) {
      element.scrollTop = target;
      return;
    }

    const duration = 800;
    const startedAt = performance.now();
    let frame = 0;

    const scroll = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      element.scrollTop = start + (target - start) * eased;

      if (progress < 1) frame = window.requestAnimationFrame(scroll);
    };

    frame = window.requestAnimationFrame(scroll);
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length]);

  return (
    <div
      ref={viewport}
      className="h-full overflow-y-auto px-3 pt-3 pb-20 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Example messages with Eve strategy agents"
    >
      <ol className="flex flex-col gap-3">
        {messages.map((message) => (
          <ChatMessage
            currentUser={currentUser}
            key={message.id}
            message={message}
            user={users.find((user) => user.name === message.name)}
          />
        ))}
      </ol>
    </div>
  );
}
