"use client"

import * as React from "react"
import {
    startOfDay,
    endOfDay,
    parseISO,
    startOfMonth,
    endOfMonth,
    subMonths,
    subDays,
    format,
} from "date-fns"
import {
    Users,
    PhoneCall,
    CheckCircle2,
    AlertCircle,
    CalendarCheck,
    Store,
    FileCheck,
    TrendingUp,
    Clock,
    Loader2,
    RefreshCw,
    Download,
    Filter,
    X,
    Megaphone,
    UserCheck,
    ArrowUpDown,
} from "lucide-react"
import { jsPDF } from "jspdf"
import autoTable from "jspdf-autotable"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TableEmpty,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import {
    ReportsService,
    type LeadCohortAnalysisResponse,
    type LeadsCohortFilters,
    type CampaignMatrixRow,
} from "@/services/reports-service"
import type { PartnerStore } from "@/services/partner-store-service"
import type { LeadStage } from "@/services/lead-stage-service"

type CohortDateMode = "today" | "yesterday" | "last_7" | "mtd" | "last_month" | "range" | "single"

const LEAD_SOURCES = [
    { value: "google_sheets", label: "Google Sheets" },
    { value: "meta_ads", label: "Meta Ads" },
    { value: "manual", label: "Manual" },
    { value: "website", label: "Website" },
    { value: "referral", label: "Referral" },
    { value: "walk_in", label: "Walk-in" },
    { value: "whatsapp_inbound", label: "WhatsApp Inbound" },
    { value: "sms_inbound", label: "SMS Inbound" },
]

function localDateStr(d: Date): string {
    return format(d, "yyyy-MM-dd")
}

function getPresetDates(mode: CohortDateMode): { dateFrom: string; dateTo: string; singleDate: string } {
    const now = new Date()
    if (mode === "today") {
        const s = localDateStr(now)
        return { dateFrom: s, dateTo: s, singleDate: s }
    }
    if (mode === "yesterday") {
        const y = subDays(now, 1)
        const s = localDateStr(y)
        return { dateFrom: s, dateTo: s, singleDate: s }
    }
    if (mode === "last_7") {
        return { dateFrom: localDateStr(subDays(now, 6)), dateTo: localDateStr(now), singleDate: localDateStr(now) }
    }
    if (mode === "mtd") {
        return { dateFrom: localDateStr(startOfMonth(now)), dateTo: localDateStr(now), singleDate: localDateStr(now) }
    }
    if (mode === "last_month") {
        const prev = subMonths(now, 1)
        return {
            dateFrom: localDateStr(startOfMonth(prev)),
            dateTo: localDateStr(endOfMonth(prev)),
            singleDate: localDateStr(startOfMonth(prev)),
        }
    }
    return { dateFrom: localDateStr(startOfMonth(now)), dateTo: localDateStr(now), singleDate: localDateStr(now) }
}

function formatPct(val: number): string {
    return `${val.toFixed(1)}%`
}

function formatMinutes(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined) return "—"
    if (minutes < 60) return `${Math.round(minutes)}m`
    const hrs = Math.floor(minutes / 60)
    const mins = Math.round(minutes % 60)
    if (hrs < 24) return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`
    const days = (minutes / 1440).toFixed(1)
    return `${days}d`
}

function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return "—"
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    if (m === 0) return `${s}s`
    return `${m}m ${s}s`
}

function PctBadge({ value, tone = "neutral" }: { value: number; tone?: "neutral" | "good" | "warn" | "bad" }) {
    const cls =
        tone === "good"
            ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
            : tone === "warn"
                ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800"
                : tone === "bad"
                    ? "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
                    : "bg-muted text-muted-foreground border-border"
    return (
        <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium tabular-nums", cls)}>
            {formatPct(value)}
        </span>
    )
}

function CountWithPct({
    count,
    pct,
    tone = "neutral",
}: {
    count: number
    pct: number
    tone?: "neutral" | "good" | "warn" | "bad"
}) {
    return (
        <div className="inline-flex items-center justify-end gap-1.5 tabular-nums">
            <span className="font-medium">{count.toLocaleString()}</span>
            <PctBadge value={pct} tone={tone} />
        </div>
    )
}

function KpiTile({
    title,
    value,
    pct,
    sub,
    icon: Icon,
    accent = "default",
}: {
    title: string
    value: string | number
    pct?: number
    sub?: string
    icon: React.ComponentType<{ className?: string }>
    accent?: "default" | "good" | "warn" | "bad" | "primary"
}) {
    const borderCls =
        accent === "good"
            ? "border-emerald-200/80 dark:border-emerald-900"
            : accent === "warn"
                ? "border-amber-200/80 dark:border-amber-900"
                : accent === "bad"
                    ? "border-rose-200/80 dark:border-rose-900"
                    : accent === "primary"
                        ? "border-primary/30"
                        : ""
    return (
        <Card className={cn("shadow-none", borderCls)}>
            <CardContent className="p-4">
                <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                    <span className="truncate">{title}</span>
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-2">
                    <span className="text-2xl font-bold tabular-nums">
                        {typeof value === "number" ? value.toLocaleString() : value}
                    </span>
                    {pct !== undefined && (
                        <PctBadge
                            value={pct}
                            tone={accent === "good" ? "good" : accent === "warn" ? "warn" : accent === "bad" ? "bad" : "neutral"}
                        />
                    )}
                </div>
                {sub && <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>}
            </CardContent>
        </Card>
    )
}

function downloadCohortCsv(data: LeadCohortAnalysisResponse, periodLabel: string) {
    const lines: string[] = []
    const esc = (v: string | number | null | undefined) => {
        const s = v === null || v === undefined ? "" : String(v)
        return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
    }

    lines.push(`Leads Cohort & BDC Productivity Report (${periodLabel})`)
    lines.push("")
    lines.push("COHORT FUNNEL")
    lines.push("Step,Count,% of Total,% of Previous")
    for (const f of data.funnel) {
        lines.push([esc(f.label), f.count, `${f.pct_of_total}%`, f.pct_of_prev !== null && f.pct_of_prev !== undefined ? `${f.pct_of_prev}%` : ""].join(","))
    }
    lines.push("")
    lines.push(`BDC AGENT PRODUCTIVITY (${data.bdc_mode === "cohort" ? "Cohort Leads Only" : "Work Done in Period"})`)
    lines.push("Agent,Leads Worked,Calls Made,Connected Calls,Connect %,Avg Call Dur (s),Notes,Total Touches,Avg Touches/Lead,Median Speed (min),Stips Leads,Appts Set,Set %,Arrived,Show %,No Show,No Show %,Cancelled,Sold,Sold %")
    for (const b of [...data.bdc_agents, data.bdc_totals]) {
        lines.push(
            [
                esc(b.user_name),
                b.leads_worked,
                b.calls_made,
                b.connected_calls,
                `${b.connect_rate_pct}%`,
                b.avg_call_duration_seconds,
                b.notes_added,
                b.touches_total,
                b.avg_touches_per_lead,
                b.median_speed_to_lead_minutes ?? "",
                b.stips_leads,
                b.appts_scheduled,
                `${b.appt_set_rate_pct}%`,
                b.appts_arrived,
                `${b.show_rate_pct}%`,
                b.appts_no_show,
                `${b.no_show_rate_pct}%`,
                b.appts_cancelled,
                b.sold_leads,
                `${b.sold_rate_pct}%`,
            ].join(",")
        )
    }
    lines.push("")
    lines.push("CAMPAIGN PERFORMANCE MATRIX")
    lines.push("Campaign,Leads,Share %,Worked,Worked %,Interested,Interested %,Stips,Stips %,Partner Sent,Sent %,Appt Set,Appt %,Showed Up,Show %,No Show,No Show %,Sold,Conv %,Lost,Lost %")
    for (const c of data.campaigns) {
        lines.push(
            [
                esc(c.campaign_name),
                c.leads,
                `${c.share_pct}%`,
                c.worked,
                `${c.worked_pct}%`,
                c.interested,
                `${c.interested_pct}%`,
                c.stips,
                `${c.stips_pct}%`,
                c.partner_sent,
                `${c.partner_sent_pct}%`,
                c.appt_set,
                `${c.appt_set_pct}%`,
                c.showed_up,
                `${c.show_rate_pct}%`,
                c.no_show,
                `${c.no_show_pct}%`,
                c.converted,
                `${c.converted_pct}%`,
                c.lost,
                `${c.lost_pct}%`,
            ].join(",")
        )
    }
    lines.push("")
    lines.push("PARTNER STORE MATRIX")
    lines.push("Partner Store,Leads Sent,Share %,Appts Set,Appt %,Showed Up,Show %,No Show,No Show %,Cancelled,Sold,Close % of Showed,Sold % of Sent")
    for (const p of data.partner_stores) {
        lines.push(
            [
                esc(p.partner_store_name),
                p.leads_sent,
                `${p.share_pct}%`,
                p.appt_set,
                `${p.appt_set_pct}%`,
                p.showed_up,
                `${p.show_rate_pct}%`,
                p.no_show,
                `${p.no_show_pct}%`,
                p.cancelled,
                p.sold,
                `${p.close_rate_of_showed_pct}%`,
                `${p.sold_of_sent_pct}%`,
            ].join(",")
        )
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `leads-analysis-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
}

