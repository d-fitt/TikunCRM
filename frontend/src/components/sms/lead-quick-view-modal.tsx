"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  Calendar,
  Car,
  DollarSign,
  ExternalLink,
  Loader2,
  Mail,
  Phone,
  Store,
  Tag,
  User,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Lead,
  LeadService,
  getLeadEmail,
  getLeadFullName,
  getLeadPhone,
} from "@/services/lead-service";

interface LeadQuickViewModalProps {
  leadId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LeadQuickViewModal({
  leadId,
  open,
  onOpenChange,
}: LeadQuickViewModalProps) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !leadId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    LeadService.getLead(leadId)
      .then((data) => {
        if (!cancelled) setLead(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load lead details.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, leadId]);

  const phone = lead ? getLeadPhone(lead) : null;
  const email = lead ? getLeadEmail(lead) : null;
  const assignedName = lead?.assigned_to_user
    ? `${lead.assigned_to_user.first_name || ""} ${lead.assigned_to_user.last_name || ""}`.trim()
    : null;
  const sourceLabel =
    lead?.latest_source_display ||
    lead?.source_display ||
    lead?.campaign_mapping?.display_name ||
    lead?.source;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap pr-6">
            <span>{lead ? getLeadFullName(lead) : "Lead Details"}</span>
            {lead?.stage && (
              <Badge
                variant="secondary"
                style={
                  lead.stage.color
                    ? { backgroundColor: `${lead.stage.color}20`, color: lead.stage.color }
                    : undefined
                }
              >
                {lead.stage.display_name || lead.stage.name}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : lead ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              {phone && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Phone className="h-4 w-4 shrink-0" />
                  <span className="text-foreground font-medium truncate">{phone}</span>
                </div>
              )}
              {email && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Mail className="h-4 w-4 shrink-0" />
                  <span className="text-foreground truncate">{email}</span>
                </div>
              )}
              {assignedName && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <User className="h-4 w-4 shrink-0" />
                  <span className="truncate">Assigned: <span className="text-foreground font-medium">{assignedName}</span></span>
                </div>
              )}
              {sourceLabel && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Tag className="h-4 w-4 shrink-0" />
                  <span className="truncate text-foreground">{sourceLabel}</span>
                </div>
              )}
              {lead.partner_store?.name && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Store className="h-4 w-4 shrink-0" />
                  <span className="truncate text-foreground">{lead.partner_store.name}</span>
                </div>
              )}
              {lead.interested_in && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Car className="h-4 w-4 shrink-0" />
                  <span className="truncate text-foreground">{lead.interested_in}</span>
                </div>
              )}
              {lead.down_payment != null && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <DollarSign className="h-4 w-4 shrink-0" />
                  <span className="text-foreground">
                    Down payment: ${Number(lead.down_payment).toLocaleString()}
                  </span>
                </div>
              )}
              {lead.created_at && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="h-4 w-4 shrink-0" />
                  <span className="text-foreground">
                    Created {format(new Date(lead.created_at), "MMM d, yyyy")}
                  </span>
                </div>
              )}
            </div>

            {lead.notes && (
              <div className="rounded-lg bg-muted/50 p-3 text-sm">
                <p className="text-xs font-medium text-muted-foreground mb-1">Notes</p>
                <p className="whitespace-pre-wrap text-foreground line-clamp-4">{lead.notes}</p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button size="sm" asChild>
                <Link href={`/leads/${lead.id}`}>
                  Open Full Lead
                  <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                </Link>
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
