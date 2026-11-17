"use client"

import * as React from "react"
import { Loader2, Store } from "lucide-react"
import { PartnerProgramService, type LeadDeliveryRow } from "@/services/partner-program-service"
import {
    PartnerStoreService,
    type PartnerStore,
    type StoreSendResult,
} from "@/services/partner-store-service"
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
import { useBrowserTimezone } from "@/hooks/use-browser-timezone"
import { formatDateInTimezone } from "@/utils/timezone"

function optInLabel(programType?: string | null) {
    return programType === "full_bdc" ? "Leads + BDC" : "Leads only"
}

function rangeLabel(store: PartnerStore) {
    if (store.monthly_leads_min == null || store.monthly_leads_max == null) return null
    return `${store.monthly_leads_min}–${store.monthly_leads_max} / month`
}

function statusLabel(status: string) {
    if (status === "delivered") return "Sent"
    return status.replace(/_/g, " ")
}

export function SendPartnerStoreButton({
    leadId,
    sentStoreIds = [],
    onSent,
    label = "Send",
    quiet = false,
}: {
    leadId: string
    sentStoreIds?: string[]
    onSent?: (results: StoreSendResult[]) => void
    label?: string
    quiet?: boolean
}) {
    const { toast } = useToast()
    const [open, setOpen] = React.useState(false)
    const [stores, setStores] = React.useState<PartnerStore[]>([])
    const [selected, setSelected] = React.useState<string[]>([])
    const [busy, setBusy] = React.useState(false)
    const alreadySent = React.useMemo(() => new Set(sentStoreIds), [sentStoreIds])

    async function openPicker(event: React.MouseEvent) {
        event.stopPropagation()
        setOpen(true)
        setSelected(sentStoreIds)
        try {
            const res = await PartnerStoreService.list({ active_only: true })
            setStores(res.items || [])
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
            const warning = result.results.find((item) => item.email_error)?.email_error
            toast({
                title: sent.length
                    ? `Sent to ${sent.map((item) => item.partner_store_name).join(", ")}`
                    : "Already sent",
                description: warning || undefined,
            })
            setOpen(false)
            onSent?.(result.results)
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

    return (
        <>
            {quiet ? (
                <button
                    type="button"
                    onClick={openPicker}
                    disabled={busy}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed border-slate-300 bg-white px-2 text-xs font-medium text-slate-600 hover:border-primary hover:bg-primary/5 hover:text-primary disabled:opacity-50"
                >
                    <Store className="h-3.5 w-3.5" />
                    {label}
                </button>
            ) : (
                <Button size="sm" variant="outline" onClick={openPicker} disabled={busy}>
                    <Store className="mr-1 h-3.5 w-3.5" />
                    {label}
                </Button>
            )}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="flex max-h-[min(80vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
                    <DialogHeader className="border-b px-6 py-4">
                        <DialogTitle>Send to partner store</DialogTitle>
                        <DialogDescription>
                            Pick one or more stores. Each store is emailed on its own.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1 overflow-y-auto px-6 py-3">
                        {stores.length === 0 && (
                            <p className="text-sm text-muted-foreground">No active partner stores.</p>
                        )}
                        {stores.map((store) => {
                            const locked = alreadySent.has(store.id)
                            return (
                                <label
                                    key={store.id}
                                    className="flex items-start gap-2 rounded-md px-1 py-2 hover:bg-muted/60"
                                >
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={selected.includes(store.id)}
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
        </>
    )
}

export function LeadDeliveries({
    leadId,
    canManage,
    knownStores = [],
    onStoresChange,
}: {
    leadId: string
    canManage: boolean
    knownStores?: { id: string; name: string }[]
    onStoresChange?: (storeIds: string[]) => void
}) {
    const { toast } = useToast()
    const { timezone } = useBrowserTimezone()
    const [rows, setRows] = React.useState<LeadDeliveryRow[]>([])
    const [hiddenIds, setHiddenIds] = React.useState<string[]>([])
    const [loading, setLoading] = React.useState(true)
    const [busy, setBusy] = React.useState(false)

    const activeRows = rows.filter((row) => row.status !== "returned" && row.status !== "dead")
    const shownStores = React.useMemo(() => {
        const hidden = new Set(hiddenIds)
        const byId = new Map<string, { id: string; name: string; row?: LeadDeliveryRow }>()
        for (const store of knownStores) {
            if (store.id && !hidden.has(store.id)) byId.set(store.id, { id: store.id, name: store.name })
        }
        for (const row of activeRows) {
            byId.set(row.partner_store_id, {
                id: row.partner_store_id,
                name: row.partner_store_name || byId.get(row.partner_store_id)?.name || "Store",
                row,
            })
        }
        return Array.from(byId.values())
    }, [activeRows, knownStores, hiddenIds])
    const sentIds = shownStores.map((store) => store.id)

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

    async function removeSend(row: LeadDeliveryRow) {
        setBusy(true)
        try {
            await PartnerProgramService.returnDelivery(leadId, row.id)
            setHiddenIds((prev) => (prev.includes(row.partner_store_id) ? prev : [...prev, row.partner_store_id]))
            await load()
        } catch {
            toast({ title: "Could not remove that store", variant: "destructive" })
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground uppercase font-bold tracking-widest">
                    Sent to
                </p>
                {canManage && (
                    <SendPartnerStoreButton
                        leadId={leadId}
                        sentStoreIds={sentIds}
                        label={shownStores.length ? "Send to other stores" : "Send to store"}
                        onSent={() => load()}
                    />
                )}
            </div>
            {loading && shownStores.length === 0 ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ) : shownStores.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not sent yet.</p>
            ) : (
                <ul className="space-y-2">
                    {shownStores.map((store) => (
                        <li key={store.id} className="flex items-start justify-between gap-2 text-sm">
                            <span className="min-w-0">
                                <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-sm font-medium text-slate-800">
                                    <Store className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                    <span className="truncate">{store.name}</span>
                                </span>
                                {store.row && (
                                    <span className="mt-1 block text-xs text-muted-foreground">
                                        {statusLabel(store.row.status)}
                                        {store.row.delivered_at
                                            ? ` · ${formatDateInTimezone(store.row.delivered_at, timezone, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                                            : ""}
                                        {store.row.sent_by_name ? ` · ${store.row.sent_by_name}` : ""}
                                    </span>
                                )}
                            </span>
                            {canManage && store.row && (
                                <Button size="sm" variant="ghost" onClick={() => removeSend(store.row as LeadDeliveryRow)} disabled={busy}>
                                    Remove
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
