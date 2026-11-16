"use client"

import * as React from "react"
import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import {
    Store,
    Plus,
    Search,
    Phone,
    Pencil,
    Trash2,
    User,
    RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
    Card,
    CardContent,
    CardHeader,
} from "@/components/ui/card"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { useRole } from "@/hooks/use-role"
import { useToast } from "@/hooks/use-toast"
import {
    PartnerStoreService,
    type PartnerStore,
    type PartnerStoreCreate,
} from "@/services/partner-store-service"
import { PartnerProgramService } from "@/services/partner-program-service"
import {
    PartnerStoreEditor,
    profileFromForm,
    type StoreFormValues,
} from "@/components/partner-stores/partner-store-editor"

export default function PartnerStoresPage() {
    const { isSuperAdmin, isManagerOrAbove } = useRole()
    const { toast } = useToast()

    const [stores, setStores] = useState<PartnerStore[]>([])
    const [brands, setBrands] = useState<string[]>([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState("")
    const [brandFilter, setBrandFilter] = useState<string>("all")
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [editingStore, setEditingStore] = useState<PartnerStore | null>(null)
    const [draftId, setDraftId] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    const loadStores = useCallback(async () => {
        setLoading(true)
        try {
            const params: Record<string, unknown> = {}
            if (search) params.search = search
            if (brandFilter && brandFilter !== "all") params.brand = brandFilter
            const res = await PartnerStoreService.list(params as never)
            setStores(res.items)
        } catch {
            toast({ title: "Error", description: "Failed to load partner stores", variant: "destructive" })
        } finally {
            setLoading(false)
        }
    }, [search, brandFilter, toast])

    const loadBrands = useCallback(async () => {
        try {
            const b = await PartnerStoreService.getBrands()
            setBrands(b)
        } catch { /* ignore */ }
    }, [])

    useEffect(() => { loadStores() }, [loadStores])
    useEffect(() => { loadBrands() }, [loadBrands])

    const handleSave = async (data: StoreFormValues) => {
        setSaving(true)
        try {
            const monthlyMin = Number.isFinite(data.monthly_leads_min as number) ? data.monthly_leads_min : null
            const monthlyMax = Number.isFinite(data.monthly_leads_max as number) ? data.monthly_leads_max : null
            const storePayload: PartnerStoreCreate = {
                name: data.name,
                brand: data.brand,
                phone: data.phone,
                email: data.email,
                external_code: data.external_code || null,
                monthly_leads_min: monthlyMin,
                monthly_leads_max: monthlyMax,
                website: data.website,
                contact_person: data.contact_person,
                address: data.address,
                city: data.city,
                state: data.state,
                country: data.country,
                postal_code: data.postal_code,
                notes: data.notes,
            }
            const existingId = editingStore?.id || draftId
            const saved = existingId
                ? await PartnerStoreService.update(existingId, storePayload)
                : await PartnerStoreService.create(storePayload)
            if (!editingStore) setDraftId(saved.id)
            await PartnerStoreService.saveProfile(saved.id, profileFromForm(data))
            if (data.portalEmail.trim() && data.portalPassword.trim()) {
                await PartnerProgramService.createPortalUser(saved.id, {
                    email: data.portalEmail.trim(),
                    password: data.portalPassword,
                })
            }
            toast({
                title: editingStore ? "Updated" : "Created",
                description: `${data.name} saved`,
            })
            setShowCreateModal(false)
            setEditingStore(null)
            loadStores()
            loadBrands()
        } catch (err: unknown) {
            const detail =
                err && typeof err === "object" && "response" in err
                    ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
                    : undefined
            toast({
                title: "Error",
                description: typeof detail === "string" ? detail : "Failed to save partner store",
                variant: "destructive",
            })
            loadStores()
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async (store: PartnerStore) => {
        if (!confirm(`Deactivate "${store.name}"? This can be undone.`)) return
        try {
            await PartnerStoreService.delete(store.id)
            toast({ title: "Deactivated", description: `${store.name} deactivated` })
            loadStores()
        } catch {
            toast({ title: "Error", description: "Failed to deactivate store", variant: "destructive" })
        }
    }

    return (
        <div className="flex-1 space-y-4 p-4 md:p-6 pt-4">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">Partner Stores</h2>
                    <p className="text-muted-foreground">
                        Dealerships your admin and BDC team can send leads to.
                    </p>
                </div>
                {isManagerOrAbove && (
                    <Button onClick={() => { setEditingStore(null); setDraftId(null); setShowCreateModal(true) }}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add Partner Store
                    </Button>
                )}
            </div>

            <Card>
                <CardHeader className="pb-3">
                    <div className="flex flex-col sm:flex-row gap-3">
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search stores..."
                                className="pl-8"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                        <Select value={brandFilter} onValueChange={setBrandFilter}>
                            <SelectTrigger className="w-[180px]">
                                <SelectValue placeholder="All Brands" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Brands</SelectItem>
                                {brands.map((b) => (
                                    <SelectItem key={b} value={b}>{b}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button variant="outline" size="icon" onClick={loadStores}>
                            <RefreshCw className="h-4 w-4" />
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-muted-foreground">
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading...
                        </div>
                    ) : stores.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <Store className="h-12 w-12 text-muted-foreground/50 mb-3" />
                            <p className="text-lg font-medium">No partner stores yet</p>
                            <p className="text-sm text-muted-foreground mt-1">
                                Add your first partner store to start connecting approved customers.
                            </p>
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Brand</TableHead>
                                    <TableHead className="hidden md:table-cell">Location</TableHead>
                                    <TableHead className="hidden md:table-cell">Contact</TableHead>
                                    <TableHead>Receives</TableHead>
                                    <TableHead>Status</TableHead>
                                    {isManagerOrAbove && <TableHead className="text-right">Actions</TableHead>}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {stores.map((store) => (
                                    <TableRow key={store.id}>
                                        <TableCell className="font-medium">
                                            <Link href={`/partner-stores/${store.id}`} className="hover:underline">
                                                {store.name}
                                            </Link>
                                            {store.monthly_leads_min != null && store.monthly_leads_max != null && (
                                                <p className="text-xs text-muted-foreground">
                                                    {store.monthly_leads_min}–{store.monthly_leads_max} leads / month
                                                </p>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {store.brand ? (
                                                <Badge variant="outline">{store.brand}</Badge>
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="hidden md:table-cell">
                                            {store.city && store.state
                                                ? `${store.city}, ${store.state}`
                                                : store.city || store.state || "—"}
                                        </TableCell>
                                        <TableCell className="hidden md:table-cell">
                                            <div className="flex flex-col gap-0.5 text-sm">
                                                {store.contact_person && (
                                                    <span className="flex items-center gap-1">
                                                        <User className="h-3 w-3" /> {store.contact_person}
                                                    </span>
                                                )}
                                                {store.phone && (
                                                    <span className="flex items-center gap-1">
                                                        <Phone className="h-3 w-3" /> {store.phone}
                                                    </span>
                                                )}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline">
                                                {store.program_type === "full_bdc" ? "Leads + BDC" : store.program_type === "leads_only" ? "Leads only" : "Not set"}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={store.is_active ? "default" : "secondary"}>
                                                {store.is_active ? "Active" : "Inactive"}
                                            </Badge>
                                        </TableCell>
                                        {isManagerOrAbove && (
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => { setDraftId(null); setEditingStore(store); setShowCreateModal(true) }}
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                    </Button>
                                                    {isSuperAdmin && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => handleDelete(store)}
                                                        >
                                                            <Trash2 className="h-4 w-4 text-destructive" />
                                                        </Button>
                                                    )}
                                                </div>
                                            </TableCell>
                                        )}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <PartnerStoreEditor
                open={showCreateModal}
                store={editingStore}
                saving={saving}
                onClose={() => { setShowCreateModal(false); setEditingStore(null); setDraftId(null) }}
                onSave={handleSave}
            />
        </div>
    )
}

