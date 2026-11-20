"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertCircle, ChevronDown, Loader2, PhoneCall, Search, TrendingUp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { EmptyState } from "@/components/ui/empty-state"
import { PageHeader } from "@/components/ui/page-header"
import { cn } from "@/lib/utils"
import { CallReviewService, RecurringIssues, RecurringRow, apiErrorMessage } from "@/services/call-review-service"

const PERIODS = [
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: 90, label: "90 days" },
    { days: 365, label: "1 year" },
]

function fmtDate(iso: string | null): string {
    if (!iso) return "—"
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "3 more than last period" in words, so the direction never relies on colour alone. */
function Change({ now, before, previousCalls }: { now: number; before: number; previousCalls: number }) {
    // With no reviewed calls last period there is nothing to compare against
    if (previousCalls === 0) return <span className="text-xs text-muted-foreground">No calls reviewed last period</span>
    const diff = now - before
    if (diff === 0) return <span className="text-xs text-muted-foreground">Same as last period</span>
    return (
        <span
            className={cn(
                "text-xs font-medium",
                // More of a problem is bad news; fewer is good news
                diff > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
            )}
        >
            {diff > 0 ? "▲" : "▼"} {Math.abs(diff)} {diff > 0 ? "more" : "fewer"} than last period ({before})
        </span>
    )
}

function IssueRow({
    row,
    total,
    previousCalls,
    tone,
}: {
    row: RecurringRow
    total: number
    previousCalls: number
    tone: "hidden" | "fix"
}) {
    const [open, setOpen] = React.useState(false)
    const share = total ? row.count / total : 0
    const panelId = `issue-${tone}-${row.key}`
    return (
        <li className="rounded-lg border">
            <button
                type="button"
                className="flex w-full items-start gap-4 rounded-lg p-4 text-left hover:bg-muted/50"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls={panelId}
            >
                <div
                    className={cn(
                        "flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-md",
                        tone === "hidden" ? "bg-primary/10 text-primary" : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    )}
                >
                    <span className="text-lg font-bold leading-none tabular-nums">{row.count}</span>
                    <span className="text-[10px] uppercase tracking-wide">calls</span>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="font-medium">{row.label}</span>
                        <Change now={row.count} before={row.previous_count} previousCalls={previousCalls} />
                    </div>
                    <div className="h-2 w-full rounded-sm bg-muted" title={`${row.count} of ${total} reviewed calls`}>
                        <div
                            className={cn("h-full rounded-r-[4px]", tone === "hidden" ? "bg-primary" : "bg-amber-500")}
                            style={{ width: `${Math.max(share * 100, 1)}%` }}
                        />
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {row.count} of {total} reviewed calls ·{" "}
                        {row.by_rep
                            .slice(0, 3)
                            .map((r) => `${r.name} ${r.count}`)
                            .join(", ")}
                        {row.by_rep.length > 3 ? `, +${row.by_rep.length - 3} more` : ""}
                    </p>
                </div>
                <ChevronDown
                    className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
                />
            </button>
            {open && (
                <ul id={panelId} className="divide-y border-t">
                    {row.examples.map((ex) => (
                        <li key={ex.review_id}>
                            <Link
                                href={`/call-reviews/${ex.review_id}`}
                                className="flex flex-col gap-0.5 px-4 py-2.5 text-sm hover:bg-muted/50 sm:flex-row sm:gap-4"
                            >
                                <span className="shrink-0 text-xs text-muted-foreground sm:w-36 sm:pt-0.5">
                                    {fmtDate(ex.date)} · {ex.rep}
                                </span>
                                <span className="flex-1">
                                    {ex.text}
                                    {ex.confidence && (
                                        <span className="ml-1.5 text-xs text-muted-foreground">({ex.confidence} confidence)</span>
                                    )}
                                </span>
                            </Link>
                        </li>
                    ))}
                    {row.count > row.examples.length && (
                        <li className="px-4 py-2.5 text-xs text-muted-foreground">
                            Showing the {row.examples.length} most recent of {row.count}.
                        </li>
                    )}
                </ul>
            )}
        </li>
    )
}

function IssueList({
    title,
    description,
    icon,
    rows,
    total,
    previousCalls,
    tone,
    emptyText,
}: {
    title: string
    description: string
    icon: React.ReactNode
    rows: RecurringRow[]
    total: number
    previousCalls: number
    tone: "hidden" | "fix"
    emptyText: string
}) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    {icon}
                    {title}
                </CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent>
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{emptyText}</p>
                ) : (
                    <ul className="space-y-3">
                        {rows.map((row) => (
                            <IssueRow key={row.key} row={row} total={total} previousCalls={previousCalls} tone={tone} />
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    )
}

export default function RecurringIssuesPage() {
    const router = useRouter()
    const [days, setDays] = React.useState(30)
    const [data, setData] = React.useState<RecurringIssues | null>(null)
    const [isLoading, setIsLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        let cancelled = false
        setIsLoading(true)
        CallReviewService.getRecurring(days)
            .then((d) => {
                if (cancelled) return
                setData(d)
                setError(null)
            })
            .catch((err) => {
                if (!cancelled) setError(apiErrorMessage(err, "Could not load recurring issues."))
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [days])

    return (
        <div className="space-y-6">
            <PageHeader
                title="Recurring issues"
                description="A running count of the hidden objections the AI suspects and the “Fix this” points on reviewed calls. Each call counts once in each list."
                actions={
                    <div className="flex flex-wrap gap-1" role="group" aria-label="Time period">
                        {PERIODS.map((p) => (
                            <Button
                                key={p.days}
                                size="sm"
                                variant={days === p.days ? "default" : "outline"}
                                aria-pressed={days === p.days}
                                onClick={() => setDays(p.days)}
                            >
                                {p.label}
                            </Button>
                        ))}
                    </div>
                }
            />

            {error && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {isLoading && !data ? (
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            ) : !data ? null : data.calls_reviewed === 0 ? (
                <Card>
                    <CardContent>
                        <EmptyState
                            icon={<PhoneCall />}
                            title="No reviewed calls in this period"
                            description="The lists fill up as calls are reviewed."
                            action={{ label: "Go to Call Reviews", onClick: () => router.push("/call-reviews") }}
                        />
                    </CardContent>
                </Card>
            ) : (
                <div className={cn("grid gap-6 2xl:grid-cols-2", isLoading && "opacity-60")}>
                    <IssueList
                        title="Hidden objections"
                        description="What the AI suspects customers were really worried about but didn't say. Guesses, not facts; ones a manager marked wrong are left out. Click a row to see the calls."
                        icon={<Search className="h-4 w-4 text-primary" />}
                        rows={data.hidden_objections}
                        total={data.calls_reviewed}
                        previousCalls={data.previous_calls_reviewed}
                        tone="hidden"
                        emptyText="No guesses yet in this period. Calls reviewed before guessing was added have none until re-scored."
                    />
                    <IssueList
                        title="Fix this"
                        description="The one thing to fix on each call, as shown on the call page, grouped by kind. Click a row to see the calls."
                        icon={<TrendingUp className="h-4 w-4 text-amber-600" />}
                        rows={data.fixes}
                        total={data.calls_reviewed}
                        previousCalls={data.previous_calls_reviewed}
                        tone="fix"
                        emptyText="Nothing flagged to fix in this period."
                    />
                </div>
            )}
        </div>
    )
}
