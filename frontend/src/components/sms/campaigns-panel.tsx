"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, Clock, Loader2, Megaphone, Send, Users, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  SMSCampaignOverview,
  SMSCampaignPreview,
  smsService,
} from "@/services/sms-service";
import { useToast } from "@/hooks/use-toast";

const STATUS_LABELS: Record<SMSCampaign["status"], string> = {
  queued: "Waiting",
  sending: "Sending",
  completed: "Done",
  cancelled: "Cancelled",
};

function errorDetail(err: unknown): string | undefined {
  const e = err as { response?: { data?: { detail?: string } } };
  return typeof e.response?.data?.detail === "string" ? e.response.data.detail : undefined;
}

export function CampaignsPanel() {
  const { toast } = useToast();
  const [overview, setOverview] = useState<SMSCampaignOverview | null>(null);
  const [campaigns, setCampaigns] = useState<SMSCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<SMSCampaignPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ov, list] = await Promise.all([smsService.getCampaignOverview(), smsService.listCampaigns()]);
      setOverview(ov);
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

  useEffect(() => {
    if (!body.trim()) {
      setPreview(null);
      return;
    }
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        setPreview(await smsService.previewCampaign(body));
      } catch {
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [body]);

  const handleSend = async () => {
    setSending(true);
    try {
      const created = await smsService.createCampaign(body);
      setCampaigns((prev) => [created, ...prev]);
      setBody("");
      setPreview(null);
      toast({
        title: "Campaign queued",
        description: overview?.in_send_window
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

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const blockedLinks = preview?.blocked_links ?? [];
  const canSend =
    !!overview?.promo_enabled && !!body.trim() && blockedLinks.length === 0 && (preview?.audience ?? 0) > 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Megaphone className="h-5 w-5" /> New offer campaign
          </CardTitle>
          <CardDescription>
            Goes only to customers who agreed to offers and haven&apos;t replied STOP. Texts send between{" "}
            {overview?.send_window} ({overview?.timezone}).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!overview?.promo_enabled && (
            <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              Promotional texts are turned off. A Super Admin can turn them on in Settings, under Twilio.
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            <span>
              <span className="font-medium text-foreground">{overview?.audience ?? 0}</span> customers can receive offers
            </span>
          </div>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            maxLength={1000}
            placeholder="Hola {nombre}, este fin de semana tenemos 0 de enganche en SUVs seleccionadas. Vea el inventario en carvamonos.com/inventario"
            disabled={!overview?.promo_enabled}
          />
          <p className="text-xs text-muted-foreground">
            Write in Spanish. Use {"{nombre}"} for the customer&apos;s first name. &quot;Carvamonos:&quot; and
            &quot;Responda STOP para cancelar.&quot; are added if missing. Links may only point to carvamonos.com (no
            bit.ly or other shorteners).
          </p>

          {(preview || previewLoading) && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Preview</span>
                {previewLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  preview && (
                    <span>
                      {preview.characters} characters · {preview.segments} SMS{" "}
                      {preview.segments === 1 ? "segment" : "segments"} per customer
                    </span>
                  )
                )}
              </div>
              {preview && <p className="text-sm whitespace-pre-wrap">{preview.sample}</p>}
              {blockedLinks.length > 0 && (
                <p className="text-sm text-destructive">
                  Remove these links: {blockedLinks.join(", ")}. Only carvamonos.com links are allowed.
                </p>
              )}
            </div>
          )}

          <Button onClick={() => setConfirmOpen(true)} disabled={!canSend || sending}>
            <Send className="h-4 w-4 mr-2" /> Send to {preview?.audience ?? overview?.audience ?? 0} customers
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent campaigns</CardTitle>
          <CardDescription>Replies land in Conversations like any other text.</CardDescription>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No campaigns yet.</p>
          ) : (
            <div className="divide-y">
              {campaigns.map((c) => {
                const done = c.sent_count + c.failed_count + c.skipped_count;
                return (
                  <div key={c.id} className="py-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant={c.status === "sending" ? "default" : "secondary"}>
                          {STATUS_LABELS[c.status]}
                        </Badge>
                        <span>{format(new Date(c.created_at), "MMM d, h:mm a")}</span>
                        {c.created_by_name && <span>· {c.created_by_name}</span>}
                      </div>
                      {(c.status === "queued" || c.status === "sending") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCancel(c.id)}
                          disabled={cancellingId === c.id}
                        >
                          <XCircle className="h-4 w-4 mr-1" /> Cancel
                        </Button>
                      )}
                    </div>
                    <p className="text-sm line-clamp-2">{c.body}</p>
                    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>
                        {done}/{c.total_recipients} processed
                      </span>
                      <span className="text-emerald-700">{c.sent_count} sent</span>
                      {c.failed_count > 0 && <span className="text-destructive">{c.failed_count} failed</span>}
                      {c.skipped_count > 0 && <span>{c.skipped_count} skipped</span>}
                      {c.status === "queued" && !overview?.in_send_window && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" /> waiting for {overview?.send_window.split(" - ")[0]}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send to {preview?.audience ?? 0} customers?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Each customer gets this text (with their own name):</p>
                <p className="rounded-md bg-muted p-2 text-foreground whitespace-pre-wrap">{preview?.sample}</p>
                <p>
                  Uses about {(preview?.segments ?? 1) * (preview?.audience ?? 0)} SMS segments. You can cancel while it&apos;s
                  sending.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={handleSend} disabled={sending}>
              {sending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Send campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
