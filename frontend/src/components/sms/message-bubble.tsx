"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Check, CheckCheck, Clock, AlertCircle, FileText, Download, SmilePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { SMSMessage } from "@/services/sms-service";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface MessageBubbleProps {
  message: SMSMessage;
  onReact?: (messageId: string, emoji: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  auto_first: "Automatic",
  promotional: "Campaign",
  compliance: "Automatic",
};

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function mediaKind(url: string): "video" | "pdf" | "image" {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".mp4") || clean.endsWith(".3gp") || clean.endsWith(".mov") || clean.endsWith(".webm")) {
    return "video";
  }
  if (clean.endsWith(".pdf")) {
    return "pdf";
  }
  return "image";
}

function fileNameFromUrl(url: string): string {
  try {
    const seg = url.split("?")[0].split("/").pop();
    return seg ? decodeURIComponent(seg) : "Attachment";
  } catch {
    return "Attachment";
  }
}

export function MessageBubble({ message, onReact }: MessageBubbleProps) {
  const isOutbound = message.direction === "outbound";
  const [pickerOpen, setPickerOpen] = useState(false);

  const mediaUrls = message.media_urls || [];
  const reactions = Object.entries(message.reactions || {}).filter(([, users]) => users && users.length > 0);

  const getStatusIcon = () => {
    switch (message.status) {
      case "delivered":
        return <CheckCheck className="h-3.5 w-3.5 text-sky-200" />;
      case "sent":
        return <Check className="h-3.5 w-3.5 text-primary-foreground/75" />;
      case "queued":
      case "sending":
        return <Clock className="h-3 w-3 text-primary-foreground/75" />;
      case "failed":
      case "undelivered":
        return <AlertCircle className="h-3.5 w-3.5 text-red-200" />;
      default:
        return null;
    }
  };

  const reactionTrigger = onReact ? (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="React to message"
          className={cn(
            "self-center rounded-full p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100",
            pickerOpen && "opacity-100 bg-muted text-foreground"
          )}
        >
          <SmilePlus className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align={isOutbound ? "end" : "start"} className="w-auto p-1.5 rounded-full shadow-md">
        <div className="flex items-center gap-0.5">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onReact(message.id, emoji);
                setPickerOpen(false);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-125 hover:bg-muted"
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  ) : null;

  return (
    <div className={cn("group flex flex-col", isOutbound ? "items-end" : "items-start")}>
      <div className={cn("flex items-end gap-1.5 max-w-[82%]", isOutbound ? "flex-row" : "flex-row")}>
        {isOutbound && reactionTrigger}

        <div
          className={cn(
            "rounded-2xl px-3.5 py-2 shadow-xs",
            isOutbound
              ? "bg-primary text-primary-foreground rounded-br-sm"
              : "bg-muted text-foreground rounded-bl-sm"
          )}
        >
          {isOutbound && message.category && CATEGORY_LABELS[message.category] && (
            <p className="text-[10px] font-medium uppercase tracking-wide text-primary-foreground/70 mb-0.5">
              {CATEGORY_LABELS[message.category]}
            </p>
          )}

          {mediaUrls.length > 0 && (
            <div className={cn("space-y-2", message.body && "mb-2")}>
              {mediaUrls.map((url, idx) => {
                const kind = mediaKind(url);
                if (kind === "video") {
                  return (
                    <video
                      key={`${url}-${idx}`}
                      src={url}
                      controls
                      className="max-h-64 w-full rounded-xl bg-black/20"
                    />
                  );
                }
                if (kind === "pdf") {
                  return (
                    <a
                      key={`${url}-${idx}`}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium",
                        isOutbound
                          ? "bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25"
                          : "bg-background text-foreground hover:bg-accent"
                      )}
                    >
                      <FileText className="h-4 w-4 shrink-0" />
                      <span className="truncate max-w-[180px]">{fileNameFromUrl(url)}</span>
                      <Download className="h-3.5 w-3.5 shrink-0 ml-auto" />
                    </a>
                  );
                }
                return (
                  <a
                    key={`${url}-${idx}`}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block overflow-hidden rounded-xl"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt="Attachment"
                      className="max-h-64 max-w-[260px] rounded-xl object-cover hover:opacity-95 transition-opacity"
                      loading="lazy"
                    />
                  </a>
                );
              })}
            </div>
          )}

          {message.body && (
            <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{message.body}</p>
          )}

          {isOutbound && (message.status === "failed" || message.status === "undelivered") && (
            <p className="text-[11px] mt-1 text-red-100">
              Not delivered{message.error_message ? `: ${message.error_message}` : ""}
            </p>
          )}

          <div
            className={cn(
              "flex items-center gap-1 mt-1 text-[10px]",
              isOutbound ? "text-primary-foreground/75 justify-end" : "text-muted-foreground"
            )}
          >
            <span>{format(new Date(message.created_at), "h:mm a")}</span>
            {isOutbound && getStatusIcon()}
          </div>
        </div>

        {!isOutbound && reactionTrigger}
      </div>

      {reactions.length > 0 && (
        <div className={cn("flex flex-wrap gap-1 -mt-1.5 z-10", isOutbound ? "mr-2" : "ml-2")}>
          {reactions.map(([emoji, users]) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onReact?.(message.id, emoji)}
              title={users.join(", ")}
              className="flex items-center gap-1 rounded-full border bg-background px-1.5 py-0.5 text-xs shadow-xs hover:bg-accent transition-colors"
            >
              <span>{emoji}</span>
              {users.length > 1 && <span className="text-[10px] text-muted-foreground">{users.length}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
