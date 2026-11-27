"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, MessageSquare, RefreshCw, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConversationList, ConversationThread } from "@/components/sms";
import { CampaignsPanel } from "@/components/sms/campaigns-panel";
import { ConversationListItem, SMSConfig, SMSLeadSearchItem, smsService } from "@/services/sms-service";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import { useAuthStore } from "@/stores/auth-store";

const CAMPAIGN_ROLES = new Set(["super_admin", "dealership_admin", "dealership_owner"]);

export default function SMSPage() {
  const searchParams = useSearchParams();
  const { user } = useAuthStore();
  const canManageCampaigns = !!user && CAMPAIGN_ROLES.has(user.role);

  const [config, setConfig] = useState<SMSConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [leadHits, setLeadHits] = useState<SMSLeadSearchItem[]>([]);
  const [leadSearchLoading, setLeadSearchLoading] = useState(false);
  const [pickedLead, setPickedLead] = useState<SMSLeadSearchItem | null>(null);
  const [tab, setTab] = useState(searchParams.get("tab") === "campaigns" ? "campaigns" : "conversations");

  useEffect(() => {
    const lead = searchParams.get("lead");
    if (lead) {
      setSelectedLeadId(lead);
      setTab("conversations");
    }
  }, [searchParams]);

  useEffect(() => {
    smsService
      .getConfig()
      .then(setConfig)
      .catch(console.error)
      .finally(() => setConfigLoading(false));
  }, []);

  const loadConversations = useCallback(async (opts?: { silent?: boolean }) => {
    if (!config?.sms_enabled) return;
    try {
      if (!opts?.silent) setLoading(true);
      const response = await smsService.listConversations({ limit: 100 });
      setConversations(response.items);
      setTotalUnread(response.total_unread);
    } catch (err) {
      console.error("Failed to load SMS conversations:", err);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [config?.sms_enabled]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Fallback poll so new incoming threads appear even if a WebSocket event is missed
  useEffect(() => {
    if (!config?.sms_enabled) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void loadConversations({ silent: true });
      }
    }, 10000);
    return () => clearInterval(id);
  }, [config?.sms_enabled, loadConversations]);

  useWebSocketEvent(
    "sms:received",
    useCallback(() => void loadConversations({ silent: true }), [loadConversations]),
    [loadConversations]
  );

  useEffect(() => {
    const q = search.trim();
    if (!config?.sms_enabled || q.length < 2) {
      setLeadHits([]);
      setLeadSearchLoading(false);
      return;
    }
    setLeadSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        setLeadHits(await smsService.searchLeads(q, 20));
      } catch {
        setLeadHits([]);
      } finally {
        setLeadSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search, config?.sms_enabled]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    const digits = q.replace(/\D/g, "");
    return conversations.filter(
      (c) =>
        c.lead_name.toLowerCase().includes(q) ||
        (digits.length >= 3 && (c.lead_phone || "").replace(/\D/g, "").includes(digits))
    );
  }, [conversations, search]);

  const selected = conversations.find((c) => c.lead_id === selectedLeadId);
  const newTextHits = leadHits.filter((l) => !conversations.some((c) => c.lead_id === l.lead_id));
  const searching = search.trim().length >= 2;

  const handleSelect = (leadId: string) => {
    setSelectedLeadId(leadId);
    setPickedLead(null);
    const conv = conversations.find((c) => c.lead_id === leadId);
    if (conv && conv.unread_count > 0) {
      setConversations((prev) => prev.map((c) => (c.lead_id === leadId ? { ...c, unread_count: 0 } : c)));
      setTotalUnread((prev) => Math.max(0, prev - conv.unread_count));
    }
  };

  if (configLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-200px)]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!config?.sms_enabled) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-200px)] text-center px-4">
        <div className="bg-primary/10 rounded-full p-6 mb-6">
          <MessageSquare className="h-16 w-16 text-primary" />
        </div>
        <h2 className="text-2xl font-bold mb-3">Text (SMS) is turned off</h2>
        <p className="text-muted-foreground max-w-md">
          A Super Admin can turn on SMS and set the texting number in Settings, under Twilio.
        </p>
      </div>
    );
  }

  const conversationsView = (
    <div className="h-[calc(100vh-200px)] flex overflow-hidden rounded-lg border bg-background">
      <div
        className={`flex flex-col w-full md:w-[320px] lg:w-[360px] border-r shrink-0 ${
          selectedLeadId ? "hidden md:flex" : "flex"
        }`}
      >
        <div className="flex items-center justify-between gap-2 p-3 border-b">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Texts</span>
            {totalUnread > 0 && <Badge>{totalUnread}</Badge>}
          </div>
          <Button variant="ghost" size="icon" onClick={() => loadConversations()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search any lead by name or phone"
              className="pl-8"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {searching && (leadSearchLoading || newTextHits.length > 0) && (
                <div className="border-b">
                  <p className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Start a new text
                  </p>
                  {leadSearchLoading ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    newTextHits.map((lead) => (
                      <button
                        key={lead.lead_id}
                        type="button"
                        onClick={() => {
                          setSelectedLeadId(lead.lead_id);
                          setPickedLead(lead);
                        }}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors ${
                          selectedLeadId === lead.lead_id ? "bg-muted" : ""
                        }`}
                      >
                        <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <User className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{lead.lead_name}</p>
                          {lead.lead_phone && (
                            <p className="text-xs text-muted-foreground truncate">{lead.lead_phone}</p>
                          )}
                        </div>
                        <span className="text-xs font-medium text-primary shrink-0">New text</span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {searching && !leadSearchLoading && newTextHits.length === 0 && filtered.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No lead matches &quot;{search.trim()}&quot;.
                </p>
              ) : (
                (filtered.length > 0 || !searching) && (
                  <ConversationList
                    conversations={filtered}
                    selectedLeadId={selectedLeadId || undefined}
                    onSelect={handleSelect}
                  />
                )
              )}
            </>
          )}
        </div>
      </div>

      <div className={`flex-1 flex min-h-0 min-w-0 ${!selectedLeadId ? "hidden md:flex" : "flex"}`}>
        {selectedLeadId ? (
          <ConversationThread
            key={selectedLeadId}
            leadId={selectedLeadId}
            leadName={selected?.lead_name ?? pickedLead?.lead_name ?? ""}
            leadPhone={selected?.lead_phone ?? pickedLead?.lead_phone ?? null}
            onBack={() => {
              setSelectedLeadId(null);
              setPickedLead(null);
            }}
            onMessageSent={() => loadConversations({ silent: true })}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full w-full text-center p-4 text-muted-foreground">
            <MessageSquare className="h-12 w-12 mb-4 opacity-50" />
            <p className="text-sm">Select a conversation. Customer replies show up here as they arrive.</p>
          </div>
        )}
      </div>
    </div>
  );

  if (!canManageCampaigns) {
    return conversationsView;
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="conversations">Conversations</TabsTrigger>
        <TabsTrigger value="campaigns">Offer campaigns</TabsTrigger>
      </TabsList>
      <TabsContent value="conversations" className="mt-0">
        {conversationsView}
      </TabsContent>
      <TabsContent value="campaigns" className="mt-0">
        <CampaignsPanel />
      </TabsContent>
    </Tabs>
  );
}
