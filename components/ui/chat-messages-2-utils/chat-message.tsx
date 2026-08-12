import {
  Bot,
  Landmark,
  Radio,
  Search,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type ChatIconName = "bot" | "landmark" | "radio" | "search";

export interface ChatUser {
  accent: string;
  icon: ChatIconName;
  name: string;
  shortName: string;
}

export interface Message {
  detail?: string;
  id: string;
  message: string;
  name: string;
}

const icons: Record<ChatIconName, LucideIcon> = {
  bot: Bot,
  landmark: Landmark,
  radio: Radio,
  search: Search,
};

interface ChatMessageProps {
  currentUser: string;
  message: Message;
  user?: ChatUser;
}

export default function ChatMessage({
  currentUser,
  message,
  user,
}: ChatMessageProps) {
  const isCurrentUser = message.name === currentUser;
  const Icon = user ? icons[user.icon] : Bot;

  return (
    <li
      className={cn(
        "chat-message-enter flex w-full items-end gap-2",
        isCurrentUser ? "justify-end" : "justify-start",
      )}
    >
      {!isCurrentUser && (
        <span
          className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-white/10 text-white"
          style={{ backgroundColor: user?.accent ?? "#3a3a3c" }}
          aria-hidden="true"
        >
          <Icon size={13} strokeWidth={2.2} />
        </span>
      )}

      <div
        className={cn(
          "flex max-w-[228px] flex-col",
          isCurrentUser ? "items-end" : "items-start",
        )}
      >
        {!isCurrentUser && (
          <span className="mb-1 px-1 text-[9px] font-semibold tracking-[0.12em] text-white/45 uppercase">
            {user?.shortName ?? message.name}
          </span>
        )}
        <div
          className={cn(
            "rounded-[18px] px-3 py-2 text-[13px] leading-[1.35] tracking-[-0.01em]",
            isCurrentUser
              ? "rounded-br-[5px] bg-[#0a84ff] text-white"
              : "rounded-bl-[5px] bg-[#3a3a3c] text-white",
          )}
        >
          <p>{message.message}</p>
          {message.detail && (
            <p
              className={cn(
                "mt-1 text-[10px]",
                isCurrentUser ? "text-white/70" : "text-white/45",
              )}
            >
              {message.detail}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
