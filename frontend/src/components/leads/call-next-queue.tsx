"use client"

import * as React from "react"
import Link from "next/link"
import { Loader2, Phone, Sparkles, Store } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { useCallLeadOptional } from "@/contexts/call-lead-context"
import { useToast } from "@/hooks/use-toast"
import { useBrowserTimezone } from "@/hooks/use-browser-timezone"
import { useWebSocketEvent } from "@/hooks/use-websocket"
import {
    DashboardService,
    type BdcWorkOutcome,
    type BdcWorkQueueItem,
} from "@/services/dashboard-service"
import { voiceService } from "@/services/voice-service"
import { cn } from "@/lib/utils"

const WORK_OUTCOMES: { id: BdcWorkOutcome; label: string }[] = [
    { id: "no_answer", label: "No answer" },
    { id: "voicemail", label: "Voicemail" },
    { id: "spoke", label: "Spoke" },
    { id: "not_now", label: "Not now" },
]

export function CallNextQueue() {
    const callLeadCtx = useCallLeadOptional()
    const { toast } = useToast()
    const { timezone } = useBrowserTimezone()
    const [items, setItems] = React.useState<BdcWorkQueueItem[]>([])
    const [status, setStatus] = React.useState<string>("empty")
    const [generatedAt, setGeneratedAt] = React.useState<string | null>(null)
    const [scannedCount, setScannedCount] = React.useState(0)
    const [progressDone, setProgressDone] = React.useState(0)
    const [progressTotal, setProgressTotal] = React.useState(0)
    const [progressLabel, setProgressLabel] = React.useState<string | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [rechecking, setRechecking] = React.useState(false)
    const [busyLeadId, setBusyLeadId] = React.useState<string | null>(null)
    const [voiceEnabled, setVoiceEnabled] = React.useState(false)
    const baselineRef = React.useRef<string | null | undefined>(undefined)

    React.useEffect(() => {
        voiceService.getConfig().then((config) => setVoiceEnabled(!!config.voice_enabled)).catch(() => setVoiceEnabled(false))
    }, [])

    const load = React.useCallback(async () => {
        try {
            const data = await DashboardService.getBdcWorkQueue({ tz: timezone })
            const stamp = data.generated_at || null
            const waiting = baselineRef.current !== undefined
            const stillOld = waiting && stamp === baselineRef.current && data.status !== "failed" && data.status !== "running"
            if (stillOld) {
                setStatus("running")
                return
            }
            if (data.status === "ready" || data.status === "failed" || data.status === "empty") {
                baselineRef.current = undefined
                setRechecking(false)
            }
            setItems(data.items || [])
            setStatus(data.status || "empty")
            setGeneratedAt(stamp)
            setScannedCount(data.scanned_count || 0)
            setProgressDone(data.progress_done || 0)
            setProgressTotal(data.progress_total || 0)
            setProgressLabel(data.progress_label || null)
            setError(data.error || null)
        } catch {
            setError("Could not load who to call next.")
        } finally {
            setLoading(false)
        }
    }, [timezone])

    React.useEffect(() => {
        setLoading(true)
        void load()
    }, [load])

    React.useEffect(() => {
        if (status !== "running" && !rechecking) return
        const id = window.setInterval(() => {
            void load()
        }, 3000)
        return () => window.clearInterval(id)
    }, [status, rechecking, load])

    const timer = React.useRef<number | null>(null)
    const refresh = React.useCallback(() => {
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
            void load()
        }, 400)
    }, [load])

    React.useEffect(() => () => {
        if (timer.current) window.clearTimeout(timer.current)
    }, [])

    useWebSocketEvent("lead:created", refresh, [refresh])
    useWebSocketEvent("lead:updated", refresh, [refresh])
    useWebSocketEvent("badges:refresh", refresh, [refresh])
    useWebSocketEvent("stats:refresh", refresh, [refresh])

    async function callLead(item: BdcWorkQueueItem) {
        if (!item.phone) {
            toast({
                title: "No phone number",
                description: "Open the lead and add a number first.",
                variant: "destructive",
            })
            return
        }
        setBusyLeadId(item.lead_id)
        try {
            const next = await DashboardService.claimBdcWorkQueue(item.lead_id)
            setItems(next.items || [])
            setStatus(next.status || "ready")
            setGeneratedAt(next.generated_at || null)
            setScannedCount(next.scanned_count || 0)
        } catch (error) {
            const taken = (error as { response?: { status?: number } })?.response?.status === 409
            toast({
                title: taken ? "Already being called" : "Could not start the call",
                description: taken
                    ? "Someone else just started this call. The list has been updated."
                    : "This lead is still on the list. Try again.",
                variant: "destructive",
            })
            void load()
            return
        } finally {
            setBusyLeadId(null)
        }
        if (voiceEnabled && callLeadCtx) {
            callLeadCtx.setCallLead({
                phone: item.phone,
                leadId: item.lead_id,
                leadName: item.customer_name,
            })
            return
        }
        window.location.href = `tel:${item.phone}`
    }

    async function recheck() {
        baselineRef.current = generatedAt
        setRechecking(true)
        setStatus("running")
        setProgressDone(0)
        setProgressTotal(0)
        setProgressLabel("Starting the check")
        try {
            const data = await DashboardService.refreshBdcWorkQueue()
            setItems(data.items || [])
            setStatus("running")
            setGeneratedAt(data.generated_at || null)
            setScannedCount(data.scanned_count || 0)
            setError(null)
        } catch {
            setRechecking(false)
            setStatus("failed")
            setError("Could not start the recheck.")
        }
    }

    const checkedLabel = generatedAt
        ? `Last checked ${new Date(generatedAt).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
        : "Not checked yet"

    async function markOutcome(item: BdcWorkQueueItem, outcome: BdcWorkOutcome) {
        setBusyLeadId(item.lead_id)
        try {
            const next = await DashboardService.dispositionBdcWorkQueue(
                item.lead_id,
                { outcome, timezone },
            )
            setItems(next.items || [])
            setStatus(next.status || "ready")
            setGeneratedAt(next.generated_at || null)
            setScannedCount(next.scanned_count || 0)
            setError(next.error || null)
        } catch {
            toast({
                title: "Could not save",
                description: "The list was not updated. Try again.",
                variant: "destructive",
            })
        } finally {
            setBusyLeadId(null)
        }
    }

    return (
        <Card className="border-primary/30">
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-xl">
                            <Sparkles className="h-5 w-5 text-primary" />
                            Call next
                        </CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {status === "running" || rechecking
                                ? "Checking every lead: notes, missed follow-ups, appointments, and calls."
                                : "One list for the whole BDC team. A lead leaves this list as soon as a call starts."}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {checkedLabel}
                            {scannedCount > 0 ? ` · ${scannedCount.toLocaleString()} leads reviewed` : ""}
                            {status === "ready" ? ` · ${items.length.toLocaleString()} need attention` : ""}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" disabled={status === "running" || rechecking} onClick={() => void recheck()}>
                            {(status === "running" || rechecking) && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                            Recheck all leads
                        </Button>
                    </div>
                </div>
                {(status === "running" || rechecking) && (
                    <div className="mt-3 space-y-1.5">
                        <div className="relative">
                            <Progress
                                value={progressTotal > 0 ? progressDone : 0}
                                max={progressTotal > 0 ? progressTotal : 100}
                            />
                            {progressDone <= 0 && (
                                <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
                                    <div className="h-full w-1/3 bg-primary [animation:call-next-progress_1.4s_ease-in-out_infinite]" />
                                </div>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {progressLabel || "Starting the check"}
                        </p>
                    </div>
                )}
            </CardHeader>
            <CardContent className="space-y-3">
                {loading && (
                    <div className="flex justify-center py-10">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                )}
                {!loading && error && (
                    <p className="text-sm text-destructive">{error}</p>
                )}
                {!loading && !error && items.length === 0 && status !== "running" && !rechecking && (
                    <div className="rounded-lg border border-dashed py-10 text-center">
                        <p className="text-sm font-medium">
                            {status === "empty"
                                ? "No morning check yet. Recheck all leads to build today's list."
                                : "Nothing needs attention. You are caught up."}
                        </p>
                    </div>
                )}
                {!loading && items.map((item) => {
                    const busy = busyLeadId === item.lead_id
                    const linkLabel = item.action === "confirm" ? "Confirm" : item.action === "book" ? "Book" : "Open"
                    return (
                        <div
                            key={item.lead_id}
                            className={cn(
                                "rounded-lg border p-4",
                                item.rank === 1 ? "border-primary bg-primary/[0.04]" : "bg-card",
                            )}
                        >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                                            #{item.rank}
                                        </span>
                                        <Link href={`/leads/${item.lead_id}`} className="font-semibold hover:underline">
                                            {item.customer_name}
                                        </Link>
                                        {item.chips.map((chip) => (
                                            <Badge
                                                key={chip}
                                                variant={chip === "Do not call" ? "destructive" : "outline"}
                                            >
                                                {chip}
                                            </Badge>
                                        ))}
                                    </div>
                                    <div className="mt-2 space-y-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                                        <p>
                                            <span className="font-medium">Why call: </span>
                                            {item.why || item.reason}
                                        </p>
                                        {item.ask && (
                                            <p>
                                                <span className="font-medium">Ask: </span>
                                                {item.ask}
                                            </p>
                                        )}
                                    </div>
                                    <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                                        {item.store_name && (
                                            <span className="inline-flex items-center gap-1">
                                                <Store className="h-3 w-3" />
                                                {item.store_name}
                                            </span>
                                        )}
                                        {item.phone && (
                                            <span className="inline-flex items-center gap-1">
                                                <Phone className="h-3 w-3" />
                                                {item.phone}
                                            </span>
                                        )}
                                        {item.last_outcome && <span>Last: {item.last_outcome}</span>}
                                    </p>
                                    {item.note_preview && (
                                        <p className="mt-2 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                                            <span className="font-medium text-foreground">Their note: </span>
                                            {item.note_preview}
                                        </p>
                                    )}
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-2">
                                    <Button size="sm" disabled={busy || !item.phone} onClick={() => callLead(item)}>
                                        <Phone className="mr-1.5 h-3.5 w-3.5" />
                                        Call
                                    </Button>
                                    <Button variant="outline" size="sm" asChild>
                                        <Link href={`/leads/${item.lead_id}`}>{linkLabel}</Link>
                                    </Button>
                                </div>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                                {WORK_OUTCOMES.map((outcome) => (
                                    <Button
                                        key={outcome.id}
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => markOutcome(item, outcome.id)}
                                    >
                                        {outcome.label}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )
                })}
            </CardContent>
        </Card>
    )
}
