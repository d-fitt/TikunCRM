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
import { LeadNotesPanel } from "@/components/leads/lead-notes-modal"
import { Checkbox } from "@/components/ui/checkbox"
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

type YesNo = "" | "yes" | "no"

function optInLabel(programType?: string | null) {
    return programType === "full_bdc" ? "Leads + BDC" : "Leads only"
}

function moneyLabel(raw: string) {
    const cleaned = raw.replace(/[$,]/g, "").trim()
    if (!cleaned) return ""
    const amount = Number(cleaned)
    if (Number.isNaN(amount)) return raw.trim()
    if (amount === Math.trunc(amount)) return `$${Math.trunc(amount).toLocaleString("en-US")}`
    return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function yesNoLabel(value: YesNo) {
    if (value === "yes") return "Yes"
    if (value === "no") return "No"
    return ""
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

function YesNoToggle({
    value,
    onChange,
}: {
    value: YesNo
    onChange: (value: YesNo) => void
}) {
    return (
        <div className="flex gap-2">
            {(["yes", "no"] as const).map((option) => (
                <button
                    key={option}
                    type="button"
                    onClick={() => onChange(value === option ? "" : option)}
                    className={cn(
                        "h-9 flex-1 rounded-md border text-sm font-medium",
                        value === option
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-input text-muted-foreground hover:bg-muted/60",
                    )}
                >
                    {option === "yes" ? "Yes" : "No"}
                </button>
            ))}
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
    const [city, setCity] = React.useState("")
    const [state, setState] = React.useState("")
    const [downPayment, setDownPayment] = React.useState("")
    const [lookingFor, setLookingFor] = React.useState("")
    const [brand, setBrand] = React.useState("")
    const [budget, setBudget] = React.useState("")
    const [business, setBusiness] = React.useState<YesNo>("")
    const [hasSsn, setHasSsn] = React.useState<YesNo>("")
    const [hasDl, setHasDl] = React.useState<YesNo>("")
    const alreadySent = React.useMemo(() => new Set(sentStoreIds), [sentStoreIds])
    const freshCount = selected.filter((id) => !alreadySent.has(id)).length
    const previewRows = [
        { label: "Phone", value: formatUsPhone(lead?.customer?.phone) },
        { label: "City", value: city.trim() },
        { label: "State", value: state.trim() },
        { label: "ZIP", value: postalCode.trim() },
        { label: "Looking for", value: lookingFor.trim() },
        { label: "Brand", value: brand.trim() },
        { label: "Budget", value: moneyLabel(budget) },
        { label: "Down payment", value: moneyLabel(downPayment) },
        { label: "Has business", value: yesNoLabel(business) },
        { label: "Has SSN", value: hasSsn === "yes" ? "Yes" : "" },
        { label: "Has license", value: hasDl === "yes" ? "Yes" : "" },
    ].filter((row) => row.value)

    async function openPicker(event: React.MouseEvent) {
        event.stopPropagation()
        setOpen(true)
        setSelected(sentStoreIds)
        try {
            const [res, row] = await Promise.all([
                PartnerStoreService.list({ active_only: true, fresh: true }),
                LeadService.getLead(leadId),
            ])
            setStores(res.items || [])
            setLead(row)
            setPostalCode(row.customer?.postal_code || "")
            setCity(row.customer?.city || "")
            setState(row.customer?.state || "")
            setDownPayment(row.down_payment != null ? String(row.down_payment) : "")
            setLookingFor(row.interested_in || "")
            setBrand(row.interested_brand || "")
            setBudget(row.budget_range || "")
            setBusiness(row.is_business == null ? "" : row.is_business ? "yes" : "no")
            setHasSsn(row.has_ssn_stip ? "yes" : "no")
            setHasDl(row.has_dl_stip ? "yes" : "no")
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
                city: city.trim(),
                state: state.trim(),
                down_payment: parsedDown,
                is_business: business === "" ? null : business === "yes",
                has_ssn_stip: hasSsn === "" ? null : hasSsn === "yes",
                has_dl_stip: hasDl === "" ? null : hasDl === "yes",
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
                <DialogContent className="flex h-[min(92vh,900px)] w-[min(1120px,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden p-0">
                    <DialogHeader className="border-b px-6 py-4 pr-12">
                        <DialogTitle>Send to partner store</DialogTitle>
                        <DialogDescription>
                            Notes stay on the left. The preview on the right is exactly what the email will include.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1">
                        <aside className="flex min-h-0 flex-col overflow-hidden border-b bg-muted/30 lg:border-b-0 lg:border-r">
                            <div className="border-b px-4 py-3">
                                <p className="text-sm font-semibold">Notes</p>
                                <p className="text-xs text-muted-foreground">{leadName(lead)}</p>
                            </div>
                            <div className="max-h-56 overflow-y-auto px-4 py-3 lg:max-h-none lg:min-h-0 lg:flex-1">
                                <LeadNotesPanel leadId={open ? leadId : null} leadNotes={lead?.notes} active={open} />
                            </div>
                        </aside>
                        <div className="min-h-0 overflow-y-auto px-6 py-5">
                            <div className="space-y-6">
                                <section className="overflow-hidden rounded-xl border">
                                    <div className="bg-stone-900 px-5 py-4 text-white">
                                        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400">Email preview</p>
                                        <p className="mt-1 text-lg font-semibold">{leadName(lead)}</p>
                                    </div>
                                    {previewRows.length === 0 ? (
                                        <p className="px-5 py-4 text-sm text-muted-foreground">
                                            Details show here as you fill them in.
                                        </p>
                                    ) : (
                                        <dl className="divide-y px-5">
                                            {previewRows.map((row) => (
                                                <div key={row.label} className="grid grid-cols-[132px_minmax(0,1fr)] items-baseline gap-3 py-2.5">
                                                    <dt className="text-sm text-muted-foreground">{row.label}</dt>
                                                    <dd className="text-sm font-medium">{row.value}</dd>
                                                </div>
                                            ))}
                                        </dl>
                                    )}
                                </section>

                                <section className="space-y-2">
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stores</p>
                                    </div>
                                    {stores.length === 0 && (
                                        <p className="text-sm text-muted-foreground">No active partner stores.</p>
                                    )}
                                    <div className="space-y-2">
                                        {stores.map((store) => {
                                            const locked = alreadySent.has(store.id)
                                            const checked = selected.includes(store.id)
                                            const month = store.leads_sent_this_month ?? 0
                                            const over = store.monthly_leads_max != null && month > store.monthly_leads_max
                                            const target = store.monthly_leads_min != null && store.monthly_leads_max != null
                                                ? `${store.monthly_leads_min}–${store.monthly_leads_max} / month`
                                                : null
                                            return (
                                                <div
                                                    key={store.id}
                                                    role="checkbox"
                                                    aria-checked={checked}
                                                    aria-disabled={locked}
                                                    onClick={() => {
                                                        if (!locked) toggle(store.id)
                                                    }}
                                                    className={cn(
                                                        "flex items-center gap-3 rounded-xl border px-3 py-3",
                                                        locked ? "bg-muted/40 text-muted-foreground" : "cursor-pointer hover:bg-muted/30",
                                                        checked && !locked && "border-primary/50 bg-primary/5",
                                                    )}
                                                >
                                                    <Checkbox
                                                        checked={checked}
                                                        disabled={locked}
                                                        onClick={(event) => event.stopPropagation()}
                                                        onCheckedChange={() => toggle(store.id)}
                                                    />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-sm font-medium">{store.name}</span>
                                                        <span className="mt-0.5 block text-xs text-muted-foreground">
                                                            {optInLabel(store.program_type)}
                                                            {locked ? " · Already sent" : ""}
                                                            {target ? ` · Target ${target}` : ""}
                                                        </span>
                                                    </span>
                                                    <span className="flex shrink-0 items-stretch gap-4 border-l pl-4">
                                                        <span className="min-w-[4.25rem] text-right">
                                                            <span className="block text-base font-semibold tabular-nums leading-none">{store.leads_sent ?? 0}</span>
                                                            <span className="mt-1 block text-[10px] uppercase tracking-wide text-muted-foreground">With store</span>
                                                        </span>
                                                        <span className="min-w-[4.25rem] text-right">
                                                            <span className={cn("block text-base font-semibold tabular-nums leading-none", over && "text-amber-700")}>{month}</span>
                                                            <span className={cn("mt-1 block text-[10px] uppercase tracking-wide text-muted-foreground", over && "text-amber-700")}>
                                                                {over ? "Over target" : "This month"}
                                                            </span>
                                                        </span>
                                                    </span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </section>

                                <section className="space-y-3">
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Edit the email</p>
                                        <p className="mt-1 text-xs text-muted-foreground">Changes update the preview and are saved on the lead when you send.</p>
                                    </div>
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
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                        <Field label="Has business">
                                            <YesNoToggle value={business} onChange={setBusiness} />
                                        </Field>
                                        <Field label="Has SSN">
                                            <YesNoToggle value={hasSsn} onChange={setHasSsn} />
                                        </Field>
                                        <Field label="Has license">
                                            <YesNoToggle value={hasDl} onChange={setHasDl} />
                                        </Field>
                                    </div>
                                </section>
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="border-t px-6 py-4">
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button onClick={confirmSend} disabled={busy || freshCount === 0}>
                            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {freshCount > 0 ? `Send to ${freshCount} ${freshCount === 1 ? "store" : "stores"}` : "Choose a store"}
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
