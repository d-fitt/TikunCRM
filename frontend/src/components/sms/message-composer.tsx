"use client";

import { useState, useRef, KeyboardEvent, ClipboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Send, Loader2, Smile, Paperclip, X, FileText, Film } from "lucide-react";
import { cn } from "@/lib/utils";
import { smsService } from "@/services/sms-service";
import { useToast } from "@/hooks/use-toast";

export interface ComposerAttachment {
  url: string;
  contentType: string;
  filename: string;
}

interface MessageComposerProps {
  onSend: (message: string, mediaUrls?: string[]) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  /** Merged onto the root row (e.g. WhatsApp dark composer). */
  className?: string;
  /** Show the emoji picker button (enabled by default). */
  enableEmoji?: boolean;
  /** Show the MMS media attachment button (images, videos, PDFs). */
  enableMedia?: boolean;
}

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Smileys",
    emojis: ["😀", "😊", "😄", "😁", "😅", "😂", "🙂", "😉", "😍", "🥳", "😎", "🤩", "🙏", "👍", "👏", "🤝"],
  },
  {
    label: "Cars & Deals",
    emojis: ["🚗", "🚙", "🏎️", "🚕", "🛻", "🚐", "🔑", "🛞", "⛽", "📍", "📅", "⏰", "💵", "🎉", "🔥", "⭐"],
  },
  {
    label: "Reactions",
    emojis: ["❤️", "💙", "💚", "💯", "✅", "❌", "⚡", "🙌", "👌", "🤞", "💪", "📞", "💬", "📸", "📄", "✨"],
  },
];

export function MessageComposer({
  onSend,
  disabled,
  placeholder = "Type a message...",
  className,
  enableEmoji = true,
  enableMedia = false,
}: MessageComposerProps) {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSend = (message.trim().length > 0 || attachments.length > 0) && !disabled && !sending && !uploading;

  const handleSend = async () => {
    const trimmed = message.trim();
    if ((!trimmed && attachments.length === 0) || sending || uploading || disabled) return;

    const mediaUrls = attachments.map((a) => a.url);
    setSending(true);
    try {
      await onSend(trimmed, mediaUrls.length > 0 ? mediaUrls : undefined);
      setMessage("");
      setAttachments([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } catch {
      // Keep the draft so the agent can retry; the caller shows the error
    } finally {
      setSending(false);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  };

  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    if (!el) {
      setMessage((prev) => prev + emoji);
      return;
    }
    const start = el.selectionStart ?? message.length;
    const end = el.selectionEnd ?? message.length;
    const next = message.slice(0, start) + emoji + message.slice(end);
    setMessage(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, Math.max(0, 4 - attachments.length));
    if (list.length === 0) return;

    setUploading(true);
    try {
      for (const file of list) {
        if (file.size > 5 * 1024 * 1024) {
          toast({
            title: "File too large",
            description: `${file.name} exceeds the 5MB MMS limit.`,
            variant: "destructive",
          });
          continue;
        }
        const uploaded = await smsService.uploadMedia(file);
        setAttachments((prev) => [
          ...prev,
          { url: uploaded.url, contentType: uploaded.content_type, filename: uploaded.filename },
        ]);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } } };
      toast({
        title: "Upload failed",
        description: e.response?.data?.detail || "Could not upload attachment.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!enableMedia || disabled) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length > 0) {
      e.preventDefault();
      void uploadFiles(imageFiles);
    }
  };

  return (
    <div className={cn("border-t bg-background", className)}>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {attachments.map((att, idx) => {
            const isImage = att.contentType.startsWith("image/");
            const isVideo = att.contentType.startsWith("video/");
            return (
              <div
                key={`${att.url}-${idx}`}
                className="relative group flex items-center gap-2 rounded-lg border bg-muted/50 p-1.5 pr-7"
              >
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={att.url} alt={att.filename} className="h-12 w-12 rounded object-cover" />
                ) : isVideo ? (
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-muted">
                    <Film className="h-5 w-5 text-muted-foreground" />
                  </div>
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-muted">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <span className="max-w-[120px] truncate text-xs text-muted-foreground">{att.filename}</span>
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 text-muted-foreground hover:text-foreground shadow-xs"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-1.5 p-3">
        {enableMedia && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void uploadFiles(e.target.files);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || uploading || attachments.length >= 4}
              onClick={() => fileInputRef.current?.click()}
              title="Attach photo, video, or PDF (max 5MB)"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
            </Button>
          </>
        )}

        {enableEmoji && (
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                title="Insert emoji"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Smile className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-72 p-3">
              <div className="space-y-2.5">
                {EMOJI_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>
                    <div className="grid grid-cols-8 gap-0.5">
                      {group.emojis.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => {
                            insertEmoji(emoji);
                            setEmojiOpen(false);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-muted transition-colors"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}

        <Textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled || sending}
          className="min-h-[40px] max-h-[120px] resize-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:ring-0 focus:outline-none"
          rows={1}
        />
        <Button
          type="button"
          size="icon"
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="shrink-0"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
