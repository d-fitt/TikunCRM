"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, subDays } from "date-fns";
import {
  AlertTriangle,
  Bookmark,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  FileText,
  Film,
  Filter,
  Info,
  Loader2,
  Megaphone,
  Paperclip,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<SMSCampaign["status"], string> = {
  draft: "Saved Draft",
  queued: "Scheduled / Waiting",
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
    tags.push(`Stages: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`);
  }
  if (f.campaigns && f.campaigns.length > 0) {
    tags.push(`Campaigns: ${f.campaigns.length}`);
  }
  if (f.sources && f.sources.length > 0) {
    tags.push(`Sources: ${f.sources.map((s) => SOURCE_LABELS[s] || s).join(", ")}`);
  }
  if (f.date_from || f.date_to) {
    tags.push(`Dates: ${f.date_from || "Any"} → ${f.date_to || "Now"}`);
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
  if (f.min_down_payment) tags.push(`Down ≥ $${f.min_down_payment}`);
  if (f.exclude_contacted_in_days) tags.push(`Not texted in ${f.exclude_contacted_in_days}d`);
  if (f.search) tags.push(`"${f.search}"`);
  return tags;
}

export function CampaignsPanel() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [overview, setOverview] = useState<SMSCampaignOverview | null>(null);
  const [filterOptions, setFilterOptions] = useState<SMSCampaignFilterOptions | null>(null);
  const [campaigns, setCampaigns] = useState<SMSCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  // Builder state
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [mediaUrls, setMediaUrls] = useState<string[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [filters, setFilters] = useState<SMSCampaignFilters>(EMPTY_FILTERS);
  const [scheduledAt, setScheduledAt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showLeadPreviewTable, setShowLeadPreviewTable] = useState(false);
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

  const active = campaigns.some((c) => c.status === "queued" || c.status === "sending");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [active, load]);

  // Live filtered audience preview
  useEffect(() => {
    setAudienceLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await smsService.previewCampaignAudience(filters, 30);
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

  const toggleArrayFilter = (key: "stage_ids" | "campaigns" | "sources", value: string) => {
    setFilters((prev) => {
      const current = prev[key] || [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, [key]: next };
    });
  };

  const applyDatePreset = (days: number | null) => {
    if (days === null) {
      setFilters((prev) => ({ ...prev, date_from: null, date_to: null }));
    } else {
      setFilters((prev) => ({
        ...prev,
        date_from: format(subDays(new Date(), days), "yyyy-MM-dd"),
        date_to: format(new Date(), "yyyy-MM-dd"),
      }));
    }
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
    setScheduledAt("");
    setMsgPreview(null);
  };

  const loadIntoBuilder = (c: SMSCampaign, asDraftEdit: boolean) => {
    setEditingDraftId(asDraftEdit && c.status === "draft" ? c.id : null);
    setName(c.name ? (asDraftEdit ? c.name : `${c.name} (Copy)`) : "");
    setBody(c.body);
    setMediaUrls(c.media_urls || []);
    setFilters({ ...EMPTY_FILTERS, ...(c.filters || {}) });
    setScheduledAt(c.scheduled_at ? c.scheduled_at.slice(0, 16) : "");
    toast({
      title: asDraftEdit ? "Draft loaded" : "Campaign cloned into builder",
      description: "Review the filters and message, then save or launch.",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const buildPayload = (saveAsDraft: boolean) => ({
    name: name.trim() || null,
    body,
    media_urls: mediaUrls,
    filters,
    save_as_draft: saveAsDraft,
    scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
  });

  const handleSaveDraft = async () => {
    if (!body.trim()) return;
    setSavingDraft(true);
    try {
      if (editingDraftId) {
        const updated = await smsService.updateDraftCampaign(editingDraftId, buildPayload(true));
        setCampaigns((prev) => prev.map((c) => (c.id === editingDraftId ? updated : c)));
        toast({ title: "Draft updated", description: "You can launch or reuse this campaign anytime." });
      } else {
        const created = await smsService.createCampaign(buildPayload(true));
        setCampaigns((prev) => [created, ...prev]);
        setEditingDraftId(created.id);
        toast({ title: "Campaign saved as draft", description: "Reuse or launch it anytime from Saved Drafts." });
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
      resetBuilder();
      toast({
        title: scheduledAt ? "Campaign scheduled" : "Campaign launched",
        description: scheduledAt
          ? "Texts will start automatically at your scheduled time (within 8 AM–8 PM)."
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
      setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...updated, created_by_name: c.created_by_name } : c)));
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
      setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...updated, created_by_name: c.created_by_name } : c)));
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

  return (
    <div className="space-y-6 pb-8">
      {!overview?.promo_enabled && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3.5 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Promotional sending is currently turned off.</span> You can still build,
            filter audiences, preview, and save campaign drafts here. A Super Admin can turn on{" "}
            <span className="font-medium">Promotional texts</span> in Settings → Twilio when ready to launch.
          </div>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.95fr)] items-start">
        {/* LEFT COLUMN: Audience Filters + Composer */}
        <div className="space-y-6">
          {/* 1. AUDIENCE FILTERS */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Filter className="h-4 w-4 text-primary" />
                    1. Target Audience Filters
                    {activeFilterTags.length > 0 && (
                      <Badge variant="secondary" className="ml-1">{activeFilterTags.length} active</Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="mt-0.5">
                    Only customers who opted in to offers and haven&apos;t replied STOP are included.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {activeFilterTags.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setFilters(EMPTY_FILTERS)}
                      className="text-xs text-muted-foreground"
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1" /> Clear filters
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAdvanced((v) => !v)}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
                    Advanced
                    {showAdvanced ? <ChevronUp className="h-3.5 w-3.5 ml-1" /> : <ChevronDown className="h-3.5 w-3.5 ml-1" />}
                  </Button>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Row 1: Pipeline Stages */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Lead Stages
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {(filterOptions?.stages || []).map((stage) => {
                    const selected = (filters.stage_ids || []).includes(stage.id);
                    return (
                      <button
                        key={stage.id}
                        type="button"
                        onClick={() => toggleArrayFilter("stage_ids", stage.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "bg-background text-foreground hover:bg-muted"
                        )}
                      >
                        {stage.color && (
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: selected ? "#ffffff" : stage.color }}
                          />
                        )}
                        {stage.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Row 2: Campaigns, Date Range, Stips */}
              <div className="grid gap-4 md:grid-cols-3">
                {/* Ad / Source Campaigns multi-select */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Ad / Source Campaign
                  </Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-between font-normal text-sm">
                        <span className="truncate">
                          {(filters.campaigns?.length || 0) === 0
                            ? "All campaigns"
                            : `${filters.campaigns?.length} selected`}
                        </span>
                        <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
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
                                  "w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
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

                {/* Stips Added */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Stips Added
                  </Label>
                  <div className="grid grid-cols-3 rounded-md border p-0.5 bg-muted/40">
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
                          "rounded py-1.5 text-xs font-medium transition-colors",
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

                {/* Lead Created Date Range */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Lead Date Range
                    </Label>
                    <div className="flex gap-1">
                      {[
                        { label: "7d", d: 7 },
                        { label: "30d", d: 30 },
                        { label: "90d", d: 90 },
                        { label: "All", d: null },
                      ].map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => applyDatePreset(p.d)}
                          className="text-[11px] text-primary hover:underline px-1"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      type="date"
                      value={filters.date_from || ""}
                      onChange={(e) => setFilters((prev) => ({ ...prev, date_from: e.target.value || null }))}
                      className="h-9 text-xs"
                    />
                    <Input
                      type="date"
                      value={filters.date_to || ""}
                      onChange={(e) => setFilters((prev) => ({ ...prev, date_to: e.target.value || null }))}
                      className="h-9 text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Collapsible Advanced Filters */}
              {showAdvanced && (
                <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
                  <div className="grid gap-4 md:grid-cols-3">
                    {/* Lead Source */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Lead Source</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {(filterOptions?.sources || []).map((s) => {
                          const selected = (filters.sources || []).includes(s.value);
                          return (
                            <button
                              key={s.value}
                              type="button"
                              onClick={() => toggleArrayFilter("sources", s.value)}
                              className={cn(
                                "rounded-md border px-2 py-1 text-xs transition-colors",
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "bg-background hover:bg-muted"
                              )}
                            >
                              {SOURCE_LABELS[s.value] || s.value} ({s.count})
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Assignment */}
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor="filter-assigned">Assigned Agent</Label>
                      <select
                        id="filter-assigned"
                        value={filters.assigned_to || ""}
                        onChange={(e) => setFilters((prev) => ({ ...prev, assigned_to: e.target.value || null }))}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs"
                      >
                        <option value="">Any assignment</option>
                        <option value="unassigned">Unassigned leads only</option>
                        <option value="assigned">Assigned leads only</option>
                        {(filterOptions?.agents || []).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Min Down Payment */}
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor="filter-dp">Min Down Payment ($)</Label>
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
                        className="h-9 text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3 items-end">
                    {/* Anti-fatigue */}
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor="filter-fatigue">
                        Exclude texted a promo in last (days)
                      </Label>
                      <Input
                        id="filter-fatigue"
                        type="number"
                        min={0}
                        max={365}
                        placeholder="e.g. 7 (avoid over-texting)"
                        value={filters.exclude_contacted_in_days ?? ""}
                        onChange={(e) =>
                          setFilters((prev) => ({
                            ...prev,
                            exclude_contacted_in_days: e.target.value ? Number(e.target.value) : null,
                          }))
                        }
                        className="h-9 text-xs"
                      />
                    </div>

                    {/* Keyword / Vehicle search */}
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor="filter-search">Vehicle / Name / Phone contains</Label>
                      <Input
                        id="filter-search"
                        placeholder="e.g. Silverado, SUV, Ford..."
                        value={filters.search || ""}
                        onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value || null }))}
                        className="h-9 text-xs"
                      />
                    </div>

                    {/* Active leads only */}
                    <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                      <div>
                        <Label htmlFor="filter-active" className="text-xs font-medium">
                          Active leads only
                        </Label>
                        <p className="text-[11px] text-muted-foreground">Exclude closed/lost leads</p>
                      </div>
                      <Switch
                        id="filter-active"
                        checked={!!filters.only_active}
                        onCheckedChange={(v) => setFilters((prev) => ({ ...prev, only_active: v }))}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* LIVE FILTERED AUDIENCE PREVIEW LINE + EXPANDABLE LEAD LIST */}
              <div className="rounded-lg border bg-primary/5 p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 text-sm">
                    {audienceLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <Users className="h-4 w-4 text-primary" />
                    )}
                    <span>
                      <span className="font-semibold text-foreground">{matchedCount.toLocaleString()}</span>{" "}
                      opted-in {matchedCount === 1 ? "customer matches" : "customers match"} your filters
                    </span>
                  </div>
                  {sampleLeads.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setShowLeadPreviewTable((v) => !v)}
                    >
                      {showLeadPreviewTable ? "Hide lead list" : `Preview matching leads (${Math.min(sampleLeads.length, matchedCount)})`}
                      {showLeadPreviewTable ? <ChevronUp className="h-3.5 w-3.5 ml-1" /> : <ChevronDown className="h-3.5 w-3.5 ml-1" />}
                    </Button>
                  )}
                </div>

                {/* Compact preview line of matched leads */}
                {sampleLeads.length > 0 && !showLeadPreviewTable && (
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs">
                    {sampleLeads.slice(0, 6).map((l) => (
                      <span
                        key={l.lead_id}
                        className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-0.5 whitespace-nowrap shrink-0"
                      >
                        <span className="font-medium">{l.name}</span>
                        {l.stage_name && <span className="text-muted-foreground">· {l.stage_name}</span>}
                        {l.has_stips && (
                          <span className="rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                            Stips
                          </span>
                        )}
                      </span>
                    ))}
                    {matchedCount > 6 && (
                      <span className="text-muted-foreground whitespace-nowrap shrink-0 px-1">
                        +{(matchedCount - 6).toLocaleString()} more
                      </span>
                    )}
                  </div>
                )}

                {/* Expandable matching leads table */}
                {showLeadPreviewTable && sampleLeads.length > 0 && (
                  <div className="max-h-64 overflow-auto rounded-md border bg-background">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 sticky top-0 text-left text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">Lead</th>
                          <th className="px-3 py-2 font-medium">Phone</th>
                          <th className="px-3 py-2 font-medium">Stage</th>
                          <th className="px-3 py-2 font-medium">Campaign</th>
                          <th className="px-3 py-2 font-medium">Stips</th>
                          <th className="px-3 py-2 font-medium">Created</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {sampleLeads.map((l) => (
                          <tr key={l.lead_id} className="hover:bg-muted/30">
                            <td className="px-3 py-1.5 font-medium">{l.name}</td>
                            <td className="px-3 py-1.5 text-muted-foreground font-mono">{l.phone}</td>
                            <td className="px-3 py-1.5">
                              {l.stage_name ? (
                                <Badge variant="outline" className="text-[10px] font-normal">
                                  {l.stage_name}
                                </Badge>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground max-w-[160px] truncate">
                              {l.campaign || SOURCE_LABELS[l.source] || l.source}
                            </td>
                            <td className="px-3 py-1.5">
                              {l.has_stips ? (
                                <Badge variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                                  Yes
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">No</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                              {l.created_at ? format(new Date(l.created_at), "MMM d, yyyy") : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {matchedCount > sampleLeads.length && (
                      <p className="border-t bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground text-center">
                        Showing first {sampleLeads.length} of {matchedCount.toLocaleString()} matching customers
                      </p>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 2. MESSAGE, MEDIA & SCHEDULE COMPOSER */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Megaphone className="h-4 w-4 text-primary" />
                    2. Compose Offer & Media
                    {editingDraftId && <Badge variant="secondary">Editing Draft</Badge>}
                  </CardTitle>
                  <CardDescription className="mt-0.5">
                    Write in Spanish, attach an optional flyer or car photo (MMS), and save or launch.
                  </CardDescription>
                </div>
                {editingDraftId && (
                  <Button type="button" variant="ghost" size="sm" onClick={resetBuilder}>
                    New blank campaign
                  </Button>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Campaign Name + Optional Schedule */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="camp-name" className="text-xs">Campaign Name (for saving & reuse)</Label>
                  <Input
                    id="camp-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Weekend SUV 0% Down Offer"
                    maxLength={160}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="camp-sched" className="text-xs flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" /> Schedule Launch (optional)
                  </Label>
                  <Input
                    id="camp-sched"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                  />
                </div>
              </div>

              {/* Message Body + Quick Insert Toolbar */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <Label htmlFor="camp-body" className="text-xs">Message Text (Spanish)</Label>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={() => insertAtCursor("{nombre}")}
                    >
                      <Sparkles className="h-3 w-3 mr-1" /> + First name
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={() => insertAtCursor(" carvamonos.com/inventario")}
                    >
                      + Inventory link
                    </Button>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs px-2">
                          <Smile className="h-3.5 w-3.5 mr-1" /> Emoji
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-60 p-2" align="end">
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
                  </div>
                </div>

                <Textarea
                  ref={textareaRef}
                  id="camp-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  maxLength={1000}
                  placeholder="Hola {nombre}, este fin de semana tenemos 0 de enganche en SUVs seleccionadas. Vea el inventario en carvamonos.com/inventario"
                />
                <p className="text-xs text-muted-foreground">
                  &quot;Carvamonos:&quot; and &quot;Responda STOP para cancelar.&quot; are added automatically if missing.
                  Only <span className="font-medium">carvamonos.com</span> links are allowed (no bit.ly or shorteners).
                </p>
              </div>

              {/* MMS Media Attachments */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Media Attachment (MMS Flyer, Car Photo, Video, or PDF)</Label>
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
                    variant="outline"
                    size="sm"
                    disabled={uploadingMedia || mediaUrls.length >= 4}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploadingMedia ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Paperclip className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Attach Media ({mediaUrls.length}/4)
                  </Button>
                </div>

                {mediaUrls.length > 0 && (
                  <div className="flex flex-wrap gap-2.5 pt-1">
                    {mediaUrls.map((url, idx) => {
                      const kind = mediaKind(url);
                      return (
                        <div key={`${url}-${idx}`} className="relative rounded-lg border bg-muted/40 p-1.5 pr-7 flex items-center gap-2">
                          {kind === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={url} alt="Flyer" className="h-14 w-14 rounded object-cover" />
                          ) : kind === "video" ? (
                            <div className="flex h-14 w-14 items-center justify-center rounded bg-muted">
                              <Film className="h-5 w-5 text-muted-foreground" />
                            </div>
                          ) : (
                            <div className="flex h-14 w-14 items-center justify-center rounded bg-muted">
                              <FileText className="h-5 w-5 text-muted-foreground" />
                            </div>
                          )}
                          <span className="text-xs text-muted-foreground max-w-[110px] truncate">
                            {kind.toUpperCase()} #{idx + 1}
                          </span>
                          <button
                            type="button"
                            aria-label="Remove media"
                            onClick={() => setMediaUrls((prev) => prev.filter((_, i) => i !== idx))}
                            className="absolute right-1 top-1 rounded-full bg-background p-0.5 text-muted-foreground hover:text-foreground shadow-xs"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {blockedLinks.length > 0 && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Remove disallowed links: <span className="font-medium">{blockedLinks.join(", ")}</span>. Only
                  carvamonos.com links are permitted by your A2P campaign.
                </div>
              )}

              {/* Action Bar */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
                <Button onClick={() => setConfirmOpen(true)} disabled={!canLaunch || sending}>
                  <Send className="h-4 w-4 mr-2" />
                  {scheduledAt ? "Schedule" : "Launch"} to {matchedCount.toLocaleString()} customers
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleSaveDraft()}
                  disabled={!canSaveDraft || savingDraft}
                >
                  {savingDraft ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Bookmark className="h-4 w-4 mr-2" />}
                  {editingDraftId ? "Update Draft" : "Save Draft / Reuse Later"}
                </Button>

                <Popover open={testPopoverOpen} onOpenChange={setTestPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" disabled={!body.trim() || blockedLinks.length > 0}>
                      <Smartphone className="h-4 w-4 mr-2" /> Send Test
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 space-y-2.5" align="start">
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
                      Send Test {mediaUrls.length > 0 ? "MMS" : "SMS"}
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT COLUMN: Live Phone Preview + How It Works */}
        <div className="space-y-6 xl:sticky xl:top-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-primary" /> Live Customer Preview
                </span>
                {msgPreviewLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  msgPreview && (
                    <Badge variant="outline" className="font-normal text-[11px]">
                      {msgPreview.is_mms ? "MMS" : `${msgPreview.segments} SMS seg`} · {msgPreview.characters} chars
                    </Badge>
                  )
                )}
              </CardTitle>
              <CardDescription>Exactly how the message appears on a customer&apos;s phone</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Phone Frame */}
              <div className="mx-auto max-w-[320px] rounded-[28px] border-4 border-muted-foreground/20 bg-muted/30 p-3 shadow-inner">
                <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-muted-foreground/30" />
                <div className="mb-3 text-center">
                  <p className="text-xs font-semibold">Carvamonos</p>
                  <p className="text-[10px] text-muted-foreground">Text Message · Today</p>
                </div>

                <div className="min-h-[150px] space-y-2">
                  {mediaUrls.map((url, idx) => {
                    const kind = mediaKind(url);
                    return (
                      <div key={`prev-${idx}`} className="overflow-hidden rounded-2xl bg-background border max-w-[88%]">
                        {kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={url} alt="Preview" className="max-h-48 w-full object-cover" />
                        ) : kind === "video" ? (
                          <video src={url} controls className="max-h-44 w-full" />
                        ) : (
                          <div className="flex items-center gap-2 p-3 text-xs">
                            <FileText className="h-4 w-4 text-primary" /> PDF Attachment
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="rounded-2xl rounded-bl-sm bg-background border px-3.5 py-2.5 text-xs leading-relaxed shadow-xs max-w-[92%] whitespace-pre-wrap break-words">
                    {msgPreview?.sample || (
                      <span className="text-muted-foreground italic">
                        Carvamonos: Start typing your Spanish offer on the left to see the live customer preview...
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Estimated usage */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border bg-muted/30 p-2.5">
                  <p className="text-muted-foreground">Target audience</p>
                  <p className="text-sm font-semibold">{matchedCount.toLocaleString()} leads</p>
                </div>
                <div className="rounded-md border bg-muted/30 p-2.5">
                  <p className="text-muted-foreground">Est. {mediaUrls.length > 0 ? "MMS" : "SMS segments"}</p>
                  <p className="text-sm font-semibold">
                    {((msgPreview?.segments ?? 1) * matchedCount).toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* HOW THIS CAMPAIGN WORKS */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Info className="h-4 w-4 text-primary" /> How this campaign works
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <p>
                  <span className="font-medium text-foreground">Automatic compliance:</span> Only customers with
                  promotional consent are targeted. Every recipient is re-checked right before sending so anyone who
                  replies STOP is skipped immediately.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <Clock className="h-4 w-4 text-sky-600 shrink-0 mt-0.5" />
                <p>
                  <span className="font-medium text-foreground">Quiet hours & pacing:</span> Sends between{" "}
                  <span className="font-medium text-foreground">{overview?.send_window}</span> ({overview?.timezone})
                  at ~60 messages/minute to protect deliverability.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <p>
                  <span className="font-medium text-foreground">Two-way replies:</span> Customer replies land directly
                  in the <span className="font-medium text-foreground">Conversations</span> tab and trigger unread
                  badges & notifications.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <Bookmark className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <p>
                  <span className="font-medium text-foreground">Save & reuse:</span> Save any campaign as a draft
                  template, or click <span className="font-medium text-foreground">Reuse</span> on any past campaign to
                  clone its filters, message, and flyer.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 3. SAVED DRAFTS & CAMPAIGN HISTORY */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">Saved Drafts & Campaign History</CardTitle>
              <CardDescription>Reuse any saved draft or past campaign with one click.</CardDescription>
            </div>
            <div className="inline-flex rounded-md border p-0.5 bg-muted/40">
              {(
                [
                  { id: "all", label: `All (${campaigns.length})` },
                  { id: "drafts", label: `Saved Drafts (${draftCount})` },
                  { id: "sent", label: `Sent & Active (${campaigns.length - draftCount})` },
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

        <CardContent>
          {visibleHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {historyFilter === "drafts"
                ? "No saved drafts yet. Click 'Save Draft / Reuse Later' above to save a reusable campaign."
                : "No campaigns yet."}
            </p>
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
                          <span className="font-semibold text-sm">
                            {c.name || "Untitled Offer Campaign"}
                          </span>
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
                            {c.created_by_name ? ` · ${c.created_by_name}` : ""}
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
                              Launch
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => loadIntoBuilder(c, true)}
                            >
                              Edit
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => loadIntoBuilder(c, false)}
                          title="Load message, media, and filters into the builder"
                        >
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
                          <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                          <span>
                            {done.toLocaleString()}/{c.total_recipients.toLocaleString()} processed ({pct}%)
                          </span>
                          <span className="text-emerald-700 dark:text-emerald-400">
                            {c.sent_count.toLocaleString()} sent
                          </span>
                          {c.failed_count > 0 && (
                            <span className="text-destructive">{c.failed_count.toLocaleString()} failed</span>
                          )}
                          {c.skipped_count > 0 && <span>{c.skipped_count.toLocaleString()} skipped</span>}
                          {c.scheduled_at && c.status === "queued" && (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" /> scheduled for{" "}
                              {format(new Date(c.scheduled_at), "MMM d, h:mm a")}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Est. audience when saved: ~{c.total_recipients.toLocaleString()} customers (recalculated fresh on launch)
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Final Launch Confirmation Dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {scheduledAt ? "Schedule" : "Launch"} campaign to {matchedCount.toLocaleString()} customers?
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
                <p>Each customer gets this {mediaUrls.length > 0 ? "MMS" : "SMS"} (with their own first name):</p>
                <p className="rounded-md bg-muted p-2.5 text-foreground whitespace-pre-wrap text-xs">
                  {msgPreview?.sample}
                </p>
                {mediaUrls.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Includes {mediaUrls.length} media attachment{mediaUrls.length === 1 ? "" : "s"}.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Uses about {((msgPreview?.segments ?? 1) * matchedCount).toLocaleString()}{" "}
                  {mediaUrls.length > 0 ? "MMS messages" : "SMS segments"}. You can cancel anytime while it&apos;s sending.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleSend()} disabled={sending}>
              {sending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {scheduledAt ? "Schedule Campaign" : "Launch Campaign"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
