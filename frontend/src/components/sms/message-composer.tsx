"use client";

import { useState, useRef, useEffect, KeyboardEvent, ClipboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Send, Loader2, Smile, Paperclip, X, FileText, Film, Mic, Square, Play, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { smsService } from "@/services/sms-service";
import { useToast } from "@/hooks/use-toast";

export interface ComposerAttachment {
  url: string;
  contentType: string;
  filename: string;
}

interface MessageComposerProps {
  onSend: (message: string, mediaUrls?: string[], mediaContentTypes?: string[]) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  /** Merged onto the root row (e.g. WhatsApp dark composer). */
  className?: string;
  /** Show the emoji picker button (enabled by default). */
  enableEmoji?: boolean;
  /** Show the MMS media attachment button (images, videos, audio, documents). */
  enableMedia?: boolean;
  /** Show the inline voice/audio recorder button (SMS MMS audio). */
  enableVoice?: boolean;
  /** Called when the user starts or stops typing. */
  onTypingChange?: (isTyping: boolean) => void;
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

type RecordingState = "idle" | "recording" | "recorded";

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function MessageComposer({
  onSend,
  disabled,
  placeholder = "Type a message...",
  className,
  enableEmoji = true,
  enableMedia = false,
  enableVoice = false,
  onTypingChange,
}: MessageComposerProps) {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Typing indicator refs
  const isTypingRef = useRef(false);
  const lastTypingEmitRef = useRef(0);
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTypingChangeRef = useRef(onTypingChange);
  onTypingChangeRef.current = onTypingChange;

  // Voice recording state
  const [recState, setRecState] = useState<RecordingState>("idle");
  const [recDuration, setRecDuration] = useState(0);
  const [recAudioUrl, setRecAudioUrl] = useState<string | null>(null);
  const [recPlaying, setRecPlaying] = useState(false);
  const [recSending, setRecSending] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recAudioRef = useRef<HTMLAudioElement>(null);

  const stopTypingSignal = () => {
    if (typingStopTimerRef.current) {
      clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      onTypingChangeRef.current?.(false);
    }
  };

  const notifyTyping = (hasText: boolean) => {
    if (!onTypingChangeRef.current) return;
    if (!hasText) {
      stopTypingSignal();
      return;
    }
    const now = Date.now();
    if (!isTypingRef.current || now - lastTypingEmitRef.current > 2000) {
      isTypingRef.current = true;
      lastTypingEmitRef.current = now;
      onTypingChangeRef.current(true);
    }
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(() => {
      stopTypingSignal();
    }, 2500);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTypingSignal();
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (recAudioUrl) URL.revokeObjectURL(recAudioUrl);
    };
  }, [recAudioUrl]);

  const canSend = (message.trim().length > 0 || attachments.length > 0) && !disabled && !sending && !uploading;

  const handleSend = async () => {
    const trimmed = message.trim();
    if ((!trimmed && attachments.length === 0) || sending || uploading || disabled) return;

    stopTypingSignal();
    const mediaUrls = attachments.map((a) => a.url);
    const mediaContentTypes = attachments.map((a) => a.contentType);
    setSending(true);
    try {
      await onSend(
        trimmed,
        mediaUrls.length > 0 ? mediaUrls : undefined,
        mediaContentTypes.length > 0 ? mediaContentTypes : undefined
      );
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
    const val = e.target.value;
    setMessage(val);
    notifyTyping(val.trim().length > 0);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  };

  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    if (!el) {
      setMessage((prev) => prev + emoji);
      notifyTyping(true);
      return;
    }
    const start = el.selectionStart ?? message.length;
    const end = el.selectionEnd ?? message.length;
    const next = message.slice(0, start) + emoji + message.slice(end);
    setMessage(next);
    notifyTyping(next.trim().length > 0);
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

  // Voice recording controls
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setRecAudioUrl(url);
        setRecState("recorded");
      };

      recorder.start(100);
      setRecState("recording");
      setRecDuration(0);
      recTimerRef.current = setInterval(() => {
        setRecDuration((prev) => prev + 1);
      }, 1000);
    } catch {
      toast({
        title: "Microphone access denied",
        description: "Please allow microphone access to record audio messages.",
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recState === "recording") {
      mediaRecorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recTimerRef.current) {
        clearInterval(recTimerRef.current);
        recTimerRef.current = null;
      }
    }
  };

  const cancelRecording = () => {
    if (recState === "recording") {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recTimerRef.current) {
        clearInterval(recTimerRef.current);
        recTimerRef.current = null;
      }
    }
    if (recAudioUrl) URL.revokeObjectURL(recAudioUrl);
    setRecAudioUrl(null);
    setRecDuration(0);
    setRecPlaying(false);
    setRecState("idle");
    chunksRef.current = [];
  };

  const toggleRecPlayback = () => {
    if (!recAudioRef.current) return;
    if (recPlaying) {
      recAudioRef.current.pause();
      setRecPlaying(false);
    } else {
      void recAudioRef.current.play();
      setRecPlaying(true);
    }
  };

  const handleSendVoice = async () => {
    if (chunksRef.current.length === 0 || recSending) return;
    const rawMime = mediaRecorderRef.current?.mimeType || "audio/webm";
    const baseMime = rawMime.split(";")[0].trim();
    const ext = baseMime.includes("ogg")
      ? "ogg"
      : baseMime.includes("mp4")
        ? "m4a"
        : baseMime.includes("webm")
          ? "webm"
          : "wav";
    const blob = new Blob(chunksRef.current, { type: baseMime });
    if (blob.size === 0) return;

    const file = new File([blob], `voice-audio-${Date.now()}.${ext}`, { type: baseMime });
    setRecSending(true);
    try {
      const uploaded = await smsService.uploadMedia(file);
      await onSend("", [uploaded.url], [uploaded.content_type]);
      cancelRecording();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } } };
      toast({
        title: "Audio send failed",
        description: e.response?.data?.detail || "Could not send audio message.",
        variant: "destructive",
      });
    } finally {
      setRecSending(false);
    }
  };

  return (
    <div className={cn("border-t bg-background", className)}>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {attachments.map((att, idx) => {
            const isImage = att.contentType.startsWith("image/");
            const isVideo = att.contentType.startsWith("video/");
            const isAudio = att.contentType.startsWith("audio/");
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
                ) : isAudio ? (
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-muted">
                    <Mic className="h-5 w-5 text-muted-foreground" />
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

      {recState !== "idle" ? (
        <div className="flex items-center gap-2.5 p-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={cancelRecording}
            disabled={recSending}
            className="text-destructive hover:text-destructive shrink-0"
            title="Cancel recording"
          >
            <X className="h-5 w-5" />
          </Button>

          {recState === "recording" ? (
            <>
              <span className="h-2.5 w-2.5 rounded-full bg-destructive animate-pulse shrink-0" />
              <span className="text-sm font-medium text-destructive">Recording audio...</span>
              <span className="ml-auto text-sm font-mono tabular-nums text-muted-foreground">
                {formatDuration(recDuration)}
              </span>
              <Button
                type="button"
                variant="destructive"
                size="icon"
                onClick={stopRecording}
                className="shrink-0 rounded-full"
                title="Stop recording"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            </>
          ) : (
            <>
              {recAudioUrl && (
                <audio
                  ref={recAudioRef}
                  src={recAudioUrl}
                  onEnded={() => setRecPlaying(false)}
                  preload="metadata"
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={toggleRecPlayback}
                className="shrink-0 rounded-full h-9 w-9"
                title={recPlaying ? "Pause" : "Play preview"}
              >
                {recPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                )}
              </Button>
              <span className="text-sm text-muted-foreground flex-1 truncate">
                Audio message ({formatDuration(recDuration)})
              </span>
              <Button
                type="button"
                size="icon"
                onClick={() => void handleSendVoice()}
                disabled={recSending}
                className="shrink-0"
                title="Send audio"
              >
                {recSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-end gap-1.5 p-3">
          {enableMedia && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/aac,audio/webm,audio/amr,.mp3,.m4a,.ogg,.wav,.aac,.amr,application/pdf,.doc,.docx,.txt,.csv,.vcf"
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
                title="Attach image, video, audio, or document (max 5MB)"
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

          {enableVoice && !canSend && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || uploading}
              onClick={() => void startRecording()}
              title="Record audio message"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Mic className="h-5 w-5" />
            </Button>
          )}

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
      )}
    </div>
  );
}
