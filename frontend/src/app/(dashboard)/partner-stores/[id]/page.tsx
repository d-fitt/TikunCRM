"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import {
    PartnerStoreService,
    type PartnerStoreDashboard,
} from "@/services/partner-store-service"

function optInLabel(value?: string | null) {
    if (value === "full_bdc") return "Leads + BDC"
    if (value === "leads_only") return "Leads only"
    return "Not set"
}

function rangeWord(value?: string | null) {
    if (value === "below") return "Below range"
    if (value === "above") return "Above range"
    if (value === "in_range") return "In range"
    return "No range set"
}

export default function PartnerStoreDashboardPage() {
    const params = useParams()
    const storeId = params.id as string
    const [data, setData] = React.useState<PartnerStoreDashboard | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [loading, setLoading] = React.useState(true)

    const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            setData(await PartnerStoreService.dashboard(storeId))
        } catch {
            setError("Could not load this partner store.")
        } finally {
            setLoading(false)
        }
    }, [storeId])

    React.useEffect(() => {
        load()
    }, [load])

    if (loading && !data) {
        return <div className="p-6 text-muted-foreground">Loading store…</div>
    }
    if (error || !data) {
        return (
            <div className="space-y-3 p-6">
                <p className="text-sm text-destructive">{error || "Store not found."}</p>
                <Button variant="outline" asChild>
                    <Link href="/partner-stores">Back to stores</Link>
                </Button>
            </div>
        )
    }

    const location = [data.city, data.state].filter(Boolean).join(", ")
    const monthLabel = data.monthly_leads_min != null && data.monthly_leads_max != null
        ? `${data.sent_this_month} of ${data.monthly_leads_min}–${data.monthly_leads_max}`
        : `${data.sent_this_month} this month`

    return (
        <div className="flex-1 space-y-4 p-4 md:p-6">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <Link href="/partner-stores" className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="mr-1 h-4 w-4" /> Partner stores
                    </Link>
                    <h2 className="text-2xl font-bold tracking-tight">{data.name}</h2>
                    <p className="text-sm text-muted-foreground">
                        {optInLabel(data.opt_in)}
                        {data.brand ? ` · ${data.brand}` : ""}
                        {location ? ` · ${location}` : ""}
                    </p>
                </div>
                <Button variant="outline" size="icon" onClick={load} disabled={loading}>
                    <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">This month</CardTitle></CardHeader>
                    <CardContent>
                        <p className="text-2xl font-semibold">{monthLabel}</p>
                        <p className="text-xs text-muted-foreground">
                            {data.leads_sent ?? data.metrics.total_sent} still with this store · {rangeWord(data.range_position)}
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Total sent</CardTitle></CardHeader>
                    <CardContent><p className="text-2xl font-semibold">{data.metrics.total_sent}</p></CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Sold here</CardTitle></CardHeader>
                    <CardContent><p className="text-2xl font-semibold">{data.metrics.sold}</p></CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Status</CardTitle></CardHeader>
                    <CardContent>
                        <Badge variant={data.is_active ? "default" : "secondary"}>{data.is_active ? "Active" : "Inactive"}</Badge>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader><CardTitle className="text-base">Store</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-sm">
                        <p>Dealership email: {data.email || "—"}</p>
                        <p>Phone: {data.phone || "—"}</p>
                        <p>Contact: {data.contact_person || "—"}</p>
                        <p>Code: {data.external_code || "—"}</p>
                        <div>
                            <p className="mb-1 font-medium">Leads sent to</p>
                            {data.recipient_emails.length === 0 ? (
                                <p className="text-muted-foreground">No recipient emails yet.</p>
                            ) : (
                                <ul className="list-disc pl-5">
                                    {data.recipient_emails.map((email) => <li key={email}>{email}</li>)}
                                </ul>
                            )}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader><CardTitle className="text-base">Who sent them</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-sm">
                        {data.metrics.by_sender.length === 0 && <p className="text-muted-foreground">No sends yet.</p>}
                        {data.metrics.by_sender.map((row) => (
                            <div key={row.user_id || row.name} className="flex justify-between gap-3">
                                <span>{row.name}</span>
                                <span className="font-medium">{row.count}</span>
                            </div>
                        ))}
                        {data.metrics.by_status.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-2">
                                {data.metrics.by_status.map((row) => (
                                    <Badge key={row.status} variant="outline">
                                        {row.status.replace(/_/g, " ")} · {row.count}
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader><CardTitle className="text-base">Lead sources</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-sm">
                        {data.campaigns.map((row) => (
                            <div key={row.campaign_mapping_id} className="flex items-center justify-between gap-2">
                                <span>{row.label}</span>
                                <Badge variant="outline">Campaign</Badge>
                            </div>
                        ))}
                        {data.lead_channels.map((row, index) => (
                            <div key={`${row.label}-${index}`} className="flex items-center justify-between gap-2">
                                <span>
                                    {row.label}
                                    {row.platform ? <span className="text-muted-foreground"> · {row.platform}</span> : null}
                                </span>
                                <Badge variant="outline">{row.enabled ? row.channel_type : "Off"}</Badge>
                            </div>
                        ))}
                        {data.campaigns.length === 0 && data.lead_channels.length === 0 && (
                            <p className="text-muted-foreground">No lead sources yet.</p>
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader><CardTitle className="text-base">Inventory sources</CardTitle></CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        {data.inventory_sources.length === 0 && <p className="text-muted-foreground">No inventory sources yet.</p>}
                        {data.inventory_sources.map((source) => (
                            <div key={source.source_id || source.source_name} className="space-y-1">
                                <p className="font-medium">
                                    {source.source_name}
                                    {source.source_id ? <span className="ml-2 text-xs text-muted-foreground">{source.source_id}</span> : null}
                                    {!source.enabled && <Badge variant="secondary" className="ml-2">Off</Badge>}
                                </p>
                                <div className="flex flex-wrap gap-1">
                                    {(source.platforms || []).map((platform) => (
                                        <Badge key={platform} variant="outline">{platform}</Badge>
                                    ))}
                                </div>
                                <ul className="text-muted-foreground">
                                    {source.inventory_urls.map((url) => (
                                        <li key={url.url}>{url.inventory_type}: {url.url}</li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader><CardTitle className="text-base">Leads sent here</CardTitle></CardHeader>
                <CardContent>
                    {data.leads.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No leads have been sent to this store.</p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Customer</TableHead>
                                    <TableHead>Sent by</TableHead>
                                    <TableHead>When</TableHead>
                                    <TableHead>Store status</TableHead>
                                    <TableHead>Lead outcome</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {data.leads.map((row) => (
                                    <TableRow key={row.delivery_id}>
                                        <TableCell>
                                            <Link href={`/leads/${row.lead_id}`} className="font-medium hover:underline">
                                                {row.customer_name}
                                            </Link>
                                        </TableCell>
                                        <TableCell>{row.sent_by || "—"}</TableCell>
                                        <TableCell>{row.sent_at ? new Date(row.sent_at).toLocaleString() : "—"}</TableCell>
                                        <TableCell>{row.delivery_status.replace(/_/g, " ")}</TableCell>
                                        <TableCell>{row.lead_outcome || "—"}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
