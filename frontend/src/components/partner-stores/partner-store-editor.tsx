"use client"

import * as React from "react"
import { useEffect, useState } from "react"
import { Globe, Mail, MapPin, Phone, Plus, Trash2, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import apiClient from "@/lib/api-client"
import {
    PartnerStoreService,
    type InventorySourceInput,
    type LeadChannelInput,
    type PartnerStore,
    type PartnerStoreCreate,
    type StoreProfile,
} from "@/services/partner-store-service"
import { PartnerProgramService } from "@/services/partner-program-service"

export type OptIn = "leads_only" | "full_bdc"

export interface StoreFormValues extends PartnerStoreCreate {
    optIn: OptIn
    recipientEmails: string
    leadChannels: LeadChannelInput[]
    inventorySources: InventorySourceInput[]
    campaignIds: string[]
    portalEmail: string
    portalPassword: string
    hasPortalLogin: boolean
}

const emptySource = (): InventorySourceInput => ({
    source_name: "",
    source_id: "",
    platforms: [],
    inventory_urls: [{ url: "", inventory_type: "new" }],
    enabled: true,
})

export const emptyStoreForm = (): StoreFormValues => ({
    name: "",
    brand: "",
    phone: "",
    email: "",
    external_code: "",
    monthly_leads_min: null,
    monthly_leads_max: null,
    website: "",
    contact_person: "",
    address: "",
    city: "",
    state: "",
    country: "US",
    postal_code: "",
    notes: "",
    optIn: "leads_only",
    recipientEmails: "",
    leadChannels: [],
    inventorySources: [],
    campaignIds: [],
    portalEmail: "",
    portalPassword: "",
    hasPortalLogin: false,
})

export function profileFromForm(data: StoreFormValues): StoreProfile {
    return {
        opt_in: data.optIn,
        recipient_emails: data.recipientEmails.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        campaign_mapping_ids: data.campaignIds,
        lead_channels: data.leadChannels.filter((row) => row.label.trim()),
        inventory_sources: data.inventorySources
            .filter((row) => row.source_name.trim())
            .map((row) => ({
                ...row,
                source_id: row.source_id?.trim() || null,
                inventory_urls: row.inventory_urls.filter((url) => url.url.trim()),
                platforms: row.platforms.map((item) => item.trim()).filter(Boolean),
            })),
    }
}

export function PartnerStoreEditor({
    open,
    store,
    saving,
    onClose,
    onSave,
}: {
    open: boolean
    store: PartnerStore | null
    saving: boolean
    onClose: () => void
    onSave: (data: StoreFormValues) => void
}) {
    const [form, setForm] = useState<StoreFormValues>(emptyStoreForm)
    const [campaignOptions, setCampaignOptions] = useState<{ id: string; display_name: string; match_pattern?: string }[]>([])
    const [campaignQuery, setCampaignQuery] = useState("")
    const [platformDrafts, setPlatformDrafts] = useState<Record<number, string>>({})

    useEffect(() => {
        if (!open) return
        let cancelled = false
        ;(async () => {
            const next = emptyStoreForm()
            const campaignList = await apiClient
                .get<{ items: { id: string; display_name: string; match_pattern?: string }[] }>("/campaign-mappings/")
                .then((res) => res.data.items)
                .catch(() => [])
            if (cancelled) return
            setCampaignOptions(campaignList)
            if (store) {
                next.name = store.name
                next.brand = store.brand || ""
                next.phone = store.phone || ""
                next.email = store.email || ""
                next.external_code = store.external_code || ""
                next.monthly_leads_min = store.monthly_leads_min ?? null
                next.monthly_leads_max = store.monthly_leads_max ?? null
                next.website = store.website || ""
                next.contact_person = store.contact_person || ""
                next.address = store.address || ""
                next.city = store.city || ""
                next.state = store.state || ""
                next.country = store.country || "US"
                next.postal_code = store.postal_code || ""
                next.notes = store.notes || ""
                if (store.program_type === "leads_only" || store.program_type === "full_bdc") {
                    next.optIn = store.program_type
                }
                const [profile, portalUsers] = await Promise.all([
                    PartnerStoreService.getProfile(store.id).catch(() => null),
                    PartnerProgramService.listPortalUsers(store.id).catch(() => []),
                ])
                if (cancelled) return
                if (profile) {
                    next.optIn = profile.opt_in
                    next.recipientEmails = (profile.recipient_emails || []).join("\n")
                    next.campaignIds = profile.campaign_mapping_ids || []
                    next.leadChannels = profile.lead_channels || []
                    next.inventorySources = (profile.inventory_sources || []).map((row) => ({
                        ...row,
                        inventory_urls: row.inventory_urls?.length ? row.inventory_urls : [{ url: "", inventory_type: "new" }],
                        platforms: row.platforms || [],
                    }))
                }
                if (portalUsers[0]) {
                    next.portalEmail = portalUsers[0].email
                    next.hasPortalLogin = true
                }
            }
            if (!cancelled) setForm(next)
        })()
        return () => {
            cancelled = true
        }
    }, [store, open])

    const update = (field: keyof StoreFormValues, value: string) =>
        setForm((prev) => ({ ...prev, [field]: value }))

    const shownCampaigns = campaignOptions.filter((campaign) => {
        const q = campaignQuery.trim().toLowerCase()
        if (!q) return true
        return campaign.display_name.toLowerCase().includes(q) || (campaign.match_pattern || "").toLowerCase().includes(q)
    })

    function setChannel(index: number, patch: Partial<LeadChannelInput>) {
        setForm((prev) => ({
            ...prev,
            leadChannels: prev.leadChannels.map((row, i) => (i === index ? { ...row, ...patch } : row)),
        }))
    }

    function setSource(index: number, patch: Partial<InventorySourceInput>) {
        setForm((prev) => ({
            ...prev,
            inventorySources: prev.inventorySources.map((row, i) => (i === index ? { ...row, ...patch } : row)),
        }))
    }

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="flex max-h-[min(92vh,900px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
                <DialogHeader className="border-b px-6 py-4">
                    <DialogTitle>{store ? "Edit Partner Store" : "Add Partner Store"}</DialogTitle>
                    <DialogDescription>
                        Dealership details, who receives the leads, and where those leads and vehicles come from.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-5 overflow-y-auto px-6 py-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="name">Dealership name *</Label>
                            <Input id="name" value={form.name} onChange={(e) => update("name", e.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="brand">Brand</Label>
                            <Input id="brand" placeholder="Toyota" value={form.brand || ""} onChange={(e) => update("brand", e.target.value)} />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="email">Dealership email</Label>
                            <div className="relative">
                                <Mail className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input id="email" className="pl-8" type="email" value={form.email || ""} onChange={(e) => update("email", e.target.value)} />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="external_code">Dealership code</Label>
                            <Input id="external_code" placeholder="DLR_001" value={form.external_code || ""} onChange={(e) => update("external_code", e.target.value)} />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="contact_person">Contact person</Label>
                            <div className="relative">
                                <User className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input id="contact_person" className="pl-8" value={form.contact_person || ""} onChange={(e) => update("contact_person", e.target.value)} />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="phone">Phone</Label>
                            <div className="relative">
                                <Phone className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input id="phone" className="pl-8" value={form.phone || ""} onChange={(e) => update("phone", e.target.value)} />
                            </div>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="website">Website</Label>
                        <div className="relative">
                            <Globe className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input id="website" className="pl-8" value={form.website || ""} onChange={(e) => update("website", e.target.value)} />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="address">Address</Label>
                        <div className="relative">
                            <MapPin className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input id="address" className="pl-8" value={form.address || ""} onChange={(e) => update("address", e.target.value)} />
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="city">City</Label>
                            <Input id="city" value={form.city || ""} onChange={(e) => update("city", e.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="state">State</Label>
                            <Input id="state" value={form.state || ""} onChange={(e) => update("state", e.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="postal_code">Postal code</Label>
                            <Input id="postal_code" value={form.postal_code || ""} onChange={(e) => update("postal_code", e.target.value)} />
                        </div>
                    </div>

                    <div className="space-y-3 border-t pt-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <Label>What they receive</Label>
                                <Select value={form.optIn} onValueChange={(value) => setForm((prev) => ({ ...prev, optIn: value as OptIn }))}>
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="leads_only">Leads only</SelectItem>
                                        <SelectItem value="full_bdc">Leads + BDC</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1">
                                    <Label>Monthly min</Label>
                                    <Input
                                        inputMode="numeric"
                                        value={form.monthly_leads_min ?? ""}
                                        placeholder="40"
                                        onChange={(e) => setForm((prev) => ({ ...prev, monthly_leads_min: e.target.value === "" ? null : Number(e.target.value) }))}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label>Monthly max</Label>
                                    <Input
                                        inputMode="numeric"
                                        value={form.monthly_leads_max ?? ""}
                                        placeholder="80"
                                        onChange={(e) => setForm((prev) => ({ ...prev, monthly_leads_max: e.target.value === "" ? null : Number(e.target.value) }))}
                                    />
                                </div>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            The monthly range is the agreement. Admin and BDC still choose when to send, and a lead can go to more than one store.
                        </p>
                        <div className="space-y-1">
                            <Label>Leads sent to</Label>
                            <Textarea
                                rows={3}
                                placeholder={"internet@dealer.com\nbdc@dealer.com"}
                                value={form.recipientEmails}
                                onChange={(e) => update("recipientEmails", e.target.value)}
                            />
                            <p className="text-xs text-muted-foreground">One email per line. Each send goes to every address.</p>
                        </div>
                    </div>

                    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                        <div className="flex items-center justify-between">
                            <Label>Lead sources</Label>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setForm((prev) => ({
                                    ...prev,
                                    leadChannels: [...prev.leadChannels, { channel_type: "marketplace", platform: "", label: "", enabled: true }],
                                }))}
                            >
                                <Plus className="mr-1 h-3.5 w-3.5" /> Add
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">Marketplaces, websites, and other places this store&apos;s leads come from. Campaigns are listed below.</p>
                        {form.leadChannels.map((channel, index) => (
                            <div key={index} className="grid grid-cols-12 gap-2">
                                <Select value={channel.channel_type} onValueChange={(value) => setChannel(index, { channel_type: value as LeadChannelInput["channel_type"] })}>
                                    <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="marketplace">Marketplace</SelectItem>
                                        <SelectItem value="website">Website</SelectItem>
                                        <SelectItem value="other">Other</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Input className="col-span-4" placeholder="Name" value={channel.label} onChange={(e) => setChannel(index, { label: e.target.value })} />
                                <Input className="col-span-4" placeholder="facebook marketplace" value={channel.platform || ""} onChange={(e) => setChannel(index, { platform: e.target.value })} />
                                <Button type="button" size="icon" variant="ghost" className="col-span-1" onClick={() => setForm((prev) => ({ ...prev, leadChannels: prev.leadChannels.filter((_, i) => i !== index) }))}>
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        ))}
                    </div>

                    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                        <Label>Campaigns associated with this store</Label>
                        <Input value={campaignQuery} placeholder="Search campaigns" onChange={(e) => setCampaignQuery(e.target.value)} />
                        <div className="max-h-36 space-y-1 overflow-y-auto text-sm">
                            {shownCampaigns.length === 0 && <p className="text-muted-foreground">No campaigns match.</p>}
                            {shownCampaigns.map((campaign) => (
                                <label key={campaign.id} className="flex items-start gap-2 rounded-md px-1 py-1">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5"
                                        checked={form.campaignIds.includes(campaign.id)}
                                        onChange={(event) => {
                                            setForm((prev) => ({
                                                ...prev,
                                                campaignIds: event.target.checked
                                                    ? [...prev.campaignIds, campaign.id]
                                                    : prev.campaignIds.filter((id) => id !== campaign.id),
                                            }))
                                        }}
                                    />
                                    <span>{campaign.display_name}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                        <div className="flex items-center justify-between">
                            <Label>Inventory sources</Label>
                            <Button type="button" size="sm" variant="outline" onClick={() => setForm((prev) => ({ ...prev, inventorySources: [...prev.inventorySources, emptySource()] }))}>
                                <Plus className="mr-1 h-3.5 w-3.5" /> Add source
                            </Button>
                        </div>
                        {form.inventorySources.map((source, index) => (
                            <div key={index} className="space-y-2 rounded-md border bg-background p-3">
                                <div className="grid grid-cols-2 gap-2">
                                    <Input placeholder="Source name" value={source.source_name} onChange={(e) => setSource(index, { source_name: e.target.value })} />
                                    <Input placeholder="SRC_001" value={source.source_id || ""} onChange={(e) => setSource(index, { source_id: e.target.value })} />
                                </div>
                                {source.inventory_urls.map((url, urlIndex) => (
                                    <div key={urlIndex} className="grid grid-cols-12 gap-2">
                                        <Input
                                            className="col-span-8"
                                            placeholder="https://dealer.com/new-vehicles/"
                                            value={url.url}
                                            onChange={(e) => {
                                                const inventory_urls = source.inventory_urls.map((item, i) => i === urlIndex ? { ...item, url: e.target.value } : item)
                                                setSource(index, { inventory_urls })
                                            }}
                                        />
                                        <Select
                                            value={url.inventory_type}
                                            onValueChange={(value) => {
                                                const inventory_urls = source.inventory_urls.map((item, i) => i === urlIndex ? { ...item, inventory_type: value as InventorySourceInput["inventory_urls"][number]["inventory_type"] } : item)
                                                setSource(index, { inventory_urls })
                                            }}
                                        >
                                            <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="new">New</SelectItem>
                                                <SelectItem value="used">Used</SelectItem>
                                                <SelectItem value="cpo">CPO</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <Button type="button" size="icon" variant="ghost" className="col-span-1" onClick={() => setSource(index, { inventory_urls: source.inventory_urls.filter((_, i) => i !== urlIndex) })}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ))}
                                <Button type="button" size="sm" variant="ghost" onClick={() => setSource(index, { inventory_urls: [...source.inventory_urls, { url: "", inventory_type: "used" }] })}>
                                    Add URL
                                </Button>
                                <div className="flex flex-wrap items-center gap-1">
                                    {source.platforms.map((platform) => (
                                        <button
                                            key={platform}
                                            type="button"
                                            className="rounded-full border px-2 py-0.5 text-xs"
                                            onClick={() => setSource(index, { platforms: source.platforms.filter((item) => item !== platform) })}
                                        >
                                            {platform} ×
                                        </button>
                                    ))}
                                    <Input
                                        className="h-8 max-w-[220px]"
                                        placeholder="Add platform"
                                        value={platformDrafts[index] || ""}
                                        onChange={(e) => setPlatformDrafts((prev) => ({ ...prev, [index]: e.target.value }))}
                                        onKeyDown={(e) => {
                                            if (e.key !== "Enter") return
                                            e.preventDefault()
                                            const value = (platformDrafts[index] || "").trim()
                                            if (!value || source.platforms.includes(value)) return
                                            setSource(index, { platforms: [...source.platforms, value] })
                                            setPlatformDrafts((prev) => ({ ...prev, [index]: "" }))
                                        }}
                                    />
                                </div>
                                <label className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" checked={source.enabled} onChange={(e) => setSource(index, { enabled: e.target.checked })} />
                                    Enabled
                                </label>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setForm((prev) => ({ ...prev, inventorySources: prev.inventorySources.filter((_, i) => i !== index) }))}>
                                    Remove source
                                </Button>
                            </div>
                        ))}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="notes">Notes</Label>
                        <Textarea id="notes" rows={2} value={form.notes || ""} onChange={(e) => update("notes", e.target.value)} />
                    </div>

                    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                        <Label>Partner portal login</Label>
                        <p className="text-xs text-muted-foreground">
                            {form.hasPortalLogin ? "A login already exists. Leave the password blank to keep it." : "Leave both blank if they do not need a login yet."}
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                            <Input type="email" value={form.portalEmail} placeholder="store@dealer.com" onChange={(e) => update("portalEmail", e.target.value)} />
                            <Input type="password" value={form.portalPassword} placeholder={form.hasPortalLogin ? "Unchanged" : "At least 8 characters"} onChange={(e) => update("portalPassword", e.target.value)} />
                        </div>
                    </div>
                </div>
                <DialogFooter className="border-t px-6 py-4">
                    <Button variant="outline" onClick={onClose}>Cancel</Button>
                    <Button
                        onClick={() => {
                            const inventorySources = form.inventorySources.map((source, index) => {
                                const draft = (platformDrafts[index] || "").trim()
                                if (!draft || source.platforms.includes(draft)) return source
                                return { ...source, platforms: [...source.platforms, draft] }
                            })
                            onSave({ ...form, inventorySources })
                        }}
                        disabled={saving || !form.name.trim()}
                    >
                        {saving ? "Saving..." : store ? "Update" : "Create"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
