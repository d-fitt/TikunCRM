"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { Loader2, ArrowLeft, Ban, ShieldCheck, ShieldAlert, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MessageBubble } from "./message-bubble";
import { MessageComposer } from "./message-composer";
import { SMSCallLogCard } from "./call-log-card";
import { SMSCallLog, SMSConsentStatus, SMSMessage, smsService } from "@/services/sms-service";
import { useToast } from "@/hooks/use-toast";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import { wsService } from "@/lib/websocket";
import { useCallLeadOptional } from "@/contexts/call-lead-context";
import { useAuthStore } from "@/stores/auth-store";

interface ConversationThreadProps {
  leadId: string;
  leadName: string;
  leadPhone?: string | null;
  onBack?: () => void;
  onMessageSent?: () => void;
}

type ThreadItem =
  | { kind: "message"; id: string; timestamp: string; message: SMSMessage }
  | { kind: "call"; id: string; timestamp: string; call: SMSCallLog };

function errorDetail(err: unknown): string | undefined {
  const e = err as { response?: { data?: { detail?: string } } };
  return typeof e.response?.data?.detail === "string" ? e.response.data.detail : undefined;
}

function ConsentBadge({ consent }: { consent: SMSConsentStatus }) {
  if (consent.opted_out) {
    return (
      <Badge variant="destructive" className="gap-1">
        <Ban className="h-3 w-3" /> Opted out
      </Badge>
    );
  }
  if (consent.inquiry_consent === false) {
    return (
      <Badge variant="outline" className="gap-1 text-amber-700 border-amber-300">
        <ShieldAlert className="h-3 w-3" /> No text consent
      </Badge>
    );
  }
  if (consent.inquiry_consent || consent.promo_consent) {
    return (
      <Badge variant="outline" className="gap-1 text-emerald-700 border-emerald-300">
        <ShieldCheck className="h-3 w-3" />
        {consent.promo_consent ? "Texts + offers" : "Texts only"}
      </Badge>
    );
  }
  return null;
}

