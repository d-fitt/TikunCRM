"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { Loader2, ArrowLeft, Ban, ShieldCheck, ShieldAlert } from "lucide-react";
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
import { SMSConsentStatus, SMSMessage, smsService } from "@/services/sms-service";
import { useToast } from "@/hooks/use-toast";
import { useWebSocketEvent } from "@/hooks/use-websocket";

interface ConversationThreadProps {
  leadId: string;
  leadName: string;
  leadPhone?: string | null;
  onBack?: () => void;
  onMessageSent?: () => void;
}

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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<SMSMessage[]>([]);
  const [consent, setConsent] = useState<SMSConsentStatus | null>(null);
  const [loadedContact, setLoadedContact] = useState<{ name: string; phone: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmOptOut, setConfirmOptOut] = useState(false);
  const [optingOut, setOptingOut] = useState(false);

  const loadConversation = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true);
      const conversation = await smsService.getConversation(leadId);
      setMessages(conversation.messages);
      setConsent(conversation.consent ?? null);
      setLoadedContact({ name: conversation.lead_name, phone: conversation.lead_phone });
      setError(null);
    } catch (err) {
      if (!opts?.silent) setError("Failed to load conversation");
      console.error(err);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    loadConversation();
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (body: string) => {
    let errorMessage: string | undefined;
    try {
      const result = await smsService.sendToLead(leadId, body);
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

  const groupedMessages = messages.reduce((groups, message) => {
    const date = new Date(message.created_at);
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
    groups[dateKey].push(message);
    return groups;
  }, {} as Record<string, SMSMessage[]>);

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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No messages yet. Send a message to start the conversation.
          </div>
        ) : (
          Object.entries(groupedMessages).map(([date, msgs]) => (
            <div key={date}>
              <div className="flex items-center gap-4 my-4">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">{date}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <div className="space-y-2">
                {msgs.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {blocked && (
        <div className="border-t bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {consent?.block_reason}
        </div>
      )}

      <MessageComposer
        onSend={handleSend}
        disabled={blocked}
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
