"use client"

import * as React from "react"
import { Loader2, Store } from "lucide-react"
import { PartnerProgramService, type LeadDeliveryRow } from "@/services/partner-program-service"
import {
    PartnerStoreService,
    type PartnerStore,
    type StoreSendResult,
} from "@/services/partner-store-service"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"

function optInLabel(programType?: string | null) {
    return programType === "full_bdc" ? "Leads + BDC" : "Leads only"
}

function rangeLabel(store: PartnerStore) {
    if (store.monthly_leads_min == null || store.monthly_leads_max == null) return null
    return `${store.monthly_leads_min}–${store.monthly_leads_max}/mo`
}

export function LeadDeliveries({
    leadId,
    canManage,
    onStoresChange,
}: {
    leadId: string
    canManage: boolean
    onStoresChange?: (storeIds: string[]) => void
}) {
    const { toast } = useToast()
    const [rows, setRows] = React.useState<LeadDeliveryRow[]>([])
    const [loading, setLoading] = React.useState(true)
    const [open, setOpen] = React.useState(false)
    const [stores, setStores] = React.useState<PartnerStore[]>([])
    const [selected, setSelected] = React.useState<string[]>([])
    const [busy, setBusy] = React.useState(false)

    const load = React.useCallback(async () => {
        setLoading(true)
        try {
            const next = await PartnerProgramService.listDeliveries(leadId)
            setRows(next)
            onStoresChange?.(
                next
                    .filter((row) => row.status !== "dead" && row.status !== "returned")
                    .map((row) => row.partner_store_id)
            )
        } catch {
            setRows([])
            onStoresChange?.([])
        } finally {
            setLoading(false)
        }
    }, [leadId, onStoresChange])

    React.useEffect(() => {
        load()
    }, [load])

    const alreadySent = React.useMemo(
        () =>
            new Set(
                rows
                    .filter((row) => row.status !== "dead" && row.status !== "returned")
                    .map((row) => row.partner_store_id)
            ),
        [rows]
    )

    async function openPicker() {
        setOpen(true)
        try {
            const res = await PartnerStoreService.list({ active_only: true })
            setStores(res.items || [])
            setSelected(Array.from(alreadySent))
        } catch {
            toast({ title: "Could not load partner stores", variant: "destructive" })
        }
    }

    function toggle(id: string) {
        if (alreadySent.has(id)) return
        setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
    }

    async function confirmSend() {
        const fresh = selected.filter((id) => !alreadySent.has(id))
        if (fresh.length === 0) {
            toast({ title: "Choose a store that has not received this lead yet" })
            return
        }
        setBusy(true)
        try {
            const result = await PartnerStoreService.sendLead(leadId, fresh)
            const sent = result.results.filter((item) => item.status === "sent")
            const warnings = result.results.map((item) => item.email_error).filter(Boolean)
            toast({
                title: sent.length ? `Sent to ${sent.map((item) => item.partner_store_name).join(", ")}` : "Already sent",
                description: warnings[0] || undefined,
            })
            setOpen(false)
            await load()
        } catch (err: unknown) {
            const detail =
                err && typeof err === "object" && "response" in err
                    ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
                    : undefined
            toast({
                title: "Could not send this lead",
                description: typeof detail === "string" ? detail : "Please try again.",
                variant: "destructive",
            })
        } finally {
            setBusy(false)
        }
    }

    async function undo(row: LeadDeliveryRow) {
        setBusy(true)
        try {
            setRows(await PartnerProgramService.returnDelivery(leadId, row.id))
            await load()
        } catch {
            toast({ title: "Could not undo that send", variant: "destructive" })
        } finally {
            setBusy(false)
        }
    }

    return (
        <div>
            <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground uppercase font-bold tracking-widest">
                    Partner stores
                </p>
                {canManage && (
                    <Button size="sm" variant="outline" onClick={openPicker} disabled={busy}>
                        <Store className="mr-1 h-3.5 w-3.5" />
                        Send to partner store
                    </Button>
                )}
            </div>
            {loading ? (
                <p className="text-sm text-muted-foreground">Loading stores…</p>
            ) : rows.filter((row) => row.status !== "returned").length === 0 ? (
                <p className="text-sm text-muted-foreground">Not sent to a partner store yet.</p>
            ) : (
                <ul className="space-y-2">
                    {rows
                        .filter((row) => row.status !== "returned")
                        .map((row) => (
                            <li key={row.id} className="flex items-start justify-between gap-2 text-sm">
                                <span className="min-w-0">
                                    <span className="block font-medium truncate">{row.partner_store_name || "Store"}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {optInLabel(row.program_type)}
                                        {row.sent_by_name ? ` · ${row.sent_by_name}` : ""}
                                        {row.delivered_at ? ` · ${new Date(row.delivered_at).toLocaleDateString()}` : ""}
                                    </span>
                                </span>
                                <span className="flex items-center gap-2 shrink-0">
                                    <Badge variant="secondary">{row.status.replace(/_/g, " ")}</Badge>
                                    {canManage && row.status !== "dead" && (
                                        <Button size="sm" variant="ghost" onClick={() => undo(row)} disabled={busy}>
                                            Undo
                                        </Button>
                                    )}
                                </span>
                            </li>
                        ))}
                </ul>
            )}

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="flex max-h-[min(80vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
                    <DialogHeader className="border-b px-6 py-4">
                        <DialogTitle>Send to partner store</DialogTitle>
                        <DialogDescription>
                            Choose one or more stores. Each store gets its own copy and its own recipient emails.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1 overflow-y-auto px-6 py-3">
                        {stores.length === 0 && (
                            <p className="text-sm text-muted-foreground">No active partner stores.</p>
                        )}
                        {stores.map((store) => {
                            const locked = alreadySent.has(store.id)
                            const checked = selected.includes(store.id)
                            return (
                                <label
                                    key={store.id}
                                    className="flex items-start gap-2 rounded-md px-1 py-2 hover:bg-muted/60"
                                >
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={checked}
                                        disabled={locked}
                                        onChange={() => toggle(store.id)}
                                    />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium">{store.name}</span>
                                        <span className="block text-xs text-muted-foreground">
                                            {optInLabel(store.program_type)}
                                            {rangeLabel(store) ? ` · ${rangeLabel(store)}` : ""}
                                            {locked ? " · Already sent" : ""}
                                        </span>
                                    </span>
                                </label>
                            )
                        })}
                    </div>
                    <DialogFooter className="border-t px-6 py-4">
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button onClick={confirmSend} disabled={busy}>
                            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Send
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

export type { StoreSendResult }