function downloadCohortPdf(data: LeadCohortAnalysisResponse, periodLabel: string) {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" })
    const margin = 36
    let y = 36

    doc.setFontSize(16)
    doc.setFont("helvetica", "bold")
    doc.text("TikunCRM — Leads Cohort & BDC Productivity Report", margin, y)
    y += 16
    doc.setFontSize(9)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(100, 116, 139)
    doc.text(`Period: ${periodLabel}  |  Generated: ${format(new Date(), "MMM d, yyyy h:mm a")}`, margin, y)
    doc.setTextColor(0, 0, 0)
    y += 16

    // Funnel table
    autoTable(doc, {
        startY: y,
        head: [["Funnel Step", "Count", "% of Total", "% of Prev Step"]],
        body: data.funnel.map((f) => [
            f.label,
            String(f.count),
            `${f.pct_of_total.toFixed(1)}%`,
            f.pct_of_prev !== null && f.pct_of_prev !== undefined ? `${f.pct_of_prev.toFixed(1)}%` : "—",
        ]),
        theme: "grid",
        styles: { fontSize: 8 },
        headStyles: { fillColor: [30, 41, 59] },
        margin: { left: margin, right: margin },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14

    // BDC table
    doc.setFontSize(11)
    doc.setFont("helvetica", "bold")
    doc.text(`BDC Agent Productivity (${data.bdc_mode === "cohort" ? "Cohort Leads Only" : "Work Done in Period"})`, margin, y)
    y += 8
    autoTable(doc, {
        startY: y,
        head: [["Agent", "Worked", "Calls", "Connected", "Notes", "Appts Set", "Arrived", "No Show", "Sold"]],
        body: [...data.bdc_agents, data.bdc_totals].map((b) => [
            b.user_name,
            String(b.leads_worked),
            String(b.calls_made),
            `${b.connected_calls} (${b.connect_rate_pct.toFixed(1)}%)`,
            String(b.notes_added),
            `${b.appts_scheduled} (${b.appt_set_rate_pct.toFixed(1)}%)`,
            `${b.appts_arrived} (${b.show_rate_pct.toFixed(1)}%)`,
            `${b.appts_no_show} (${b.no_show_rate_pct.toFixed(1)}%)`,
            `${b.sold_leads} (${b.sold_rate_pct.toFixed(1)}%)`,
        ]),
        theme: "grid",
        styles: { fontSize: 8 },
        headStyles: { fillColor: [30, 41, 59] },
        margin: { left: margin, right: margin },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14

    // Campaign table
    doc.setFontSize(11)
    doc.setFont("helvetica", "bold")
    doc.text("Campaign Performance Matrix", margin, y)
    y += 8
    autoTable(doc, {
        startY: y,
        head: [["Campaign", "Leads", "Worked", "Interested", "Stips", "Sent", "Appt Set", "Showed", "Sold"]],
        body: data.campaigns.map((c) => [
            c.campaign_name,
            `${c.leads} (${c.share_pct.toFixed(1)}%)`,
            `${c.worked} (${c.worked_pct.toFixed(1)}%)`,
            `${c.interested} (${c.interested_pct.toFixed(1)}%)`,
            `${c.stips} (${c.stips_pct.toFixed(1)}%)`,
            `${c.partner_sent} (${c.partner_sent_pct.toFixed(1)}%)`,
            `${c.appt_set} (${c.appt_set_pct.toFixed(1)}%)`,
            `${c.showed_up} (${c.show_rate_pct.toFixed(1)}%)`,
            `${c.converted} (${c.converted_pct.toFixed(1)}%)`,
        ]),
        theme: "grid",
        styles: { fontSize: 8 },
        headStyles: { fillColor: [30, 41, 59] },
        margin: { left: margin, right: margin },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14

    // Partner store table
    doc.setFontSize(11)
    doc.setFont("helvetica", "bold")
    doc.text("Partner Store Matrix", margin, y)
    y += 8
    autoTable(doc, {
        startY: y,
        head: [["Partner Store", "Sent", "Appts Set", "Showed Up", "No Show", "Cancelled", "Sold (Close % / Sent %)"]],
        body: data.partner_stores.map((p) => [
            p.partner_store_name,
            `${p.leads_sent} (${p.share_pct.toFixed(1)}%)`,
            `${p.appt_set} (${p.appt_set_pct.toFixed(1)}%)`,
            `${p.showed_up} (${p.show_rate_pct.toFixed(1)}%)`,
            `${p.no_show} (${p.no_show_pct.toFixed(1)}%)`,
            String(p.cancelled),
            `${p.sold} (${p.close_rate_of_showed_pct.toFixed(1)}% / ${p.sold_of_sent_pct.toFixed(1)}%)`,
        ]),
        theme: "grid",
        styles: { fontSize: 8 },
        headStyles: { fillColor: [30, 41, 59] },
        margin: { left: margin, right: margin },
    })

    doc.save(`leads-analysis-${new Date().toISOString().slice(0, 10)}.pdf`)
}

export interface LeadsAnalysisTabProps {
    dealershipId: string | null
    orgDealershipId: string | null
    isSuperAdmin: boolean
    isBdc: boolean
    dealerships: Array<{ id: string; name: string }>
    salespersons: Array<{ id: string; first_name: string; last_name: string }>
    bdcAgents: Array<{ id: string; first_name: string; last_name: string }>
    partnerStores: PartnerStore[]
    stages: LeadStage[]
    onDealershipChange?: (id: string | null) => void
}

export function LeadsAnalysisTab({
    dealershipId,
    orgDealershipId,
    isSuperAdmin,
    isBdc,
    dealerships,
    salespersons,
    bdcAgents,
    partnerStores,
    stages,
    onDealershipChange,
}: LeadsAnalysisTabProps) {
    const [dateMode, setDateMode] = React.useState<CohortDateMode>("mtd")
    const [dateFrom, setDateFrom] = React.useState<string>(() => getPresetDates("mtd").dateFrom)
    const [dateTo, setDateTo] = React.useState<string>(() => getPresetDates("mtd").dateTo)
    const [singleDate, setSingleDate] = React.useState<string>(() => getPresetDates("mtd").singleDate)

    const [campaign, setCampaign] = React.useState<string | null>(null)
    const [partnerStoreId, setPartnerStoreId] = React.useState<string | null>(null)
    const [bdcAgentId, setBdcAgentId] = React.useState<string | null>(null)
    const [assignedTo, setAssignedTo] = React.useState<string | null>(null)
    const [source, setSource] = React.useState<string | null>(null)
    const [stageId, setStageId] = React.useState<string | null>(null)
    const [hasStip, setHasStip] = React.useState<"yes" | "no" | null>(null)
    const [includeReturning, setIncludeReturning] = React.useState<boolean>(false)
    const [bdcMode, setBdcMode] = React.useState<"activity" | "cohort">("activity")
    const [showInactiveBdc, setShowInactiveBdc] = React.useState<boolean>(false)

    const [campaignSort, setCampaignSort] = React.useState<keyof CampaignMatrixRow>("leads")
    const [campaignSortAsc, setCampaignSortAsc] = React.useState<boolean>(false)

    const [data, setData] = React.useState<LeadCohortAnalysisResponse | null>(null)
    const [loading, setLoading] = React.useState<boolean>(true)
    const [error, setError] = React.useState<string | null>(null)

    const handleDateModeChange = (mode: CohortDateMode) => {
        setDateMode(mode)
        if (mode !== "range" && mode !== "single") {
            const p = getPresetDates(mode)
            setDateFrom(p.dateFrom)
            setDateTo(p.dateTo)
            setSingleDate(p.singleDate)
        }
    }

    const buildQueryFilters = React.useCallback((): LeadsCohortFilters => {
        const filters: LeadsCohortFilters = {
            bdc_mode: bdcMode,
            include_returning: includeReturning,
        }
        if (dateMode === "single" && singleDate) {
            filters.date_from = startOfDay(parseISO(singleDate)).toISOString()
            filters.date_to = endOfDay(parseISO(singleDate)).toISOString()
        } else {
            if (dateFrom) filters.date_from = startOfDay(parseISO(dateFrom)).toISOString()
            if (dateTo) filters.date_to = endOfDay(parseISO(dateTo)).toISOString()
        }
        const effectiveDealershipId = dealershipId || (isBdc ? orgDealershipId : null)
        if (effectiveDealershipId) filters.dealership_id = effectiveDealershipId
        if (campaign) filters.campaign = campaign
        if (partnerStoreId) filters.partner_store_id = partnerStoreId
        if (bdcAgentId) filters.bdc_agent_id = bdcAgentId
        if (assignedTo) filters.assigned_to = assignedTo
        if (source) filters.source = source
        if (stageId) filters.stage_id = stageId
        if (hasStip) filters.has_stip = hasStip
        return filters
    }, [
        dateMode,
        singleDate,
        dateFrom,
        dateTo,
        dealershipId,
        isBdc,
        orgDealershipId,
        campaign,
        partnerStoreId,
        bdcAgentId,
        assignedTo,
        source,
        stageId,
        hasStip,
        includeReturning,
        bdcMode,
    ])

    const fetchData = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await ReportsService.getLeadsCohortAnalysis(buildQueryFilters())
            setData(res)
        } catch (e: unknown) {
            const msg =
                e && typeof e === "object" && "response" in e
                    ? (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
                    : "Failed to load leads analysis"
            setError(typeof msg === "string" ? msg : "Failed to load leads analysis")
        } finally {
            setLoading(false)
        }
    }, [buildQueryFilters])

    React.useEffect(() => {
        fetchData()
    }, [fetchData])

    const hasActiveSubFilters = Boolean(
        campaign || partnerStoreId || bdcAgentId || assignedTo || source || stageId || hasStip || includeReturning
    )

    const clearSubFilters = () => {
        setCampaign(null)
        setPartnerStoreId(null)
        setBdcAgentId(null)
        setAssignedTo(null)
        setSource(null)
        setStageId(null)
        setHasStip(null)
        setIncludeReturning(false)
    }

    const periodLabel = React.useMemo(() => {
        if (dateMode === "single" && singleDate) return singleDate
        if (dateFrom && dateTo) return dateFrom === dateTo ? dateFrom : `${dateFrom} to ${dateTo}`
        return "Selected period"
    }, [dateMode, singleDate, dateFrom, dateTo])

    const sortedCampaigns = React.useMemo(() => {
        if (!data) return []
        const list = [...data.campaigns]
        list.sort((a, b) => {
            const va = a[campaignSort]
            const vb = b[campaignSort]
            if (typeof va === "string" && typeof vb === "string") {
                return campaignSortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
            }
            const na = Number(va) || 0
            const nb = Number(vb) || 0
            return campaignSortAsc ? na - nb : nb - na
        })
        return list
    }, [data, campaignSort, campaignSortAsc])

    const toggleCampaignSort = (col: keyof CampaignMatrixRow) => {
        if (campaignSort === col) {
            setCampaignSortAsc((prev) => !prev)
        } else {
            setCampaignSort(col)
            setCampaignSortAsc(false)
        }
    }

    const visibleBdcAgents = React.useMemo(() => {
        if (!data) return []
        if (showInactiveBdc) return data.bdc_agents
        const active = data.bdc_agents.filter(
            (b) => b.leads_worked > 0 || b.calls_made > 0 || b.appts_scheduled > 0 || b.notes_added > 0
        )
        return active.length > 0 ? active : data.bdc_agents
    }, [data, showInactiveBdc])

    const hiddenBdcCount = (data?.bdc_agents.length ?? 0) - visibleBdcAgents.length

    return (
        <div className="space-y-6">
            {/* Filters Card */}
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <Filter className="h-4 w-4 text-muted-foreground" />
                            <CardTitle className="text-base">Leads Analysis Filters</CardTitle>
                            <Badge variant="secondary" className="text-xs font-normal">
                                {periodLabel}
                            </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {hasActiveSubFilters && (
                                <Button variant="ghost" size="sm" onClick={clearSubFilters}>
                                    <X className="h-3.5 w-3.5 mr-1" />
                                    Clear Filters
                                </Button>
                            )}
                            {data && (
                                <>
                                    <Button variant="outline" size="sm" onClick={() => downloadCohortCsv(data, periodLabel)}>
                                        <Download className="h-3.5 w-3.5 mr-1.5" />
                                        CSV
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => downloadCohortPdf(data, periodLabel)}>
                                        <Download className="h-3.5 w-3.5 mr-1.5" />
                                        PDF
                                    </Button>
                                </>
                            )}
                            <Button size="sm" onClick={fetchData} disabled={loading}>
                                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                                Refresh
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">Period</label>
                            <Select value={dateMode} onValueChange={(v) => handleDateModeChange(v as CohortDateMode)}>
                                <SelectTrigger className="w-[155px] h-9">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="today">Today</SelectItem>
                                    <SelectItem value="yesterday">Yesterday</SelectItem>
                                    <SelectItem value="last_7">Last 7 days</SelectItem>
                                    <SelectItem value="mtd">This month (MTD)</SelectItem>
                                    <SelectItem value="last_month">Last month</SelectItem>
                                    <SelectItem value="range">Custom range</SelectItem>
                                    <SelectItem value="single">Single date</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        {dateMode === "single" ? (
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Date</label>
                                <input
                                    type="date"
                                    value={singleDate}
                                    onChange={(e) => setSingleDate(e.target.value)}
                                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                                />
                            </div>
                        ) : (
                            <>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">From</label>
                                    <input
                                        type="date"
                                        value={dateFrom}
                                        onChange={(e) => {
                                            setDateFrom(e.target.value)
                                            if (dateMode !== "range") setDateMode("range")
                                        }}
                                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">To</label>
                                    <input
                                        type="date"
                                        value={dateTo}
                                        onChange={(e) => {
                                            setDateTo(e.target.value)
                                            if (dateMode !== "range") setDateMode("range")
                                        }}
                                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                                    />
                                </div>
                            </>
                        )}

                        {(isSuperAdmin || isBdc) && dealerships.length > 0 && onDealershipChange && (
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Dealership</label>
                                <Select
                                    value={dealershipId ?? (isBdc && dealerships.length === 1 ? dealerships[0].id : "all")}
                                    onValueChange={(v) => onDealershipChange(v === "all" ? null : v)}
                                >
                                    <SelectTrigger className="w-[165px] h-9">
                                        <SelectValue placeholder="All" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {isSuperAdmin && <SelectItem value="all">All Dealerships</SelectItem>}
                                        {dealerships.map((d) => (
                                            <SelectItem key={d.id} value={d.id}>
                                                {d.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">Campaign</label>
                            <Select value={campaign ?? "all"} onValueChange={(v) => setCampaign(v === "all" ? null : v)}>
                                <SelectTrigger className="w-[190px] h-9">
                                    <SelectValue placeholder="All campaigns" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All active campaigns</SelectItem>
                                    {(data?.available_campaigns ?? []).map((c) => (
                                        <SelectItem key={c} value={c}>
                                            {c}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">Partner Store</label>
                            <Select value={partnerStoreId ?? "all"} onValueChange={(v) => setPartnerStoreId(v === "all" ? null : v)}>
                                <SelectTrigger className="w-[185px] h-9">
                                    <SelectValue placeholder="All stores" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All stores</SelectItem>
                                    {partnerStores.map((ps) => (
                                        <SelectItem key={ps.id} value={ps.id}>
                                            {ps.brand ? `${ps.name} (${ps.brand})` : ps.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {bdcAgents.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">BDC Agent</label>
                                <Select value={bdcAgentId ?? "all"} onValueChange={(v) => setBdcAgentId(v === "all" ? null : v)}>
                                    <SelectTrigger className="w-[160px] h-9">
                                        <SelectValue placeholder="All BDC" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All BDC</SelectItem>
                                        {bdcAgents.map((a) => (
                                            <SelectItem key={a.id} value={a.id}>
                                                {a.first_name} {a.last_name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">Salesperson</label>
                            <Select value={assignedTo ?? "all"} onValueChange={(v) => setAssignedTo(v === "all" ? null : v)}>
                                <SelectTrigger className="w-[155px] h-9">
                                    <SelectValue placeholder="All" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All</SelectItem>
                                    {salespersons.map((s) => (
                                        <SelectItem key={s.id} value={s.id}>
                                            {s.first_name} {s.last_name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">Source</label>
                            <Select value={source ?? "all"} onValueChange={(v) => setSource(v === "all" ? null : v)}>
                                <SelectTrigger className="w-[140px] h-9">
                                    <SelectValue placeholder="All" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All sources</SelectItem>
                                    {LEAD_SOURCES.map((s) => (
                                        <SelectItem key={s.value} value={s.value}>
                                            {s.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">Stage</label>
                            <Select value={stageId ?? "all"} onValueChange={(v) => setStageId(v === "all" ? null : v)}>
                                <SelectTrigger className="w-[145px] h-9">
                                    <SelectValue placeholder="All" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All stages</SelectItem>
                                    {stages.map((st) => (
                                        <SelectItem key={st.id} value={st.id}>
                                            {st.display_name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">Stips</label>
                            <Select value={hasStip ?? "all"} onValueChange={(v) => setHasStip(v === "all" ? null : (v as "yes" | "no"))}>
                                <SelectTrigger className="w-[130px] h-9">
                                    <SelectValue placeholder="All" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All leads</SelectItem>
                                    <SelectItem value="yes">Has stip</SelectItem>
                                    <SelectItem value="no">No stip</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <label className="inline-flex items-center gap-2 h-9 px-2 text-xs text-muted-foreground cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={includeReturning}
                                onChange={(e) => setIncludeReturning(e.target.checked)}
                                className="rounded border-input"
                            />
                            Include returning leads
                        </label>
                    </div>
                </CardContent>
            </Card>

            {error && (
                <Card className="border-destructive">
                    <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
                </Card>
            )}

            {loading && !data ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            ) : data ? (
                <>
                    {/* Section 1: Lead Cohort KPI Strip */}
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <h2 className="text-lg font-semibold">Lead Cohort Overview</h2>
                                <p className="text-xs text-muted-foreground">
                                    Distinct leads received during {periodLabel} and where they stand across the funnel.
                                </p>
                            </div>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                    <Clock className="h-3.5 w-3.5" />
                                    Median speed-to-lead:{" "}
                                    <strong className="text-foreground">
                                        {formatMinutes(data.summary.median_speed_to_lead_minutes)}
                                    </strong>
                                </span>
                                <span>
                                    Avg days to appt:{" "}
                                    <strong className="text-foreground">
                                        {data.summary.avg_days_to_appointment !== null && data.summary.avg_days_to_appointment !== undefined
                                            ? `${data.summary.avg_days_to_appointment}d`
                                            : "—"}
                                    </strong>
                                </span>
                            </div>
                        </div>

                        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                            <KpiTile
                                title="Total Leads"
                                value={data.summary.total_leads}
                                pct={data.summary.total_leads > 0 ? 100 : 0}
                                sub={`${data.summary.active_leads} active · ${data.summary.lost_leads} lost (${formatPct(data.summary.lost_pct)})`}
                                icon={Users}
                                accent="primary"
                            />
                            <KpiTile
                                title="Worked / Contacted"
                                value={data.summary.worked_leads}
                                pct={data.summary.worked_pct}
                                sub={`${data.summary.untouched_leads} untouched (${formatPct(data.summary.untouched_pct)})`}
                                icon={PhoneCall}
                                accent={data.summary.untouched_pct > 15 ? "warn" : "good"}
                            />
                            <KpiTile
                                title="Interested / Engaged"
                                value={data.summary.interested_leads}
                                pct={data.summary.interested_pct}
                                sub={`${formatPct(data.summary.interested_of_worked_pct)} of worked leads`}
                                icon={TrendingUp}
                            />
                            <KpiTile
                                title="Stips Uploaded"
                                value={data.summary.stips_leads}
                                pct={data.summary.stips_pct}
                                sub={`${formatPct(data.summary.stips_of_interested_pct)} of interested`}
                                icon={FileCheck}
                            />
                            <KpiTile
                                title="Sent to Partner Store"
                                value={data.summary.partner_sent_leads}
                                pct={data.summary.partner_sent_pct}
                                sub="Connected to a partner dealership"
                                icon={Store}
                            />
                            <KpiTile
                                title="Appointment Set"
                                value={data.summary.appointment_set_leads}
                                pct={data.summary.appointment_set_pct}
                                sub={`${data.appointments.total_appointments} total appts booked`}
                                icon={CalendarCheck}
                            />
                            <KpiTile
                                title="Showed Up (Arrived)"
                                value={data.summary.showed_up_leads}
                                pct={data.summary.show_rate_pct}
                                sub={`Show rate of appt set · ${formatPct(data.summary.showed_up_pct)} of leads`}
                                icon={UserCheck}
                                accent="good"
                            />
                            <KpiTile
                                title="No Show"
                                value={data.summary.no_show_leads}
                                pct={data.summary.no_show_pct}
                                sub="% of leads with appointment set"
                                icon={AlertCircle}
                                accent={data.summary.no_show_pct > 35 ? "warn" : "default"}
                            />
                            <KpiTile
                                title="Converted / Sold"
                                value={data.summary.converted_leads}
                                pct={data.summary.converted_pct}
                                sub={`Close rate of showed up: ${formatPct(data.summary.close_rate_of_showed_pct)}`}
                                icon={CheckCircle2}
                                accent="good"
                            />
                            <KpiTile
                                title="Untouched Leads"
                                value={data.summary.untouched_leads}
                                pct={data.summary.untouched_pct}
                                sub="No call, note, or message yet"
                                icon={AlertCircle}
                                accent={data.summary.untouched_leads > 0 ? "bad" : "good"}
                            />
                        </div>

                        {/* Visual Cohort Funnel */}
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-base">Conversion Funnel</CardTitle>
                                <CardDescription>
                                    Distinct leads moving from arrival to sale, with share of total cohort and step-to-step conversion.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-2.5">
                                {data.funnel.map((step) => (
                                    <div key={step.key} className="grid grid-cols-12 items-center gap-3 text-sm">
                                        <div className="col-span-4 sm:col-span-3 truncate font-medium">
                                            {step.label}
                                        </div>
                                        <div className="col-span-5 sm:col-span-6">
                                            <div className="h-5 w-full rounded bg-muted/60 overflow-hidden">
                                                <div
                                                    className={cn(
                                                        "h-full rounded transition-all duration-300",
                                                        step.key === "converted"
                                                            ? "bg-emerald-500"
                                                            : step.key === "showed_up"
                                                                ? "bg-teal-500"
                                                                : step.key === "appt_set"
                                                                    ? "bg-blue-500"
                                                                    : "bg-primary/80"
                                                    )}
                                                    style={{ width: `${Math.max(step.count > 0 ? 2 : 0, Math.min(100, step.pct_of_total))}%` }}
                                                />
                                            </div>
                                        </div>
                                        <div className="col-span-3 flex items-center justify-end gap-2 tabular-nums">
                                            <span className="font-semibold">{step.count.toLocaleString()}</span>
                                            <PctBadge value={step.pct_of_total} />
                                            {step.pct_of_prev !== null && step.pct_of_prev !== undefined && (
                                                <span className="hidden md:inline text-[11px] text-muted-foreground w-[54px] text-right">
                                                    step {step.pct_of_prev.toFixed(0)}%
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    </div>

                    {/* Section 2: BDC Agent Productivity Matrix */}
                    <Card>
                        <CardHeader className="pb-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <Users className="h-4 w-4" />
                                        BDC Agent Productivity
                                    </CardTitle>
                                    <CardDescription>
                                        {bdcMode === "activity"
                                            ? "All leads worked, calls placed (connected ≥ 15s), notes added, and appointments booked by each BDC agent during this period."
                                            : "Each BDC agent's work strictly on the cohort of leads that arrived during this period."}
                                    </CardDescription>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="inline-flex rounded-md border bg-muted p-0.5 text-xs">
                                        <button
                                            type="button"
                                            onClick={() => setBdcMode("activity")}
                                            className={cn(
                                                "rounded px-2.5 py-1 font-medium transition-colors",
                                                bdcMode === "activity"
                                                    ? "bg-background text-foreground shadow-sm"
                                                    : "text-muted-foreground hover:text-foreground"
                                            )}
                                        >
                                            Work Done in Period
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setBdcMode("cohort")}
                                            className={cn(
                                                "rounded px-2.5 py-1 font-medium transition-colors",
                                                bdcMode === "cohort"
                                                    ? "bg-background text-foreground shadow-sm"
                                                    : "text-muted-foreground hover:text-foreground"
                                            )}
                                        >
                                            Cohort Leads Only
                                        </button>
                                    </div>
                                    {hiddenBdcCount > 0 && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 text-xs"
                                            onClick={() => setShowInactiveBdc((v) => !v)}
                                        >
                                            {showInactiveBdc ? "Hide 0-activity" : `Show all (+${hiddenBdcCount})`}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-muted/50">
                                            <TableHead>BDC Agent</TableHead>
                                            <TableHead className="text-right">Leads Worked</TableHead>
                                            <TableHead className="text-right">Calls Made</TableHead>
                                            <TableHead className="text-right">Connected</TableHead>
                                            <TableHead className="text-right">Avg Dur.</TableHead>
                                            <TableHead className="text-right">Notes</TableHead>
                                            <TableHead className="text-right">Touches / Lead</TableHead>
                                            <TableHead className="text-right">Med. Speed</TableHead>
                                            <TableHead className="text-right">Stips</TableHead>
                                            <TableHead className="text-right">Appts Set</TableHead>
                                            <TableHead className="text-right">Arrived (Show %)</TableHead>
                                            <TableHead className="text-right">No Show</TableHead>
                                            <TableHead className="text-right">Sold</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {visibleBdcAgents.length === 0 ? (
                                            <TableEmpty title="No BDC agents found" description="No BDC agents match the current filter." />
                                        ) : (
                                            <>
                                                {visibleBdcAgents.map((row) => (
                                                    <TableRow
                                                        key={row.user_id}
                                                        className={cn(
                                                            "cursor-pointer hover:bg-muted/40",
                                                            bdcAgentId === row.user_id && "bg-primary/5"
                                                        )}
                                                        onClick={() =>
                                                            setBdcAgentId((prev) => (prev === row.user_id ? null : row.user_id))
                                                        }
                                                    >
                                                        <TableCell className="font-medium whitespace-nowrap">
                                                            <div>{row.user_name}</div>
                                                            {row.email && (
                                                                <div className="text-[11px] text-muted-foreground">{row.email}</div>
                                                            )}
                                                        </TableCell>
                                                        <TableCell className="text-right font-semibold tabular-nums">
                                                            {row.leads_worked.toLocaleString()}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {row.calls_made.toLocaleString()}
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <CountWithPct
                                                                count={row.connected_calls}
                                                                pct={row.connect_rate_pct}
                                                                tone={row.connect_rate_pct >= 40 ? "good" : "neutral"}
                                                            />
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                                                            {formatDuration(row.avg_call_duration_seconds)}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {row.notes_added.toLocaleString()}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-xs">
                                                            {row.touches_total.toLocaleString()}{" "}
                                                            <span className="text-muted-foreground">({row.avg_touches_per_lead.toFixed(1)})</span>
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums text-xs">
                                                            {formatMinutes(row.median_speed_to_lead_minutes)}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {row.stips_leads.toLocaleString()}
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <CountWithPct count={row.appts_scheduled} pct={row.appt_set_rate_pct} />
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <CountWithPct
                                                                count={row.appts_arrived}
                                                                pct={row.show_rate_pct}
                                                                tone={row.show_rate_pct >= 50 ? "good" : row.appts_arrived > 0 ? "warn" : "neutral"}
                                                            />
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <CountWithPct
                                                                count={row.appts_no_show}
                                                                pct={row.no_show_rate_pct}
                                                                tone={row.no_show_rate_pct >= 40 ? "bad" : "neutral"}
                                                            />
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <CountWithPct
                                                                count={row.sold_leads}
                                                                pct={row.sold_rate_pct}
                                                                tone={row.sold_leads > 0 ? "good" : "neutral"}
                                                            />
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                                <TableRow className="bg-muted/60 font-semibold border-t-2">
                                                    <TableCell>{data.bdc_totals.user_name}</TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {data.bdc_totals.leads_worked.toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {data.bdc_totals.calls_made.toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={data.bdc_totals.connected_calls}
                                                            pct={data.bdc_totals.connect_rate_pct}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums text-xs">
                                                        {formatDuration(data.bdc_totals.avg_call_duration_seconds)}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {data.bdc_totals.notes_added.toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums text-xs">
                                                        {data.bdc_totals.touches_total.toLocaleString()} ({data.bdc_totals.avg_touches_per_lead.toFixed(1)})
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums text-xs">
                                                        {formatMinutes(data.bdc_totals.median_speed_to_lead_minutes)}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {data.bdc_totals.stips_leads.toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={data.bdc_totals.appts_scheduled}
                                                            pct={data.bdc_totals.appt_set_rate_pct}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={data.bdc_totals.appts_arrived}
                                                            pct={data.bdc_totals.show_rate_pct}
                                                            tone="good"
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={data.bdc_totals.appts_no_show}
                                                            pct={data.bdc_totals.no_show_rate_pct}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={data.bdc_totals.sold_leads}
                                                            pct={data.bdc_totals.sold_rate_pct}
                                                            tone="good"
                                                        />
                                                    </TableCell>
                                                </TableRow>
                                            </>
                                        )}
                                    </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Section 3: Campaign Performance Matrix */}
                    <Card>
                        <CardHeader className="pb-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <Megaphone className="h-4 w-4" />
                                        Campaign Performance Matrix
                                    </CardTitle>
                                    <CardDescription>
                                        Active campaigns that brought leads in this period. Click any row to filter the report to that campaign.
                                    </CardDescription>
                                </div>
                                {campaign && (
                                    <Badge variant="secondary" className="gap-1">
                                        Campaign: {campaign}
                                        <button type="button" onClick={() => setCampaign(null)} aria-label="Clear campaign filter">
                                            <X className="h-3 w-3" />
                                        </button>
                                    </Badge>
                                )}
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-muted/50">
                                            <TableHead>
                                                <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleCampaignSort("campaign_name")}>
                                                    Campaign <ArrowUpDown className="h-3 w-3" />
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-right">
                                                <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleCampaignSort("leads")}>
                                                    Leads (% share) <ArrowUpDown className="h-3 w-3" />
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-right">Worked</TableHead>
                                            <TableHead className="text-right">
                                                <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleCampaignSort("interested_pct")}>
                                                    Interested <ArrowUpDown className="h-3 w-3" />
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-right">
                                                <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleCampaignSort("stips")}>
                                                    Stips <ArrowUpDown className="h-3 w-3" />
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-right">Sent to Store</TableHead>
                                            <TableHead className="text-right">
                                                <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleCampaignSort("appt_set")}>
                                                    Appt Set <ArrowUpDown className="h-3 w-3" />
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-right">
                                                <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleCampaignSort("show_rate_pct")}>
                                                    Showed (Show %) <ArrowUpDown className="h-3 w-3" />
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-right">No Show</TableHead>
                                            <TableHead className="text-right">
                                                <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleCampaignSort("converted")}>
                                                    Sold (Conv %) <ArrowUpDown className="h-3 w-3" />
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-right">Lost</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {sortedCampaigns.length === 0 ? (
                                            <TableEmpty title="No leads in this period" description="Try expanding the date range or clearing filters." />
                                        ) : (
                                            sortedCampaigns.map((row) => (
                                                <TableRow
                                                    key={row.campaign_name}
                                                    className={cn(
                                                        "cursor-pointer hover:bg-muted/40",
                                                        campaign === row.campaign_name && "bg-primary/5"
                                                    )}
                                                    onClick={() =>
                                                        setCampaign((prev) => (prev === row.campaign_name ? null : row.campaign_name))
                                                    }
                                                >
                                                    <TableCell className="font-medium max-w-[220px] truncate" title={row.campaign_name}>
                                                        {row.campaign_name}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.leads} pct={row.share_pct} />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.worked} pct={row.worked_pct} />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={row.interested}
                                                            pct={row.interested_pct}
                                                            tone={row.interested_pct >= 30 ? "good" : "neutral"}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.stips} pct={row.stips_pct} />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.partner_sent} pct={row.partner_sent_pct} />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.appt_set} pct={row.appt_set_pct} />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={row.showed_up}
                                                            pct={row.show_rate_pct}
                                                            tone={row.show_rate_pct >= 50 ? "good" : row.showed_up > 0 ? "warn" : "neutral"}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={row.no_show}
                                                            pct={row.no_show_pct}
                                                            tone={row.no_show_pct >= 40 ? "bad" : "neutral"}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={row.converted}
                                                            pct={row.converted_pct}
                                                            tone={row.converted > 0 ? "good" : "neutral"}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.lost} pct={row.lost_pct} />
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Section 4: Pipeline Stage Breakdown & Appointments / Show-Up Matrix */}
                    <div className="grid gap-4 lg:grid-cols-2">
                        {/* Stage Breakdown */}
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Pipeline Stage Breakdown</CardTitle>
                                <CardDescription>
                                    Current stage distribution of the {data.summary.total_leads.toLocaleString()} leads in this cohort.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <div className="grid grid-cols-3 gap-2 text-center">
                                    <div className="rounded-md border bg-muted/30 p-2">
                                        <div className="text-[11px] text-muted-foreground">Active</div>
                                        <div className="text-base font-semibold tabular-nums">
                                            {data.summary.active_leads}{" "}
                                            <span className="text-xs font-normal text-muted-foreground">
                                                ({formatPct(data.summary.active_pct)})
                                            </span>
                                        </div>
                                    </div>
                                    <div className="rounded-md border border-emerald-200/70 bg-emerald-50/40 dark:bg-emerald-950/20 p-2">
                                        <div className="text-[11px] text-emerald-700 dark:text-emerald-300">Converted</div>
                                        <div className="text-base font-semibold tabular-nums">
                                            {data.summary.converted_leads}{" "}
                                            <span className="text-xs font-normal text-muted-foreground">
                                                ({formatPct(data.summary.converted_pct)})
                                            </span>
                                        </div>
                                    </div>
                                    <div className="rounded-md border border-rose-200/70 bg-rose-50/40 dark:bg-rose-950/20 p-2">
                                        <div className="text-[11px] text-rose-700 dark:text-rose-300">Lost</div>
                                        <div className="text-base font-semibold tabular-nums">
                                            {data.summary.lost_leads}{" "}
                                            <span className="text-xs font-normal text-muted-foreground">
                                                ({formatPct(data.summary.lost_pct)})
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-2 pt-1">
                                    {data.stages.length === 0 ? (
                                        <p className="text-sm text-muted-foreground py-6 text-center">No leads in this period.</p>
                                    ) : (
                                        data.stages.map((st) => (
                                            <div key={st.stage_id} className="space-y-1">
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="inline-flex items-center gap-2 font-medium">
                                                        <span
                                                            className="h-2.5 w-2.5 rounded-full shrink-0"
                                                            style={{ backgroundColor: st.color || "#64748b" }}
                                                        />
                                                        {st.display_name}
                                                    </span>
                                                    <CountWithPct count={st.count} pct={st.pct_of_total} />
                                                </div>
                                                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full"
                                                        style={{
                                                            width: `${Math.min(100, st.pct_of_total)}%`,
                                                            backgroundColor: st.color || "#64748b",
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </CardContent>
                        </Card>

                        {/* Appointments & Show-Up Matrix */}
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Appointments &amp; Show-Up Matrix</CardTitle>
                                <CardDescription>
                                    All {data.appointments.total_appointments.toLocaleString()} appointments belonging to leads in this cohort.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <div className="grid grid-cols-3 gap-2 text-center">
                                    <div className="rounded-md border border-emerald-200/70 bg-emerald-50/40 dark:bg-emerald-950/20 p-2">
                                        <div className="text-[11px] text-emerald-700 dark:text-emerald-300">Show Rate</div>
                                        <div className="text-base font-semibold tabular-nums">
                                            {formatPct(data.appointments.show_rate_pct)}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground">
                                            {data.appointments.showed_up} / {data.appointments.active_outcome_denominator}
                                        </div>
                                    </div>
                                    <div className="rounded-md border border-amber-200/70 bg-amber-50/40 dark:bg-amber-950/20 p-2">
                                        <div className="text-[11px] text-amber-700 dark:text-amber-300">No-Show Rate</div>
                                        <div className="text-base font-semibold tabular-nums">
                                            {formatPct(data.appointments.no_show_rate_pct)}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground">
                                            {data.appointments.no_show} / {data.appointments.active_outcome_denominator}
                                        </div>
                                    </div>
                                    <div className="rounded-md border bg-muted/30 p-2">
                                        <div className="text-[11px] text-muted-foreground">Cancel Rate</div>
                                        <div className="text-base font-semibold tabular-nums">
                                            {formatPct(data.appointments.cancel_rate_pct)}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground">
                                            {data.appointments.cancelled} / {data.appointments.total_appointments}
                                        </div>
                                    </div>
                                </div>

                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-muted/50">
                                            <TableHead>Appointment Status</TableHead>
                                            <TableHead className="text-right">Count</TableHead>
                                            <TableHead className="text-right">% of Appts</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {data.appointments.by_status.length === 0 ? (
                                            <TableEmpty title="No appointments" description="No appointments for leads in this period." />
                                        ) : (
                                            data.appointments.by_status.map((row) => (
                                                <TableRow key={row.status}>
                                                    <TableCell className="font-medium">{row.label}</TableCell>
                                                    <TableCell className="text-right tabular-nums">{row.count.toLocaleString()}</TableCell>
                                                    <TableCell className="text-right">
                                                        <PctBadge
                                                            value={row.pct_of_appointments}
                                                            tone={
                                                                row.status === "completed" || row.status === "sold" || row.status === "arrived"
                                                                    ? "good"
                                                                    : row.status === "no_show"
                                                                        ? "warn"
                                                                        : "neutral"
                                                            }
                                                        />
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Section 5: Partner Store Matrix */}
                    <Card>
                        <CardHeader className="pb-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <Store className="h-4 w-4" />
                                        Partner Store Matrix
                                    </CardTitle>
                                    <CardDescription>
                                        Leads sent to each partner store, appointment show-up rate, and close rate. Click a store to filter.
                                    </CardDescription>
                                </div>
                                {partnerStoreId && (
                                    <Badge variant="secondary" className="gap-1">
                                        Store filtered
                                        <button type="button" onClick={() => setPartnerStoreId(null)} aria-label="Clear store filter">
                                            <X className="h-3 w-3" />
                                        </button>
                                    </Badge>
                                )}
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-muted/50">
                                            <TableHead>Partner Store</TableHead>
                                            <TableHead className="text-right">Leads (% share)</TableHead>
                                            <TableHead className="text-right">Appt Set</TableHead>
                                            <TableHead className="text-right">Showed Up (Show %)</TableHead>
                                            <TableHead className="text-right">No Show</TableHead>
                                            <TableHead className="text-right">Cancelled</TableHead>
                                            <TableHead className="text-right">Sold (Close % of Showed)</TableHead>
                                            <TableHead className="text-right">Sold % of Sent</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {data.partner_stores.length === 0 ? (
                                            <TableEmpty title="No partner store data" description="No leads in this period." />
                                        ) : (
                                            data.partner_stores.map((row) => (
                                                <TableRow
                                                    key={row.partner_store_id ?? "none"}
                                                    className={cn(
                                                        row.partner_store_id && "cursor-pointer hover:bg-muted/40",
                                                        row.partner_store_id && partnerStoreId === row.partner_store_id && "bg-primary/5",
                                                        !row.partner_store_id && "text-muted-foreground"
                                                    )}
                                                    onClick={() => {
                                                        if (!row.partner_store_id) return
                                                        setPartnerStoreId((prev) =>
                                                            prev === row.partner_store_id ? null : row.partner_store_id ?? null
                                                        )
                                                    }}
                                                >
                                                    <TableCell className="font-medium">{row.partner_store_name}</TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.leads_sent} pct={row.share_pct} />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct count={row.appt_set} pct={row.appt_set_pct} />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={row.showed_up}
                                                            pct={row.show_rate_pct}
                                                            tone={row.show_rate_pct >= 50 ? "good" : row.showed_up > 0 ? "warn" : "neutral"}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={row.no_show}
                                                            pct={row.no_show_pct}
                                                            tone={row.no_show_pct >= 40 ? "bad" : "neutral"}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {row.cancelled.toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <CountWithPct
                                                            count={row.sold}
                                                            pct={row.close_rate_of_showed_pct}
                                                            tone={row.sold > 0 ? "good" : "neutral"}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <PctBadge value={row.sold_of_sent_pct} tone={row.sold > 0 ? "good" : "neutral"} />
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>
                </>
            ) : null}
        </div>
    )
}
