"use client";

import { format, isToday, isYesterday } from "date-fns";
import { MessageSquare, User, Image as ImageIcon, Video, Mic, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationListItem } from "@/services/sms-service";
import { Badge } from "@/components/ui/badge";
import { classifyMedia, mediaLabel, MediaKind } from "./media-utils";

interface ConversationListProps {
  conversations: ConversationListItem[];
  selectedLeadId?: string;
  onSelect: (leadId: string) => void;
  typingByLead?: Record<string, string[]>;
}

function MediaTypeIcon({ kind }: { kind: MediaKind }) {
  switch (kind) {
    case "audio":
      return <Mic className="h-3.5 w-3.5 shrink-0" />;
    case "video":
      return <Video className="h-3.5 w-3.5 shrink-0" />;
    case "document":
      return <FileText className="h-3.5 w-3.5 shrink-0" />;
    case "image":
    default:
      return <ImageIcon className="h-3.5 w-3.5 shrink-0" />;
  }
}

function inferKindFromPlaceholder(body: string): MediaKind | null {
  const b = body.trim().toLowerCase();
  if (b === "[audio]" || b === "[voice message]") return "audio";
  if (b === "[video]") return "video";
  if (b === "[document]" || b === "[pdf]") return "document";
  if (b === "[image]" || b === "[photo]") return "image";
  return null;
}

export function ConversationList({
  conversations,
  selectedLeadId,
  onSelect,
  typingByLead = {},
}: ConversationListProps) {
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    if (isToday(date)) {
      return format(date, "h:mm a");
    }
    if (isYesterday(date)) {
      return "Yesterday";
    }
    return format(date, "MMM d");
  };

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <MessageSquare className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">No conversations yet</p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {conversations.map((conversation) => {
        const typers = typingByLead[conversation.lead_id] || [];
        const isTyping = typers.length > 0;
        const last = conversation.last_message;
        const mediaUrls = last.media_urls || [];
        const mediaTypes = last.media_content_types || [];
        const hasMedia = mediaUrls.length > 0;

        let mediaKind: MediaKind | null = null;
        if (hasMedia) {
          mediaKind = classifyMedia(mediaUrls[0], mediaTypes[0]);
        } else if (last.body) {
          mediaKind = inferKindFromPlaceholder(last.body);
        }

        const isPlaceholderBody =
          !last.body ||
          ["[attachment]", "[image]", "[photo]", "[video]", "[audio]", "[voice message]", "[document]"].includes(
            last.body.trim().toLowerCase()
          );

        return (
          <button
            key={conversation.lead_id}
            onClick={() => onSelect(conversation.lead_id)}
            className={cn(
              "w-full flex items-start gap-3 p-4 text-left hover:bg-muted/50 transition-colors",
              selectedLeadId === conversation.lead_id && "bg-muted"
            )}
          >
            {/* Avatar */}
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <User className="h-5 w-5 text-primary" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{conversation.lead_name}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatTime(last.created_at)}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 mt-0.5">
                {isTyping ? (
                  <p className="text-sm text-primary italic truncate">
                    {typers.length === 1 ? `${typers[0]} is typing...` : `${typers[0]} and others are typing...`}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground truncate flex items-center gap-1 min-w-0">
                    {last.direction === "outbound" && (
                      <span className="text-muted-foreground shrink-0">You:</span>
                    )}
                    {mediaKind ? (
                      <>
                        <MediaTypeIcon kind={mediaKind} />
                        <span className="truncate">
                          {isPlaceholderBody ? mediaLabel(mediaKind) : last.body}
                        </span>
                      </>
                    ) : (
                      <span className="truncate">{last.body}</span>
                    )}
                  </p>
                )}

                {conversation.unread_count > 0 && (
                  <Badge variant="default" className="shrink-0 h-5 min-w-[20px] flex items-center justify-center">
                    {conversation.unread_count}
                  </Badge>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
