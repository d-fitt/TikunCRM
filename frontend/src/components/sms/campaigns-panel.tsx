"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, subDays } from "date-fns";
import {
  AlertTriangle,
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Eye,
  FileText,
  Film,
  History,
  Loader2,
  Paperclip,
  Play,
  Plus,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Sparkles,
  Trash2,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  SMSCampaign,
  SMSCampaignAudiencePreview,
  SMSCampaignFilterOptions,
  SMSCampaignFilters,
  SMSCampaignOverview,
  SMSCampaignPreview,
  smsService,
} from "@/services/sms-service";
import { useToast } from "@/hooks/use-toast";
import { useWebSocketEvent, useWebSocketResync } from "@/hooks/use-websocket";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<SMSCampaign["status"], string> = {
  draft: "Draft",
  queued: "Scheduled",
  sending: "Sending",
  completed: "Completed",
  cancelled: "Cancelled",
};

const SOURCE_LABELS: Record<string, string> = {
  google_sheets: "Meta / Sheets",
  manual: "Manual",
  whatsapp_inbound: "WhatsApp",
  website: "Website",
  referral: "Referral",
};

const PROMO_EMOJIS = [
  "🚗", "🚙", "🛻", "🔑", "🔥", "🎉", "💰", "💵",
  "⭐", "✅", "📍", "📅", "⏰", "👋", "😊", "🙏",
];

const CAMPAIGN_VARIABLE_GROUPS: {
  label: string;
  items: { token: string; label: string; example: string }[];
}[] = [
  {
    label: "Customer & Lead",
    items: [
      { token: "{nombre}", label: "First name", example: "María" },
      { token: "{apellido}", label: "Last name", example: "García" },
      { token: "{nombre_completo}", label: "Full name", example: "María García" },
      { token: "{vehiculo}", label: "Interested vehicle", example: "2022 Toyota RAV4" },
      { token: "{enganche}", label: "Down payment", example: "$2,000" },
      { token: "{agente}", label: "Assigned agent", example: "Carlos" },
    ],
  },
  {
    label: "Dealership & Links",
    items: [
      { token: "{tienda}", label: "Dealership name", example: "Carvamonos" },
      { token: "{telefono_tienda}", label: "Store phone", example: "(404) 555-0199" },
      { token: "{direccion}", label: "Store address", example: "123 Main St" },
      { token: "{inventario}", label: "Inventory link", example: "carvamonos.com/inventario" },
    ],
  },
];

const EMPTY_FILTERS: SMSCampaignFilters = {
  stage_ids: [],
  campaigns: [],
  sources: [],
  date_from: null,
  date_to: null,
  has_stips: null,
  assigned_to: null,
  min_down_payment: null,
  only_active: false,
  exclude_contacted_in_days: null,
  search: null,
};

type DatePreset = "all" | "7" | "30" | "90" | "custom";

function errorDetail(err: unknown): string | undefined {
  const e = err as { response?: { data?: { detail?: string } } };
  return typeof e.response?.data?.detail === "string" ? e.response.data.detail : undefined;
}

function mediaKind(url: string): "video" | "pdf" | "image" {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".mp4") || clean.endsWith(".3gp") || clean.endsWith(".mov") || clean.endsWith(".webm")) {
    return "video";
  }
  if (clean.endsWith(".pdf")) return "pdf";
  return "image";
}

function summarizeFilters(f: SMSCampaignFilters | undefined, options: SMSCampaignFilterOptions | null): string[] {
  if (!f) return [];
  const tags: string[] = [];
  if (f.stage_ids && f.stage_ids.length > 0) {
    const names = f.stage_ids.map((id) => options?.stages.find((s) => s.id === id)?.name || "Stage");
    tags.push(`Stage: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`);
  }
  if (f.campaigns && f.campaigns.length > 0) {
    tags.push(`Campaign: ${f.campaigns.length === 1 ? f.campaigns[0] : `${f.campaigns.length} selected`}`);
  }
  if (f.sources && f.sources.length > 0) {
    tags.push(`Source: ${f.sources.map((s) => SOURCE_LABELS[s] || s).join(", ")}`);
  }
  if (f.date_from || f.date_to) {
    tags.push(`Dates: ${f.date_from || "Any"} to ${f.date_to || "Now"}`);
  }
  if (f.has_stips === true) tags.push("Has stips");
  if (f.has_stips === false) tags.push("No stips");
  if (f.only_active) tags.push("Active only");
  if (f.assigned_to === "unassigned") tags.push("Unassigned");
  else if (f.assigned_to === "assigned") tags.push("Assigned");
  else if (f.assigned_to) {
    const ag = options?.agents.find((a) => a.id === f.assigned_to);
    tags.push(`Agent: ${ag?.name || "Selected"}`);
  }
  if (f.min_down_payment) tags.push(`Down ≥ $${f.min_down_payment.toLocaleString()}`);
  if (f.exclude_contacted_in_days) tags.push(`Not texted in ${f.exclude_contacted_in_days}d`);
  if (f.search) tags.push(`Search: "${f.search}"`);
  return tags;
}

