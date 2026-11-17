"use client"

import * as React from "react"
import { Loader2, Plus, Store } from "lucide-react"
import { PartnerProgramService, type LeadDeliveryRow } from "@/services/partner-program-service"
import {
    PartnerStoreService,
    type PartnerStore,
    type StoreSendResult,
} from "@/services/partner-store-service"
import { LeadService, type Lead } from "@/services/lead-service"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
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

function formatUsPhone(raw?: string | null) {
    const digits = (raw || "").replace(/\D/g, "")
    const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
    if (national.length === 10) {
        return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`
    }
    return (raw || "").trim()
}

function leadName(lead: Lead | null) {
    const customer = lead?.customer
    const name = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim()
    return name || "This lead"
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
            {children}
        </div>
    )
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
    const [lead, setLead] = React.useState<Lead | null>(null)
    const [postalCode, setPostalCode] = React.useState("")
    const [email, setEmail] = React.useState("")
    const [city, setCity] = React.useState("")
    const [state, setState] = React.useState("")
    const [downPayment, setDownPayment] = React.useState("")
    const [lookingFor, setLookingFor] = React.useState("")
    const [brand, setBrand] = React.useState("")
    const [budget, setBudget] = React.useState("")
    const [business, setBusiness] = React.useState<"" | "yes" | "no">("")
    const alreadySent = React.useMemo(() => new Set(sentStoreIds), [sentStoreIds])

    async function openPicker(event: React.MouseEvent) {
        event.stopPropagation()
        setOpen(true)
        setSelected(sentStoreIds)
        try {
            const [res, row] = await Promise.all([
                PartnerStoreService.list({ active_only: true }),
                LeadService.getLead(leadId),
            ])
            setStores(res.items || [])
            setLead(row)
            setPostalCode(row.customer?.postal_code || "")
            setEmail(row.customer?.email || "")
            setCity(row.customer?.city || "")
            setState(row.customer?.state || "")
            setDownPayment(row.down_payment != null ? String(row.down_payment) : "")
            setLookingFor(row.interested_in || "")
            setBrand(row.interested_brand || "")
            setBudget(row.budget_range || "")
            setBusiness(row.is_business == null ? "" : row.is_business ? "yes" : "no")
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
            const down = downPayment.trim()
            const parsedDown = down ? Number(down.replace(/[$,]/g, "")) : undefined
            if (parsedDown != null && Number.isNaN(parsedDown)) {
                toast({ title: "Enter a valid down payment or leave it blank" })
                setBusy(false)
                return
            }
            const result = await PartnerStoreService.sendLead(leadId, fresh, {
                postal_code: postalCode.trim(),
                email: email.trim(),
                city: city.trim(),
                state: state.trim(),
                down_payment: parsedDown,
                is_business: business === "" ? null : business === "yes",
                interested_in: lookingFor.trim(),
                interested_brand: brand.trim(),
                budget_range: budget.trim(),
            })
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
                    className="inline-flex h-6 items-center gap-1 whitespace-nowrap text-xs font-medium text-primary hover:underline disabled:opacity-50"
                >
                    <Plus className="h-3 w-3" />
                    {label}
                </button>
            ) : (
                <Button size="sm" variant="outline" onClick={openPicker} disabled={busy}>
                    <Store className="mr-1 h-3.5 w-3.5" />
                    {label}
                </Button>
            )}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="flex max-h-[min(86vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
                    <DialogHeader className="border-b px-6 py-4">
                        <DialogTitle>Send to partner store</DialogTitle>
                        <DialogDescription>
                            Choose the stores. Filled details are saved on the lead and included in the email.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-5 overflow-y-auto px-6 py-5">
                        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
                            <p className="text-sm font-semibold">{leadName(lead)}</p>
                            <p className="text-sm text-muted-foreground">{formatUsPhone(lead?.customer?.phone) || "No phone yet"}</p>
                        </div>
                        <div className="space-y-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stores</p>
                            {stores.length === 0 && (
                                <p className="text-sm text-muted-foreground">No active partner stores.</p>
                            )}
                            <div className="space-y-1.5">
                                {stores.map((store) => {
                                    const locked = alreadySent.has(store.id)
                                    const checked = selected.includes(store.id)
                                    return (
                                        <label
                                            key={store.id}
                                            className={cn(
                                                "flex items-center gap-3 rounded-lg border px-3 py-2.5",
                                                locked ? "bg-muted/40 text-muted-foreground" : "cursor-pointer hover:bg-muted/40",
                                                checked && !locked && "border-primary/40 bg-primary/5",
                                            )}
                                        >
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4"
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
                        </div>
                        <div className="space-y-3">
                            <div>
                                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Lead details</p>
                                <p className="mt-1 text-xs text-muted-foreground">A blank field is left off the email.</p>
                            </div>
                            <Field label="Email">
                                <Input id="send-email" type="email" value={email} placeholder="name@email.com" onChange={(event) => setEmail(event.target.value)} />
                            </Field>
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="City">
                                    <Input value={city} placeholder="Atlanta" onChange={(event) => setCity(event.target.value)} />
                                </Field>
                                <Field label="State">
                                    <Input value={state} placeholder="GA" onChange={(event) => setState(event.target.value)} />
                                </Field>
                                <Field label="ZIP">
                                    <Input value={postalCode} placeholder="30349" onChange={(event) => setPostalCode(event.target.value)} />
                                </Field>
                                <Field label="Down payment">
                                    <Input inputMode="decimal" value={downPayment} placeholder="2000" onChange={(event) => setDownPayment(event.target.value)} />
                                </Field>
                                <Field label="Looking for">
                                    <Input value={lookingFor} placeholder="Explorer" onChange={(event) => setLookingFor(event.target.value)} />
                                </Field>
                                <Field label="Brand">
                                    <Input value={brand} placeholder="Ford" onChange={(event) => setBrand(event.target.value)} />
                                </Field>
                            </div>
                            <Field label="Budget">
                                <Input value={budget} placeholder="25000" onChange={(event) => setBudget(event.target.value)} />
                            </Field>
                            <Field label="Has business">
                                <div className="flex gap-2">
                                    {(["yes", "no"] as const).map((value) => (
                                        <button
                                            key={value}
                                            type="button"
                                            onClick={() => setBusiness((current) => (current === value ? "" : value))}
                                            className={cn(
                                                "h-9 flex-1 rounded-md border text-sm font-medium",
                                                business === value
                                                    ? "border-primary bg-primary/10 text-primary"
                                                    : "border-input text-muted-foreground hover:bg-muted/60",
                                            )}
                                        >
                                            {value === "yes" ? "Yes" : "No"}
                                        </button>
                                    ))}
                                </div>
                            </Field>
                        </div>
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