export function ConversationThread({ leadId, leadName, leadPhone, onBack, onMessageSent }: ConversationThreadProps) {
  const { toast } = useToast();
  const callLeadCtx = useCallLeadOptional();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false);

  const [messages, setMessages] = useState<SMSMessage[]>([]);
  const [calls, setCalls] = useState<SMSCallLog[]>([]);
  const [consent, setConsent] = useState<SMSConsentStatus | null>(null);
  const [loadedContact, setLoadedContact] = useState<{ name: string; phone: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmOptOut, setConfirmOptOut] = useState(false);
  const [optingOut, setOptingOut] = useState(false);

  // Active typers: userId -> userName
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const typingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const loadConversation = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true);
      const conversation = await smsService.getConversation(leadId);
      setMessages(conversation.messages);
      setCalls(conversation.calls || []);
      setConsent(conversation.consent ?? null);
      setLoadedContact({ name: conversation.lead_name, phone: conversation.lead_phone });
      setError(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("sms:unread-changed"));
        window.dispatchEvent(new CustomEvent("badges:refresh", { detail: { notifications: true } }));
      }
    } catch (err) {
      if (!opts?.silent) setError("Failed to load conversation");
      console.error(err);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  // Tell the server while this chat is open & visible so we don't fire bell/email notifications for it
  useEffect(() => {
    const sendActive = (activeLeadId: string | null) => {
      wsService.send(
        JSON.stringify({
          type: "sms:active_thread",
          payload: { lead_id: activeLeadId },
        })
      );
    };
    const syncVisibility = () => {
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      sendActive(visible ? leadId : null);
    };
    syncVisibility();
    const unsubOpen = wsService.on("connection:open", syncVisibility);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      unsubOpen();
      document.removeEventListener("visibilitychange", syncVisibility);
      sendActive(null);
    };
  }, [leadId]);

  // Clear typing timers when unmounting or switching leads
  useEffect(() => {
    return () => {
      Object.values(typingTimersRef.current).forEach(clearTimeout);
      typingTimersRef.current = {};
    };
  }, [leadId]);

  // Fallback poll so incoming replies/calls appear even if a WebSocket event is missed
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void loadConversation({ silent: true });
      }
    }, 5000);
    return () => clearInterval(id);
  }, [loadConversation]);

  useWebSocketEvent<{ lead_id?: string }>(
    "sms:received",
    useCallback(
      (data) => {
        if (data?.lead_id === leadId) void loadConversation({ silent: true });
      },
      [leadId, loadConversation]
    ),
    [leadId, loadConversation]
  );

  useWebSocketEvent<{ lead_id?: string; message_id?: string; status?: string }>(
    "sms:status",
    useCallback(
      (data) => {
        if (data?.lead_id !== leadId || !data.message_id || !data.status) return;
        if (data.status === "failed" || data.status === "undelivered") {
          void loadConversation({ silent: true });
          return;
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === data.message_id ? { ...m, status: data.status as string } : m))
        );
      },
      [leadId, loadConversation]
    ),
    [leadId, loadConversation]
  );

  useWebSocketEvent<{ lead_id?: string; message_id?: string; reactions?: Record<string, string[]> }>(
    "sms:reaction",
    useCallback(
      (data) => {
        if (data?.lead_id !== leadId || !data.message_id || !data.reactions) return;
        setMessages((prev) =>
          prev.map((m) => (m.id === data.message_id ? { ...m, reactions: data.reactions } : m))
        );
      },
      [leadId]
    ),
    [leadId]
  );

  // Real-time typing indicator
  useWebSocketEvent<{ lead_id?: string; user_id?: string; user_name?: string; is_typing?: boolean }>(
    "sms:typing",
    useCallback(
      (data) => {
        if (!data?.lead_id || String(data.lead_id) !== String(leadId)) return;
        const uid = data.user_id ? String(data.user_id) : "";
        if (!uid || (currentUserId && uid === String(currentUserId))) return;

        if (typingTimersRef.current[uid]) {
          clearTimeout(typingTimersRef.current[uid]);
          delete typingTimersRef.current[uid];
        }

        if (data.is_typing) {
          const name = data.user_name || "Someone";
          setTypingUsers((prev) => ({ ...prev, [uid]: name }));
          typingTimersRef.current[uid] = setTimeout(() => {
            setTypingUsers((prev) => {
              const next = { ...prev };
              delete next[uid];
              return next;
            });
            delete typingTimersRef.current[uid];
          }, 4000);
        } else {
          setTypingUsers((prev) => {
            if (!(uid in prev)) return prev;
            const next = { ...prev };
            delete next[uid];
            return next;
          });
        }
      },
      [leadId, currentUserId]
    ),
    [leadId, currentUserId]
  );

  // Real-time call completed events - add incoming & outgoing calls to timeline immediately
  useWebSocketEvent<{
    call_log_id?: string;
    lead_id?: string;
    call?: {
      id: string;
      direction: string;
      from_number: string;
      to_number: string;
      status: string;
      duration_seconds: number | null;
      outcome: string | null;
      notes: string | null;
      recording_url: string | null;
      started_at: string | null;
      ended_at: string | null;
    };
  }>(
    "call:completed",
    useCallback(
      (data) => {
        if (!data?.lead_id || String(data.lead_id) !== String(leadId) || !data.call) return;
        const c = data.call;
        const newCall: SMSCallLog = {
          id: c.id,
          direction: c.direction,
          from_number: c.from_number,
          to_number: c.to_number,
          status: c.status,
          duration_seconds: c.duration_seconds ?? 0,
          recording_url: c.recording_url,
          recording_duration_seconds: null,
          notes: c.notes,
          outcome: c.outcome,
          started_at: c.started_at || new Date().toISOString(),
          answered_at: null,
          ended_at: c.ended_at,
        };
        setCalls((prev) => {
          const idx = prev.findIndex((item) => item.id === newCall.id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = { ...copy[idx], ...newCall };
            return copy;
          }
          return [...prev, newCall];
        });
      },
      [leadId]
    ),
    [leadId]
  );

  // Real-time call recording ready - attach recording player to existing call card
  useWebSocketEvent<{
    call_log_id?: string;
    lead_id?: string;
    recording_url?: string;
    recording_duration_seconds?: number;
  }>(
    "call:recording_ready",
    useCallback(
      (data) => {
        if (!data?.lead_id || String(data.lead_id) !== String(leadId) || !data.call_log_id) return;
        setCalls((prev) =>
          prev.map((c) =>
            c.id === data.call_log_id
              ? {
                  ...c,
                  recording_url: data.recording_url ?? c.recording_url,
                  recording_duration_seconds: data.recording_duration_seconds ?? c.recording_duration_seconds,
                  duration_seconds: data.recording_duration_seconds || c.duration_seconds,
                }
              : c
          )
        );
      },
      [leadId]
    ),
    [leadId]
  );

  const timelineItems = useMemo<ThreadItem[]>(() => {
    const items: ThreadItem[] = [
      ...messages.map((m): ThreadItem => ({
        kind: "message",
        id: `msg-${m.id}`,
        timestamp: m.created_at,
        message: m,
      })),
      ...calls.map((c): ThreadItem => ({
        kind: "call",
        id: `call-${c.id}`,
        timestamp: c.started_at,
        call: c,
      })),
    ];
    items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return items;
  }, [messages, calls]);

  const activeTypers = Object.values(typingUsers);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Reset initial-scroll flag whenever the selected lead changes
  useEffect(() => {
    initialScrollDoneRef.current = false;
    isNearBottomRef.current = true;
  }, [leadId]);

  // Snap to the bottommost message/call on initial load and when new items arrive while near bottom
  useEffect(() => {
    if (loading) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      requestAnimationFrame(() => scrollToBottom(false));
      const t1 = window.setTimeout(() => {
        if (isNearBottomRef.current) scrollToBottom(false);
      }, 150);
      const t2 = window.setTimeout(() => {
        if (isNearBottomRef.current) scrollToBottom(false);
      }, 450);
      return () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
      };
    }
    if (isNearBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom(true));
    }
  }, [loading, timelineItems.length, activeTypers.length, scrollToBottom]);

  // Keep pinned to bottom when lazy-loaded images or audio cards expand height
  useEffect(() => {
    if (loading) return;
    const contentEl = timelineContentRef.current;
    if (!contentEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        scrollToBottom(false);
      }
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [loading, leadId, scrollToBottom]);

  const handleTypingChange = useCallback(
    (isTyping: boolean) => {
      wsService.send(
        JSON.stringify({
          type: "sms:typing",
          payload: { lead_id: leadId, is_typing: isTyping },
        })
      );
    },
    [leadId]
  );

  const handleReact = async (messageId: string, emoji: string) => {
    try {
      const res = await smsService.toggleReaction(messageId, emoji);
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions: res.reactions } : m))
      );
    } catch (err) {
      toast({
        title: "Could not react",
        description: errorDetail(err) || "Please try again",
        variant: "destructive",
      });
    }
  };

  const handleSend = async (body: string, mediaUrls?: string[], mediaContentTypes?: string[]) => {
    let errorMessage: string | undefined;
    try {
      const result = await smsService.sendToLead(leadId, body, mediaUrls, mediaContentTypes);
      if (result.success && result.message_id) {
        const newMessage: SMSMessage = {
          id: result.message_id,
          lead_id: leadId,
          user_id: null,
          direction: "outbound",
          from_number: "",
          to_number: leadPhone || "",
          body,
          status: "sent",
          is_read: true,
          created_at: new Date().toISOString(),
          sent_at: new Date().toISOString(),
          delivered_at: null,
          category: "conversation",
          media_urls: mediaUrls || [],
          media_content_types: mediaContentTypes || [],
          reactions: {},
        };
        setMessages((prev) => [...prev, newMessage]);
        onMessageSent?.();
        return;
      }
      errorMessage = result.error;
    } catch (err) {
      errorMessage = errorDetail(err);
    }
    toast({
      title: "Text not sent",
      description: errorMessage || "Could not send message",
      variant: "destructive",
    });
    void loadConversation({ silent: true });
    throw new Error(errorMessage || "send failed");
  };

  const handleOptOut = async () => {
    setOptingOut(true);
    try {
      setConsent(await smsService.markOptedOut(leadId));
      toast({ title: "Texts stopped", description: "This customer won't receive any more texts." });
    } catch (err) {
      toast({ title: "Could not update", description: errorDetail(err), variant: "destructive" });
    } finally {
      setOptingOut(false);
      setConfirmOptOut(false);
    }
  };

  const groupedItems = timelineItems.reduce((groups, item) => {
    const date = new Date(item.timestamp);
    let dateKey: string;
    if (isToday(date)) {
      dateKey = "Today";
    } else if (isYesterday(date)) {
      dateKey = "Yesterday";
    } else {
      dateKey = format(date, "MMMM d, yyyy");
    }
    if (!groups[dateKey]) {
      groups[dateKey] = [];
    }
    groups[dateKey].push(item);
    return groups;
  }, {} as Record<string, ThreadItem[]>);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full text-center p-4">
        <p className="text-muted-foreground mb-4">{error}</p>
        <Button onClick={() => loadConversation()}>Retry</Button>
      </div>
    );
  }

  const blocked = consent ? !consent.can_text : false;
  const displayName = leadName || loadedContact?.name || "";
  const displayPhone = leadPhone || loadedContact?.phone || null;

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold truncate">{displayName}</h2>
            {consent && <ConsentBadge consent={consent} />}
          </div>
          {displayPhone && (
            <p className="text-sm text-muted-foreground">{displayPhone}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {displayPhone && callLeadCtx && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                callLeadCtx.setCallLead({
                  phone: displayPhone,
                  leadId,
                  leadName: displayName,
                });
                toast({
                  title: "Opening softphone...",
                  description: `Calling ${displayName}`,
                });
              }}
              title={`Call ${displayName}`}
            >
              <Phone className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Call</span>
            </Button>
          )}

          {consent && !consent.opted_out && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setConfirmOptOut(true)}
            >
              <Ban className="h-4 w-4 mr-1" /> Do not text
            </Button>
          )}
        </div>
      </div>

      {/* Messages & Calls Timeline */}
      <div
        ref={scrollContainerRef}
        onScroll={() => {
          const el = scrollContainerRef.current;
          if (!el) return;
          isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="flex-1 overflow-y-auto p-4"
      >
        <div ref={timelineContentRef} className="space-y-4">
        {timelineItems.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No messages yet. Send a message to start the conversation.
          </div>
        ) : (
          Object.entries(groupedItems).map(([date, items]) => (
            <div key={date}>
              <div className="flex items-center gap-4 my-4">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">{date}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <div className="space-y-3">
                {items.map((item) =>
                  item.kind === "message" ? (
                    <MessageBubble key={item.id} message={item.message} onReact={handleReact} />
                  ) : (
                    <SMSCallLogCard key={item.id} call={item.call} />
                  )
                )}
              </div>
            </div>
          ))
        )}

        {activeTypers.length > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-bounce [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-bounce [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-bounce" />
              </span>
              <span>
                {activeTypers.length === 1
                  ? `${activeTypers[0]} is typing...`
                  : `${activeTypers.slice(0, 2).join(" and ")} are typing...`}
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>
      </div>

      {blocked && (
        <div className="border-t bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {consent?.block_reason}
        </div>
      )}

      <MessageComposer
        onSend={handleSend}
        disabled={blocked}
        enableEmoji
        enableMedia
        enableVoice
        onTypingChange={handleTypingChange}
        placeholder={blocked ? "Texting is blocked for this customer" : "Type a message..."}
      />

      <AlertDialog open={confirmOptOut} onOpenChange={setConfirmOptOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop texting {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Use this when the customer asked not to be texted (for example on a call). No one will be able to
              text them, including campaigns, until they text START to your number.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={optingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleOptOut} disabled={optingOut}>
              {optingOut && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Stop texts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