export function CampaignsPanel() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [view, setView] = useState<"builder" | "history">("builder");
  const [overview, setOverview] = useState<SMSCampaignOverview | null>(null);
  const [filterOptions, setFilterOptions] = useState<SMSCampaignFilterOptions | null>(null);
  const [campaigns, setCampaigns] = useState<SMSCampaign[]>([]);
  const campaignsRef = useRef<SMSCampaign[]>([]);
  campaignsRef.current = campaigns;
  const [loading, setLoading] = useState(true);

  // Builder state
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [mediaUrls, setMediaUrls] = useState<string[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [filters, setFilters] = useState<SMSCampaignFilters>(EMPTY_FILTERS);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [leadsModalOpen, setLeadsModalOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const [campaignSearch, setCampaignSearch] = useState("");

  // Live previews
  const [audiencePreview, setAudiencePreview] = useState<SMSCampaignAudiencePreview | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [msgPreview, setMsgPreview] = useState<SMSCampaignPreview | null>(null);
  const [msgPreviewLoading, setMsgPreviewLoading] = useState(false);

  // Actions
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testPopoverOpen, setTestPopoverOpen] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<"all" | "drafts" | "sent">("all");

  const load = useCallback(async () => {
    try {
      const [ov, opts, list] = await Promise.all([
        smsService.getCampaignOverview(),
        smsService.getCampaignFilterOptions(),
        smsService.listCampaigns(),
      ]);
      setOverview(ov);
      setFilterOptions(opts);
      setCampaigns(list);
    } catch (err) {
      toast({ title: "Could not load campaigns", description: errorDetail(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Sent/failed counts stream in per batch from the campaign sender
  useWebSocketEvent<{ campaign_id?: string; status?: string; sent_count?: number; failed_count?: number }>(
    "sms:campaign_progress",
    useCallback((data) => {
      if (!data?.campaign_id) return;
      const known = campaignsRef.current.some((c) => String(c.id) === String(data.campaign_id));
      if (!known || data.status === "completed") {
        void load();
        return;
      }
      setCampaigns((prev) =>
        prev.map((c) =>
          String(c.id) !== String(data.campaign_id)
            ? c
            : {
                ...c,
                status: (data.status as typeof c.status) ?? c.status,
                sent_count: data.sent_count ?? c.sent_count,
                failed_count: data.failed_count ?? c.failed_count,
              }
        )
      );
    }, [load]),
    [load]
  );
  useWebSocketResync(useCallback(() => void load(), [load]), [load]);

  // Carrier delivery reports arrive after the send. Refresh the delivered counts, but not on every single text.
  const deliveryRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  useWebSocketEvent(
    "sms:status",
    useCallback(() => {
      if (deliveryRefresh.current) clearTimeout(deliveryRefresh.current);
      deliveryRefresh.current = setTimeout(() => void load(), 1500);
    }, [load]),
    [load]
  );
  useEffect(
    () => () => {
      if (deliveryRefresh.current) clearTimeout(deliveryRefresh.current);
    },
    []
  );

  // Live filtered audience preview
  useEffect(() => {
    setAudienceLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await smsService.previewCampaignAudience(filters, 50);
        setAudiencePreview(res);
      } catch {
        setAudiencePreview(null);
      } finally {
        setAudienceLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [filters]);

  // Live message + compliance preview
  useEffect(() => {
    if (!body.trim()) {
      setMsgPreview(null);
      return;
    }
    setMsgPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await smsService.previewCampaign({
          body,
          media_urls: mediaUrls,
          filters,
        });
        setMsgPreview(res);
      } catch {
        setMsgPreview(null);
      } finally {
        setMsgPreviewLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [body, mediaUrls, filters]);

  const activeFilterTags = useMemo(() => summarizeFilters(filters, filterOptions), [filters, filterOptions]);

  const moreFiltersCount = useMemo(() => {
    let n = 0;
    if ((filters.sources?.length || 0) > 0) n++;
    if (filters.assigned_to) n++;
    if (filters.min_down_payment) n++;
    if (filters.exclude_contacted_in_days) n++;
    if (filters.search) n++;
    if (filters.only_active) n++;
    return n;
  }, [filters]);

  const toggleArrayFilter = (key: "stage_ids" | "campaigns" | "sources", value: string) => {
    setFilters((prev) => {
      const current = prev[key] || [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, [key]: next };
    });
  };

  const handleDatePresetChange = (preset: DatePreset) => {
    setDatePreset(preset);
    if (preset === "all") {
      setFilters((prev) => ({ ...prev, date_from: null, date_to: null }));
    } else if (preset !== "custom") {
      const days = Number(preset);
      setFilters((prev) => ({
        ...prev,
        date_from: format(subDays(new Date(), days), "yyyy-MM-dd"),
        date_to: format(new Date(), "yyyy-MM-dd"),
      }));
    }
  };

  const clearAllFilters = () => {
    setFilters(EMPTY_FILTERS);
    setDatePreset("all");
  };

  const insertAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    if (!el) {
      setBody((prev) => prev + snippet);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + snippet + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const handleUploadMedia = async (files: FileList) => {
    const list = Array.from(files).slice(0, Math.max(0, 4 - mediaUrls.length));
    if (list.length === 0) return;
    setUploadingMedia(true);
    try {
      for (const file of list) {
        if (file.size > 5 * 1024 * 1024) {
          toast({ title: "File too large", description: `${file.name} exceeds 5MB MMS limit.`, variant: "destructive" });
          continue;
        }
        const uploaded = await smsService.uploadMedia(file);
        setMediaUrls((prev) => [...prev, uploaded.url]);
      }
    } catch (err) {
      toast({ title: "Upload failed", description: errorDetail(err) || "Could not upload file.", variant: "destructive" });
    } finally {
      setUploadingMedia(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const resetBuilder = () => {
    setEditingDraftId(null);
    setName("");
    setBody("");
    setMediaUrls([]);
    setFilters(EMPTY_FILTERS);
    setDatePreset("all");
    setScheduleEnabled(false);
    setScheduledAt("");
    setMsgPreview(null);
  };

  const loadIntoBuilder = (c: SMSCampaign, asDraftEdit: boolean) => {
    setEditingDraftId(asDraftEdit && c.status === "draft" ? c.id : null);
    setName(c.name ? (asDraftEdit ? c.name : `${c.name} (Copy)`) : "");
    setBody(c.body);
    setMediaUrls(c.media_urls || []);
    const nextFilters = { ...EMPTY_FILTERS, ...(c.filters || {}) };
    setFilters(nextFilters);
    setDatePreset(nextFilters.date_from || nextFilters.date_to ? "custom" : "all");
    if (c.scheduled_at) {
      setScheduleEnabled(true);
      setScheduledAt(c.scheduled_at.slice(0, 16));
    } else {
      setScheduleEnabled(false);
      setScheduledAt("");
    }
    setView("builder");
    toast({
      title: asDraftEdit ? "Draft loaded" : "Campaign copied to builder",
      description: "Review and adjust before sending.",
    });
  };

  const buildPayload = (saveAsDraft: boolean) => ({
    name: name.trim() || null,
    body,
    media_urls: mediaUrls,
    filters,
    save_as_draft: saveAsDraft,
    scheduled_at: scheduleEnabled && scheduledAt ? new Date(scheduledAt).toISOString() : null,
  });

  const handleSaveDraft = async () => {
    if (!body.trim()) return;
    setSavingDraft(true);
    try {
      if (editingDraftId) {
        const updated = await smsService.updateDraftCampaign(editingDraftId, buildPayload(true));
        setCampaigns((prev) => prev.map((c) => (c.id === editingDraftId ? updated : c)));
        toast({ title: "Draft updated" });
      } else {
        const created = await smsService.createCampaign(buildPayload(true));
        setCampaigns((prev) => [created, ...prev]);
        setEditingDraftId(created.id);
        toast({ title: "Draft saved" });
      }
    } catch (err) {
      toast({ title: "Could not save draft", description: errorDetail(err), variant: "destructive" });
    } finally {
      setSavingDraft(false);
    }
  };

  const handleSend = async () => {
    setSending(true);
    try {
      let created: SMSCampaign;
      if (editingDraftId) {
        await smsService.updateDraftCampaign(editingDraftId, buildPayload(true));
        created = await smsService.launchCampaign(editingDraftId);
        setCampaigns((prev) => prev.map((c) => (c.id === editingDraftId ? created : c)));
      } else {
        created = await smsService.createCampaign(buildPayload(false));
        setCampaigns((prev) => [created, ...prev]);
      }
      const wasScheduled = scheduleEnabled && !!scheduledAt;
      resetBuilder();
      setView("history");
      toast({
        title: wasScheduled ? "Campaign scheduled" : "Campaign launched",
        description: wasScheduled
          ? "Texts will start automatically at your scheduled time."
          : overview?.in_send_window
            ? "Texts start going out within a minute."
            : `Texts will start at ${overview?.send_window.split(" - ")[0]} (${overview?.timezone}).`,
      });
    } catch (err) {
      toast({ title: "Campaign not sent", description: errorDetail(err), variant: "destructive" });
    } finally {
      setSending(false);
      setConfirmOpen(false);
    }
  };

  const handleTestSend = async () => {
    if (!testPhone.trim() || !body.trim()) return;
    setTestSending(true);
    try {
      await smsService.testSendCampaign({
        to_number: testPhone.trim(),
        body,
        media_urls: mediaUrls,
        sample_first_name: "María",
      });
      toast({ title: "Test message sent", description: `Sent preview to ${testPhone.trim()}.` });
      setTestPopoverOpen(false);
    } catch (err) {
      toast({ title: "Test send failed", description: errorDetail(err), variant: "destructive" });
    } finally {
      setTestSending(false);
    }
  };

  const handleLaunchDraft = async (id: string) => {
    setLaunchingId(id);
    try {
      const updated = await smsService.launchCampaign(id);
      setCampaigns((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...updated, created_by_name: c.created_by_name } : c))
      );
      toast({ title: "Draft launched", description: `Queued for ${updated.total_recipients} matching customers.` });
    } catch (err) {
      toast({ title: "Could not launch", description: errorDetail(err), variant: "destructive" });
    } finally {
      setLaunchingId(null);
    }
  };

  const handleCancel = async (id: string) => {
    setCancellingId(id);
    try {
      const updated = await smsService.cancelCampaign(id);
      setCampaigns((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...updated, created_by_name: c.created_by_name } : c))
      );
    } catch (err) {
      toast({ title: "Could not cancel", description: errorDetail(err), variant: "destructive" });
    } finally {
      setCancellingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await smsService.deleteCampaign(id);
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
      if (editingDraftId === id) setEditingDraftId(null);
      toast({ title: "Campaign deleted" });
    } catch (err) {
      toast({ title: "Could not delete", description: errorDetail(err), variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const matchedCount = audiencePreview?.total ?? overview?.audience ?? 0;
  const sampleLeads = audiencePreview?.sample_leads ?? [];
  const blockedLinks = msgPreview?.blocked_links ?? [];
  const canLaunch =
    !!overview?.promo_enabled && !!body.trim() && blockedLinks.length === 0 && matchedCount > 0;
  const canSaveDraft = !!body.trim() && blockedLinks.length === 0;

  const filteredCampaignOptions = (filterOptions?.campaigns || []).filter((c) =>
    c.name.toLowerCase().includes(campaignSearch.trim().toLowerCase())
  );

  const visibleHistory = campaigns.filter((c) => {
    if (historyFilter === "drafts") return c.status === "draft";
    if (historyFilter === "sent") return c.status !== "draft";
    return true;
  });

  const draftCount = campaigns.filter((c) => c.status === "draft").length;
  const selectedStageNames = (filters.stage_ids || []).map(
    (id) => filterOptions?.stages.find((s) => s.id === id)?.name || "Stage"
  );

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-185px)]">
      {/* Top Bar: Clean Mode Switcher + Status */}
      <div className="flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="inline-flex items-center rounded-lg border bg-muted/40 p-1">
          <button
            type="button"
            onClick={() => setView("builder")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              view === "builder"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {editingDraftId ? "Editing Draft" : "Create Campaign"}
          </button>
          <button
            type="button"
            onClick={() => setView("history")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              view === "history"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <History className="h-3.5 w-3.5" />
            Campaigns & Drafts
            {campaigns.length > 0 && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] ml-0.5">
                {campaigns.length}
              </Badge>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs">
          {!overview?.promo_enabled ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800">
              <AlertTriangle className="h-3.5 w-3.5" />
              Promotional sending is off (Settings → Twilio)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-muted-foreground">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  overview.in_send_window ? "bg-emerald-500" : "bg-amber-500"
                )}
              />
              {overview.in_send_window ? "Sending window open" : "Outside sending hours"} · {overview.send_window}
            </span>
          )}
        </div>
      </div>

      {/* VIEW 1: BUILDER (Left scrolls, Right preview is FIXED and NON-SCROLLABLE) */}
      {view === "builder" ? (
        <div className="flex-1 min-h-0 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* LEFT PANE: Scrollable Form */}
          <div className="min-h-0 lg:overflow-y-auto lg:pr-1 space-y-4">
            {/* Step 1: Audience */}
            <Card className="shadow-xs">
              <CardHeader className="pb-3 pt-4 px-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                      1
                    </span>
                    <div>
                      <CardTitle className="text-sm font-semibold">Target Audience</CardTitle>
                      <p className="text-xs text-muted-foreground">
                        Only opted-in customers who haven&apos;t replied STOP
                      </p>
                    </div>
                  </div>
                  {activeFilterTags.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearAllFilters}
                      className="h-7 text-xs text-muted-foreground"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" /> Reset
                    </Button>
                  )}
                </div>
              </CardHeader>

              <CardContent className="px-5 pb-4 space-y-4">
                {/* 2x2 Clean Core Filters */}
                <div className="grid gap-3.5 sm:grid-cols-2">
                  {/* Lead Stage */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Lead Stage</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between font-normal text-sm h-9">
                          <span className="truncate">
                            {selectedStageNames.length === 0
                              ? "All stages"
                              : selectedStageNames.length <= 2
                                ? selectedStageNames.join(", ")
                                : `${selectedStageNames.length} stages selected`}
                          </span>
                          <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-1.5" align="start">
                        <div className="max-h-60 overflow-y-auto space-y-0.5">
                          {(filterOptions?.stages || []).map((stage) => {
                            const checked = (filters.stage_ids || []).includes(stage.id);
                            return (
                              <button
                                key={stage.id}
                                type="button"
                                onClick={() => toggleArrayFilter("stage_ids", stage.id)}
                                className={cn(
                                  "w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                                  checked && "bg-primary/10 font-medium text-primary"
                                )}
                              >
                                {stage.color && (
                                  <span
                                    className="h-2 w-2 rounded-full shrink-0"
                                    style={{ backgroundColor: stage.color }}
                                  />
                                )}
                                <span className="truncate flex-1">{stage.name}</span>
                                {checked && <Check className="h-3.5 w-3.5 shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>

                  {/* Ad Campaign */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Ad Campaign</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between font-normal text-sm h-9">
                          <span className="truncate">
                            {(filters.campaigns?.length || 0) === 0
                              ? "All campaigns"
                              : filters.campaigns?.length === 1
                                ? filters.campaigns[0]
                                : `${filters.campaigns?.length} selected`}
                          </span>
                          <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-72 p-2" align="start">
                        <Input
                          value={campaignSearch}
                          onChange={(e) => setCampaignSearch(e.target.value)}
                          placeholder="Search campaigns..."
                          className="h-8 mb-2 text-xs"
                        />
                        <div className="max-h-56 overflow-y-auto space-y-0.5">
                          {filteredCampaignOptions.length === 0 ? (
                            <p className="text-xs text-muted-foreground text-center py-3">No matching campaigns</p>
                          ) : (
                            filteredCampaignOptions.map((c) => {
                              const checked = (filters.campaigns || []).includes(c.name);
                              return (
                                <button
                                  key={c.name}
                                  type="button"
                                  onClick={() => toggleArrayFilter("campaigns", c.name)}
                                  className={cn(
                                    "w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted",
                                    checked && "bg-primary/10 font-medium text-primary"
                                  )}
                                >
                                  <span className="truncate">{c.name}</span>
                                  <span className="text-[11px] text-muted-foreground shrink-0">{c.count}</span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>

                  {/* Stips */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Stips</Label>
                    <div className="grid grid-cols-3 rounded-md border p-0.5 bg-muted/40 h-9">
                      {(
                        [
                          { label: "Any", val: null },
                          { label: "Has Stips", val: true },
                          { label: "No Stips", val: false },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => setFilters((prev) => ({ ...prev, has_stips: opt.val }))}
                          className={cn(
                            "rounded text-xs font-medium transition-colors",
                            filters.has_stips === opt.val
                              ? "bg-background text-foreground shadow-xs"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Lead Created Date */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Lead Created</Label>
                    <Select value={datePreset} onValueChange={(v) => handleDatePresetChange(v as DatePreset)}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any time</SelectItem>
                        <SelectItem value="7">Last 7 days</SelectItem>
                        <SelectItem value="30">Last 30 days</SelectItem>
                        <SelectItem value="90">Last 90 days</SelectItem>
                        <SelectItem value="custom">Custom dates...</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {datePreset === "custom" && (
                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="date"
                        value={filters.date_from || ""}
                        onChange={(e) => setFilters((prev) => ({ ...prev, date_from: e.target.value || null }))}
                        className="h-9 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="date"
                        value={filters.date_to || ""}
                        onChange={(e) => setFilters((prev) => ({ ...prev, date_to: e.target.value || null }))}
                        className="h-9 text-sm"
                      />
                    </div>
                  </div>
                )}

                {/* Collapsible More Filters */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowMoreFilters((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    {showMoreFilters ? "Hide extra filters" : "More filters"}
                    {moreFiltersCount > 0 && (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                        {moreFiltersCount}
                      </Badge>
                    )}
                    {showMoreFilters ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>

                  {showMoreFilters && (
                    <div className="mt-3 rounded-lg border bg-muted/20 p-3.5 grid gap-3.5 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Lead Source</Label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" className="w-full justify-between font-normal text-sm h-9 bg-background">
                              <span className="truncate">
                                {(filters.sources?.length || 0) === 0
                                  ? "All sources"
                                  : (filters.sources || []).map((s) => SOURCE_LABELS[s] || s).join(", ")}
                              </span>
                              <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-1.5" align="start">
                            <div className="space-y-0.5">
                              {(filterOptions?.sources || []).map((s) => {
                                const checked = (filters.sources || []).includes(s.value);
                                return (
                                  <button
                                    key={s.value}
                                    type="button"
                                    onClick={() => toggleArrayFilter("sources", s.value)}
                                    className={cn(
                                      "w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted",
                                      checked && "bg-primary/10 font-medium text-primary"
                                    )}
                                  >
                                    <span>{SOURCE_LABELS[s.value] || s.value}</span>
                                    <span className="text-[11px] text-muted-foreground">{s.count}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </PopoverContent>
                        </Popover>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Assigned Agent</Label>
                        <Select
                          value={filters.assigned_to || "__any__"}
                          onValueChange={(v) =>
                            setFilters((prev) => ({ ...prev, assigned_to: v === "__any__" ? null : v }))
                          }
                        >
                          <SelectTrigger className="h-9 text-sm bg-background">
                            <SelectValue placeholder="Any agent" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__any__">Any agent</SelectItem>
                            <SelectItem value="unassigned">Unassigned only</SelectItem>
                            <SelectItem value="assigned">Assigned only</SelectItem>
                            {(filterOptions?.agents || []).map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground" htmlFor="filter-dp">
                          Min Down Payment ($)
                        </Label>
                        <Input
                          id="filter-dp"
                          type="number"
                          min={0}
                          step={500}
                          placeholder="e.g. 2000"
                          value={filters.min_down_payment ?? ""}
                          onChange={(e) =>
                            setFilters((prev) => ({
                              ...prev,
                              min_down_payment: e.target.value ? Number(e.target.value) : null,
                            }))
                          }
                          className="h-9 text-sm bg-background"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground" htmlFor="filter-fatigue">
                          Skip if texted in last (days)
                        </Label>
                        <Input
                          id="filter-fatigue"
                          type="number"
                          min={0}
                          max={365}
                          placeholder="e.g. 7"
                          value={filters.exclude_contacted_in_days ?? ""}
                          onChange={(e) =>
                            setFilters((prev) => ({
                              ...prev,
                              exclude_contacted_in_days: e.target.value ? Number(e.target.value) : null,
                            }))
                          }
                          className="h-9 text-sm bg-background"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground" htmlFor="filter-search">
                          Search (vehicle, name, phone)
                        </Label>
                        <Input
                          id="filter-search"
                          placeholder="e.g. SUV, Ford..."
                          value={filters.search || ""}
                          onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value || null }))}
                          className="h-9 text-sm bg-background"
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-md border bg-background px-3 h-9 self-end">
                        <Label htmlFor="filter-active" className="text-xs font-medium cursor-pointer">
                          Active leads only
                        </Label>
                        <Switch
                          id="filter-active"
                          checked={!!filters.only_active}
                          onCheckedChange={(v) => setFilters((prev) => ({ ...prev, only_active: v }))}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Active filter chips + Audience bar */}
                {activeFilterTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {activeFilterTags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-[11px] font-normal">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 rounded-lg border bg-primary/5 px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    {audienceLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                    ) : (
                      <Users className="h-4 w-4 text-primary shrink-0" />
                    )}
                    <span>
                      <strong className="text-foreground">{matchedCount.toLocaleString()}</strong> matching opted-in{" "}
                      {matchedCount === 1 ? "customer" : "customers"}
                    </span>
                  </div>
                  {sampleLeads.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs bg-background"
                      onClick={() => setLeadsModalOpen(true)}
                    >
                      <Eye className="h-3.5 w-3.5 mr-1" />
                      View list
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Step 2: Message & Media */}
            <Card className="shadow-xs">
              <CardHeader className="pb-3 pt-4 px-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                      2
                    </span>
                    <div>
                      <CardTitle className="text-sm font-semibold">Message & Media</CardTitle>
                      <p className="text-xs text-muted-foreground">
                        Write your Spanish offer and personalize with variables
                      </p>
                    </div>
                  </div>
                  {editingDraftId && (
                    <Button type="button" variant="ghost" size="sm" onClick={resetBuilder} className="h-7 text-xs">
                      Start fresh
                    </Button>
                  )}
                </div>
              </CardHeader>

              <CardContent className="px-5 pb-4 space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="camp-name" className="text-xs text-muted-foreground">
                    Campaign Name (optional)
                  </Label>
                  <Input
                    id="camp-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Weekend SUV Special"
                    maxLength={160}
                    className="h-9"
                  />
                </div>

                {/* Integrated Editor Box */}
                <div className="space-y-1.5">
                  <div className="rounded-lg border focus-within:ring-1 focus-within:ring-ring overflow-hidden">
                    {/* Toolbar */}
                    <div className="flex items-center gap-1.5 flex-wrap border-b bg-muted/30 px-2.5 py-1.5">
                      <Popover open={varsOpen} onOpenChange={setVarsOpen}>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs px-2 hover:bg-background">
                            <Sparkles className="h-3.5 w-3.5 mr-1 text-primary" />
                            Variables
                            <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-72 p-2" align="start">
                          <div className="space-y-2.5 max-h-72 overflow-y-auto">
                            {CAMPAIGN_VARIABLE_GROUPS.map((group) => (
                              <div key={group.label}>
                                <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                                  {group.label}
                                </p>
                                <div className="space-y-0.5">
                                  {group.items.map((v) => (
                                    <button
                                      key={v.token}
                                      type="button"
                                      onClick={() => {
                                        insertAtCursor(v.token);
                                        setVarsOpen(false);
                                      }}
                                      className="w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted transition-colors"
                                    >
                                      <div className="min-w-0">
                                        <p className="text-xs font-medium text-foreground">{v.label}</p>
                                        <p className="text-[11px] text-muted-foreground truncate">e.g. {v.example}</p>
                                      </div>
                                      <code className="text-[11px] rounded bg-muted px-1.5 py-0.5 text-primary shrink-0">
                                        {v.token}
                                      </code>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>

                      <Popover>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs px-2 hover:bg-background">
                            <Smile className="h-3.5 w-3.5 mr-1" /> Emoji
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-60 p-2" align="start">
                          <div className="grid grid-cols-8 gap-1">
                            {PROMO_EMOJIS.map((em) => (
                              <button
                                key={em}
                                type="button"
                                onClick={() => insertAtCursor(em)}
                                className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted text-base"
                              >
                                {em}
                              </button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>

                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,application/pdf"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files) void handleUploadMedia(e.target.files);
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs px-2 hover:bg-background"
                        disabled={uploadingMedia || mediaUrls.length >= 4}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {uploadingMedia ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        ) : (
                          <Paperclip className="h-3.5 w-3.5 mr-1" />
                        )}
                        Attach Media{mediaUrls.length > 0 ? ` (${mediaUrls.length}/4)` : ""}
                      </Button>
                    </div>

                    <Textarea
                      ref={textareaRef}
                      id="camp-body"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={5}
                      maxLength={1000}
                      placeholder="Hola {nombre}, este fin de semana tenemos 0 de enganche en SUVs seleccionadas. Vea el inventario en {inventario}"
                      className="border-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0 resize-none text-sm"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    &quot;Carvamonos:&quot; and &quot;Responda STOP para cancelar.&quot; are added automatically. Only{" "}
                    <span className="font-medium">carvamonos.com</span> links are allowed.
                  </p>
                </div>

                {mediaUrls.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {mediaUrls.map((url, idx) => {
                      const kind = mediaKind(url);
                      return (
                        <div key={`${url}-${idx}`} className="relative rounded-lg border bg-muted/40 p-1.5 pr-7 flex items-center gap-2">
                          {kind === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={url} alt="Attachment" className="h-10 w-10 rounded object-cover" />
                          ) : kind === "video" ? (
                            <div className="flex h-10 w-10 items-center justify-center rounded bg-muted">
                              <Film className="h-4 w-4 text-muted-foreground" />
                            </div>
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded bg-muted">
                              <FileText className="h-4 w-4 text-muted-foreground" />
                            </div>
                          )}
                          <span className="text-xs text-muted-foreground capitalize">
                            {kind} #{idx + 1}
                          </span>
                          <button
                            type="button"
                            aria-label="Remove media"
                            onClick={() => setMediaUrls((prev) => prev.filter((_, i) => i !== idx))}
                            className="absolute right-1 top-1 rounded-full bg-background p-0.5 text-muted-foreground hover:text-foreground shadow-xs"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {blockedLinks.length > 0 && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    Remove disallowed links: <span className="font-medium">{blockedLinks.join(", ")}</span>. Only
                    carvamonos.com links are allowed.
                  </div>
                )}

                {/* Schedule Toggle */}
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3.5 py-2.5 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="schedule-toggle"
                      checked={scheduleEnabled}
                      onCheckedChange={(v) => {
                        setScheduleEnabled(v);
                        if (!v) setScheduledAt("");
                      }}
                    />
                    <Label htmlFor="schedule-toggle" className="text-xs font-medium cursor-pointer flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                      Schedule for later
                    </Label>
                  </div>
                  {scheduleEnabled && (
                    <Input
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                      className="h-8 text-xs w-auto bg-background"
                    />
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* RIGHT PANE: FIXED, NON-SCROLLABLE Phone Preview + Launch Controls */}
          <div className="lg:h-full lg:overflow-hidden flex flex-col">
            <Card className="flex flex-col h-full overflow-hidden shadow-xs">
              <CardHeader className="py-3 px-4 border-b shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <Smartphone className="h-4 w-4 text-primary" />
                    Live Preview
                  </span>
                  {msgPreviewLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <Badge variant="outline" className="font-normal text-[11px]">
                      {mediaUrls.length > 0
                        ? `MMS · ${mediaUrls.length} file${mediaUrls.length > 1 ? "s" : ""}`
                        : `${msgPreview?.segments ?? 1} SMS seg · ${msgPreview?.characters ?? 0} chars`}
                    </Badge>
                  )}
                </div>
              </CardHeader>

              {/* Phone Mockup Container (non-scrollable, fits cleanly) */}
              <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-muted/20 overflow-hidden">
                <div className="w-full max-w-[275px] h-full max-h-[370px] rounded-[28px] border-[5px] border-foreground/15 bg-background shadow-md flex flex-col overflow-hidden">
                  {/* Phone Status Bar + Notch */}
                  <div className="px-4 pt-2 pb-1.5 flex items-center justify-between text-[10px] font-medium text-muted-foreground shrink-0">
                    <span>9:41</span>
                    <div className="h-3.5 w-16 rounded-full bg-foreground/10" />
                    <span>5G</span>
                  </div>

                  {/* Contact Header */}
                  <div className="px-3 pb-2 border-b flex items-center justify-center gap-2 shrink-0">
                    <div className="h-6 w-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[11px] font-bold">
                      C
                    </div>
                    <div className="leading-tight">
                      <p className="text-xs font-semibold">Carvamonos</p>
                      <p className="text-[10px] text-muted-foreground">Text Message</p>
                    </div>
                  </div>

                  {/* Message Area */}
                  <div className="flex-1 min-h-0 p-3 bg-muted/25 flex flex-col justify-end gap-2 overflow-hidden">
                    {mediaUrls.length > 0 && (
                      <div className="overflow-hidden rounded-2xl bg-background border max-w-[85%] shrink-0">
                        {mediaKind(mediaUrls[0]) === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={mediaUrls[0]} alt="Preview" className="max-h-28 w-full object-cover" />
                        ) : mediaKind(mediaUrls[0]) === "video" ? (
                          <div className="flex items-center gap-2 p-2.5 text-xs">
                            <Film className="h-4 w-4 text-primary shrink-0" />
                            <span className="truncate">Video attachment</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 p-2.5 text-xs">
                            <FileText className="h-4 w-4 text-primary shrink-0" />
                            <span className="truncate">PDF attachment</span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-[12px] leading-relaxed text-foreground max-w-[94%] whitespace-pre-wrap break-words line-clamp-[9]">
                      {msgPreview?.sample || (
                        <span className="text-muted-foreground italic">
                          Start typing on the left to preview how your offer looks on a customer&apos;s phone...
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Decorative iMessage Input Bar */}
                  <div className="px-3 py-2 border-t bg-background shrink-0">
                    <div className="h-6 rounded-full border bg-muted/30 px-2.5 flex items-center text-[10px] text-muted-foreground">
                      Text Message
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer Summary & Primary Actions (always visible) */}
              <div className="p-4 border-t bg-background space-y-3 shrink-0">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                    <p className="text-[11px] text-muted-foreground">Recipients</p>
                    <p className="font-semibold text-sm">{matchedCount.toLocaleString()}</p>
                  </div>
                  <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                    <p className="text-[11px] text-muted-foreground">
                      Est. {mediaUrls.length > 0 ? "MMS" : "SMS segments"}
                    </p>
                    <p className="font-semibold text-sm">
                      {((msgPreview?.segments ?? 1) * matchedCount).toLocaleString()}
                    </p>
                  </div>
                </div>

                <Button
                  className="w-full"
                  onClick={() => setConfirmOpen(true)}
                  disabled={!canLaunch || sending}
                >
                  <Send className="h-4 w-4 mr-2" />
                  {scheduleEnabled && scheduledAt ? "Schedule" : "Send"} to {matchedCount.toLocaleString()}
                </Button>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleSaveDraft()}
                    disabled={!canSaveDraft || savingDraft}
                  >
                    {savingDraft ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Bookmark className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {editingDraftId ? "Update Draft" : "Save Draft"}
                  </Button>

                  <Popover open={testPopoverOpen} onOpenChange={setTestPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!body.trim() || blockedLinks.length > 0}
                      >
                        <Smartphone className="h-3.5 w-3.5 mr-1.5" /> Send Test
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 space-y-2.5" align="end" side="top">
                      <p className="text-xs font-medium">Send 1 preview text to your phone</p>
                      <Input
                        value={testPhone}
                        onChange={(e) => setTestPhone(e.target.value)}
                        placeholder="+1 (404) 555-0199"
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!testPhone.trim() || testSending}
                        onClick={() => void handleTestSend()}
                      >
                        {testSending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Send Test
                      </Button>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        /* VIEW 2: CAMPAIGNS & SAVED DRAFTS */
        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden shadow-xs">
          <CardHeader className="py-3.5 px-5 border-b shrink-0">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="text-base">Campaigns & Saved Drafts</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Track sent campaigns or reuse any draft with one click.
                </p>
              </div>
              <div className="inline-flex rounded-md border p-0.5 bg-muted/40">
                {(
                  [
                    { id: "all", label: `All (${campaigns.length})` },
                    { id: "drafts", label: `Drafts (${draftCount})` },
                    { id: "sent", label: `Sent (${campaigns.length - draftCount})` },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setHistoryFilter(t.id)}
                    className={cn(
                      "rounded px-3 py-1 text-xs font-medium transition-colors",
                      historyFilter === t.id
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>

          <CardContent className="flex-1 min-h-0 overflow-y-auto px-5">
            {visibleHistory.length === 0 ? (
              <div className="py-16 text-center space-y-3">
                <p className="text-sm text-muted-foreground">
                  {historyFilter === "drafts" ? "No saved drafts yet." : "No campaigns yet."}
                </p>
                <Button size="sm" variant="outline" onClick={() => setView("builder")}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Create your first campaign
                </Button>
              </div>
            ) : (
              <div className="divide-y">
                {visibleHistory.map((c) => {
                  const done = c.sent_count + c.failed_count + c.skipped_count;
                  const pct = c.total_recipients > 0 ? Math.round((done / c.total_recipients) * 100) : 0;
                  const tags = summarizeFilters(c.filters, filterOptions);
                  return (
                    <div key={c.id} className="py-4 space-y-2">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm">{c.name || "Untitled Campaign"}</span>
                            <Badge
                              variant={
                                c.status === "sending"
                                  ? "default"
                                  : c.status === "draft"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {STATUS_LABELS[c.status]}
                            </Badge>
                            {(c.media_urls?.length || 0) > 0 && (
                              <Badge variant="outline" className="text-[11px] gap-1 font-normal">
                                <Paperclip className="h-3 w-3" /> {c.media_urls.length} MMS
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(c.created_at), "MMM d, yyyy · h:mm a")}
                            </span>
                          </div>
                          {tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {tags.map((t) => (
                                <span
                                  key={t}
                                  className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {c.status === "draft" && (
                            <>
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => void handleLaunchDraft(c.id)}
                                disabled={!overview?.promo_enabled || launchingId === c.id}
                              >
                                {launchingId === c.id ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                ) : (
                                  <Play className="h-3.5 w-3.5 mr-1" />
                                )}
                                Send
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => loadIntoBuilder(c, true)}>
                                Edit
                              </Button>
                            </>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => loadIntoBuilder(c, false)}>
                            <Copy className="h-3.5 w-3.5 mr-1" /> Reuse
                          </Button>
                          {(c.status === "queued" || c.status === "sending") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleCancel(c.id)}
                              disabled={cancellingId === c.id}
                            >
                              <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel
                            </Button>
                          )}
                          {(c.status === "draft" || c.status === "cancelled") && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleDelete(c.id)}
                              disabled={deletingId === c.id}
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>

                      <p className="text-sm text-foreground/90 line-clamp-2">{c.body}</p>

                      {c.status !== "draft" ? (
                        <div className="space-y-1">
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                            <span>
                              {done.toLocaleString()}/{c.total_recipients.toLocaleString()} ({pct}%)
                            </span>
                            <span className="text-emerald-700 dark:text-emerald-400">
                              {(c.delivered_count ?? 0).toLocaleString()} delivered
                            </span>
                            {(c.pending_count ?? 0) > 0 && (
                              <span>{(c.pending_count ?? 0).toLocaleString()} waiting</span>
                            )}
                            {(c.undelivered_count ?? 0) > 0 && (
                              <span>{(c.undelivered_count ?? 0).toLocaleString()} not delivered</span>
                            )}
                            <span>{c.sent_count.toLocaleString()} accepted</span>
                            {c.failed_count > 0 && (
                              <span className="text-destructive">{c.failed_count.toLocaleString()} failed</span>
                            )}
                            {c.skipped_count > 0 && <span>{c.skipped_count.toLocaleString()} skipped</span>}
                            {c.scheduled_at && c.status === "queued" && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" /> {format(new Date(c.scheduled_at), "MMM d, h:mm a")}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          ~{c.total_recipients.toLocaleString()} matching customers when saved
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Matching Leads Preview Modal */}
      <Dialog open={leadsModalOpen} onOpenChange={setLeadsModalOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Matching Customers ({matchedCount.toLocaleString()})</DialogTitle>
            <DialogDescription>
              Showing {sampleLeads.length} of {matchedCount.toLocaleString()} opted-in customers matching your filters.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted sticky top-0 z-10 border-b text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Phone</th>
                  <th className="px-3 py-2.5 font-medium">Stage</th>
                  <th className="px-3 py-2.5 font-medium">Campaign</th>
                  <th className="px-3 py-2.5 font-medium">Stips</th>
                  <th className="px-3 py-2.5 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y bg-background">
                {sampleLeads.map((l) => (
                  <tr key={l.lead_id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{l.name}</td>
                    <td className="px-3 py-2 text-muted-foreground font-mono whitespace-nowrap">{l.phone}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {l.stage_name ? (
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {l.stage_name}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground max-w-[180px] truncate">
                      {l.campaign || SOURCE_LABELS[l.source] || l.source}
                    </td>
                    <td className="px-3 py-2">
                      {l.has_stips ? (
                        <Badge
                          variant="secondary"
                          className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        >
                          Yes
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">No</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {l.created_at ? format(new Date(l.created_at), "MMM d, yyyy") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Final Launch Confirmation Dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {scheduleEnabled && scheduledAt ? "Schedule" : "Send"} campaign to {matchedCount.toLocaleString()} customers?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2.5 text-sm">
                {name && <p className="font-medium text-foreground">{name}</p>}
                {activeFilterTags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {activeFilterTags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[11px] font-normal">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
                <p>Each customer will receive this {mediaUrls.length > 0 ? "MMS" : "SMS"}:</p>
                <p className="rounded-md bg-muted p-2.5 text-foreground whitespace-pre-wrap text-xs">
                  {msgPreview?.sample}
                </p>
                {mediaUrls.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Includes {mediaUrls.length} media attachment{mediaUrls.length === 1 ? "" : "s"}.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleSend()} disabled={sending}>
              {sending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {scheduleEnabled && scheduledAt ? "Schedule Campaign" : "Send Campaign"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
