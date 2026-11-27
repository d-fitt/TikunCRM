"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bot,
  ChevronDown,
  ExternalLink,
  History,
  Loader2,
  Phone,
  Plus,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useAiCopilot } from "@/contexts/ai-copilot-context"
import {
  AiAssistantService,
  AiConversationBrief,
  AiMessage,
  AiLeadTableRow,
  AiNoteHitLead,
  AiUiBlock,
  buildLeadsUrlFromFilters,
  filterParamsToLeadListParams,
} from "@/services/ai-assistant-service"
import {
  AiMessageContent,
  compactAssistantText,
} from "@/components/ai/ai-message-content"
import {
  getLeadFullName,
  getLeadPhone,
  LeadService,
} from "@/services/lead-service"
import { getStageLabel } from "@/services/lead-stage-service"

type LiveTool = {
  name: string
  label: string
  args?: Record<string, unknown>
  summary?: string
  status: "running" | "done"
}

type LiveAssistant = {
  thinking: string
  thinkingDone: boolean
  thinkingMs?: number
  tools: LiveTool[]
  content: string
  uiBlocks: AiUiBlock[]
}

const CHAT_STORAGE_KEY = "tikun-copilot-chat"

const SUGGESTIONS = [
  "Leads with SSN, DL, and about 2000–3000 down",
  "Who should I call first this morning?",
  "Which of my leads mentioned a trade-in this week?",
  "Find notes about Camry or financing in my leads",
]

const TOOL_DISPLAY: Record<string, string> = {
  search_leads: "Search leads",
  search_crm_content: "Search notes & activities",
  rank_leads_to_call: "Rank call priority",
  list_stages: "Pipeline stages",
  list_salespersons: "Team lookup",
  assign_leads: "Prepare assignment",
  update_lead_stages: "Prepare stage change",
  create_follow_ups: "Prepare follow-ups",
  query_database: "Checked the database",
}

function toolDisplayName(name: string) {
  return TOOL_DISPLAY[name] || name.replace(/_/g, " ")
}

function StipBadges({ lead }: { lead: AiLeadTableRow }) {
  const tags = [
    lead.has_ssn_stip ? "SSN" : null,
    lead.has_dl_stip ? "DL" : null,
    lead.is_business === true
      ? "Business"
      : lead.is_business === false
        ? "Personal"
        : null,
  ].filter(Boolean)

  if (!tags.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {t}
        </span>
      ))}
    </div>
  )
}

function ThinkingBlock({
  text,
  done,
  durationMs,
  streaming,
}: {
  text: string
  done: boolean
  durationMs?: number
  streaming?: boolean
}) {
  const [open, setOpen] = React.useState(!done)
  React.useEffect(() => {
    if (done) setOpen(false)
  }, [done])

  return (
    <div className="mb-3 rounded-lg border bg-muted/40 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <Sparkles className={cn("h-3.5 w-3.5", streaming && "animate-pulse")} />
        <span className="font-medium">
          {done
            ? `Thought for ${Math.max(1, Math.round((durationMs || 0) / 1000))}s`
            : "Thinking…"}
        </span>
        <ChevronDown
          className={cn("ml-auto h-4 w-4 transition", open && "rotate-180")}
        />
      </button>
      {open && text && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  )
}

function ToolChips({ tools }: { tools: LiveTool[] }) {
  if (!tools.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      {tools.map((t, i) => (
        <div
          key={`${t.name}-${i}`}
          className={cn(
            "flex animate-in items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs fade-in slide-in-from-bottom-1",
            t.status === "done"
              ? "border-border bg-muted/50 text-muted-foreground"
              : "border-primary/20 bg-primary/5 text-foreground"
          )}
          style={{ animationDelay: `${i * 70}ms` }}
        >
          {t.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          )}
          <span className="truncate">
            {t.status === "done"
              ? toolDisplayName(t.name)
              : t.label || toolDisplayName(t.name)}
          </span>
        </div>
      ))}
    </div>
  )
}

function mergeNoteHitLeads(
  existing: AiNoteHitLead[],
  incoming: AiNoteHitLead[]
): AiNoteHitLead[] {
  const map = new Map(existing.map((l) => [l.lead_id, l]))
  for (const lead of incoming) {
    const prev = map.get(lead.lead_id)
    if (prev) {
      map.set(lead.lead_id, {
        ...prev,
        snippets: [...(prev.snippets || []), ...(lead.snippets || [])],
      })
    } else {
      map.set(lead.lead_id, lead)
    }
  }
  return Array.from(map.values())
}

function NoteHitsBlock({ block }: { block: AiUiBlock }) {
  const initialLeads = (block.leads || []) as AiNoteHitLead[]
  const [leads, setLeads] = React.useState<AiNoteHitLead[]>(initialLeads)
  const [offset, setOffset] = React.useState(block.offset ?? 0)
  const [hasMore, setHasMore] = React.useState(Boolean(block.has_more))
  const [totalCount, setTotalCount] = React.useState(
    block.total_count ?? block.total ?? initialLeads.length
  )
  const [loading, setLoading] = React.useState(false)
  const pageSize = block.limit ?? 25

  React.useEffect(() => {
    setLeads(initialLeads)
    setOffset(block.offset ?? 0)
    setHasMore(Boolean(block.has_more))
    setTotalCount(block.total_count ?? block.total ?? initialLeads.length)
  }, [block])

  if (!leads.length) {
    return (
      <div className="mt-3 rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
        No timeline matches for this query.
      </div>
    )
  }

  const shownActivities = leads.reduce(
    (n, l) => n + (l.snippets?.length || 0),
    0
  )

  return (
    <div className="overflow-hidden rounded-xl border border-sky-500/25 bg-sky-500/[0.03]">
      <div className="flex items-center justify-between border-b border-sky-500/15 px-3 py-2 text-xs">
        <span className="font-semibold text-sky-950 dark:text-sky-100">
          Timeline matches
        </span>
        <span className="text-muted-foreground">
          {shownActivities}
          {totalCount > shownActivities ? ` / ${totalCount}` : ""} hits ·{" "}
          {leads.length} leads
        </span>
      </div>
      <ul className="max-h-[320px] divide-y overflow-y-auto">
        {leads.map((lead) => (
          <li key={lead.lead_id} className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link
                  href={`/leads/${lead.lead_id}`}
                  className="text-sm font-semibold text-primary hover:underline"
                >
                  {lead.lead_name || "Lead"}
                </Link>
                {lead.stage ? (
                  <p className="text-[11px] text-muted-foreground">{lead.stage}</p>
                ) : null}
              </div>
              {lead.phone ? (
                <a
                  href={`tel:${lead.phone.replace(/\s/g, "")}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium hover:bg-muted"
                >
                  <Phone className="h-3 w-3" />
                  Call
                </a>
              ) : null}
            </div>
            <ul className="mt-2 space-y-1.5">
              {(lead.snippets || []).map((s, i) => (
                <li
                  key={`${s.activity_id || i}`}
                  className="rounded-md border bg-background/80 px-2 py-1.5 text-xs"
                >
                  <p className="font-medium text-foreground/90">
                    {s.activity_label || "Activity"}
                    {s.created_at
                      ? ` · ${new Date(s.created_at).toLocaleDateString()}`
                      : ""}
                  </p>
                  <p className="mt-0.5 text-muted-foreground leading-relaxed">
                    {s.snippet || "—"}
                  </p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {hasMore && block.query ? (
        <div className="border-t px-3 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full text-xs"
            disabled={loading}
            onClick={async () => {
              if (!block.query) return
              setLoading(true)
              try {
                const nextOffset = offset + pageSize
                const result = await AiAssistantService.searchCrmContent({
                  q: block.query,
                  offset: nextOffset,
                  limit: pageSize,
                  pool:
                    typeof block.filter_params?.pool === "string"
                      ? block.filter_params.pool
                      : undefined,
                  days:
                    typeof block.filter_params?.days === "number"
                      ? block.filter_params.days
                      : undefined,
                })
                setLeads((prev) =>
                  mergeNoteHitLeads(prev, result.grouped_leads || [])
                )
                setOffset(result.offset)
                setHasMore(result.has_more)
                setTotalCount(result.total_count)
              } catch (e) {
                console.error("Load more CRM search failed:", e)
              } finally {
                setLoading(false)
              }
            }}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Loading…
              </>
            ) : (
              `Load more (${Math.max(0, totalCount - shownActivities)} remaining)`
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function leadRowFromApi(lead: {
  id: string
  customer?: { first_name?: string; last_name?: string; phone?: string }
  down_payment?: number | null
  has_ssn_stip?: boolean
  has_dl_stip?: boolean
  is_business?: boolean | null
  stage?: { name?: string; display_name?: string }
}): AiLeadTableRow {
  return {
    id: lead.id,
    name: getLeadFullName(lead as Parameters<typeof getLeadFullName>[0]),
    down_payment: lead.down_payment,
    has_ssn_stip: lead.has_ssn_stip,
    has_dl_stip: lead.has_dl_stip,
    is_business: lead.is_business,
    stage: lead.stage
      ? getStageLabel(lead.stage as Parameters<typeof getStageLabel>[0])
      : null,
    phone: getLeadPhone(lead as Parameters<typeof getLeadPhone>[0]),
  }
}

function LeadResultsBlock({
  block,
  ranked,
}: {
  block: AiUiBlock
  ranked?: boolean
}) {
  const initialLeads = (block.leads || []) as AiLeadTableRow[]
  const [leads, setLeads] = React.useState<AiLeadTableRow[]>(initialLeads)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(false)
  const pageSize = 25
  const total = block.total ?? initialLeads.length
  const hasMore = !ranked && leads.length < total

  React.useEffect(() => {
    setLeads(initialLeads)
    setPage(1)
  }, [block])

  const href = buildLeadsUrlFromFilters(block.filter_params)

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/20">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <div>
          <p className="text-xs font-semibold">
            {ranked ? "Call priority" : "Matching leads"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {ranked
              ? `Top ${leads.length} of ${total} considered`
              : `Showing ${leads.length} of ${total}`}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="h-7 text-[11px]">
          <Link href={href} className="inline-flex items-center gap-1">
            Open in Leads
            <ExternalLink className="h-3 w-3" />
          </Link>
        </Button>
      </div>

      <ul className="max-h-[360px] divide-y overflow-y-auto">
        {leads.map((l, idx) => (
          <li
            key={l.id}
            className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30"
          >
            {ranked ? (
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {l.rank ?? idx + 1}
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <Link
                href={`/leads/${l.id}`}
                className="text-sm font-semibold text-primary hover:underline"
              >
                {l.name}
              </Link>
              <StipBadges lead={l} />
              {ranked && l.reasons?.length ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {l.reasons.slice(0, 2).join(" · ")}
                </p>
              ) : (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {l.stage || "No stage"}
                </p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs font-medium tabular-nums">
                {l.down_payment != null
                  ? `$${Number(l.down_payment).toLocaleString()}`
                  : "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">down</p>
              {l.phone ? (
                <a
                  href={`tel:${l.phone.replace(/\s/g, "")}`}
                  className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium text-primary hover:underline"
                >
                  <Phone className="h-3 w-3" />
                  {l.phone}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {hasMore && block.filter_params ? (
        <div className="border-t px-3 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full text-xs"
            disabled={loading}
            onClick={async () => {
              setLoading(true)
              try {
                const nextPage = page + 1
                const data = await LeadService.listLeads(
                  filterParamsToLeadListParams(
                    block.filter_params,
                    nextPage,
                    pageSize
                  )
                )
                const rows = (data.items || []).map(leadRowFromApi)
                setLeads((prev) => {
                  const seen = new Set(prev.map((p) => p.id))
                  return [...prev, ...rows.filter((r) => !seen.has(r.id))]
                })
                setPage(nextPage)
              } catch (e) {
                console.error("Load more leads failed:", e)
              } finally {
                setLoading(false)
              }
            }}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Loading…
              </>
            ) : (
              `Load more (${total - leads.length} remaining)`
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ConfirmActionsBlock({
  block,
  conversationId,
  disabled,
  onDone,
}: {
  block: AiUiBlock
  conversationId: string | null
  disabled?: boolean
  onDone: (note: string) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(false)
  const [status, setStatus] = React.useState<"pending" | "done" | "cancelled">(
    "pending"
  )

  if (dismissed || status === "cancelled") {
    return (
      <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        Actions cancelled
      </div>
    )
  }
  if (status === "done") {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
        Actions confirmed and applied
      </div>
    )
  }

  const actions = block.actions || []

  return (
    <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium">
          Needs confirmation
        </span>
        <span className="text-sm font-semibold">
          {block.title || `Confirm ${actions.length} action(s)`}
        </span>
      </div>
      <ul className="space-y-1 text-sm">
        {actions.map((a, i) => (
          <li key={i} className="text-muted-foreground">
            {i + 1}. {a.summary || a.tool}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || disabled}
          onClick={async () => {
            setBusy(true)
            try {
              const res = await AiAssistantService.confirmActions(
                conversationId,
                actions.map((a) => ({
                  tool: a.tool,
                  args: a.args,
                  summary: a.summary,
                }))
              )
              setStatus("done")
              onDone(res.message || "Actions applied.")
            } catch (e) {
              onDone((e as Error).message || "Confirm failed")
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          Confirm
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || disabled}
          onClick={() => {
            setStatus("cancelled")
            setDismissed(true)
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

function humanizeColumn(name: string) {
  const words = name.replace(/_/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function asMetric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value)
  }
  return null
}

function useCountUp(target: number) {
  const [value, setValue] = React.useState(0)
  React.useEffect(() => {
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 800)
      const eased = 1 - (1 - progress) ** 3
      setValue(target * eased)
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return value
}

function formatMetric(value: number) {
  if (Number.isInteger(value)) return value.toLocaleString()
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

function RateRing({ percent }: { percent: number }) {
  const shown = useCountUp(percent)
  const radius = 32
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (Math.max(0, Math.min(shown, 100)) / 100) * circumference
  return (
    <div className="relative h-20 w-20 shrink-0">
      <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
        <circle cx="40" cy="40" r={radius} className="fill-none stroke-muted" strokeWidth="7" />
        <circle
          cx="40"
          cy="40"
          r={radius}
          className="fill-none stroke-primary transition-[stroke-dashoffset] duration-100"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "none" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
        {shown.toFixed(1)}%
      </div>
    </div>
  )
}

function MetricValue({ value }: { value: number }) {
  const shown = useCountUp(value)
  return <span className="tabular-nums">{formatMetric(shown)}</span>
}

function QueryInsight({ blocks }: { blocks: AiUiBlock[] }) {
  const metrics: Array<{ key: string; label: string; value: number }> = []
  const tables: AiUiBlock[] = []

  for (const block of blocks) {
    const columns = block.columns || []
    const rows = block.rows || []
    const singleAggregate =
      rows.length === 1 && columns.length > 0 && columns.length <= 4 &&
      columns.every((column) => asMetric(rows[0]?.[column]) != null)
    if (!singleAggregate) {
      tables.push(block)
      continue
    }
    for (const column of columns) {
      const value = asMetric(rows[0]?.[column])
      if (value != null) metrics.push({ key: column.toLowerCase(), label: humanizeColumn(column), value })
    }
  }

  const converted = metrics.find((metric) => /convert|sold/.test(metric.key))
  const whole = metrics
    .filter((metric) => metric !== converted && metric.value >= (converted?.value ?? Infinity))
    .sort((a, b) => b.value - a.value)[0]
  const percent =
    converted && whole && whole.value > 0 ? (converted.value / whole.value) * 100 : null

  return (
    <div className="space-y-2">
      {metrics.length > 0 && (
        <div className="animate-in overflow-hidden rounded-2xl border bg-card shadow-sm fade-in slide-in-from-bottom-2 duration-500">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3.5 py-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              From the database
            </p>
          </div>
          <div className="flex items-center gap-4 px-3.5 py-3">
            {percent != null && <RateRing percent={percent} />}
            <div className="grid min-w-0 flex-1 gap-2">
              {metrics.map((metric) => (
                <div key={metric.key} className="min-w-0">
                  <p className="truncate text-[11px] text-muted-foreground">{metric.label}</p>
                  <p className="text-xl font-semibold leading-tight">
                    <MetricValue value={metric.value} />
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {tables.map((block, index) => (
        <QueryTable key={index} block={block} />
      ))}
    </div>
  )
}

function QueryTable({ block }: { block: AiUiBlock }) {
  const columns = block.columns || []
  const rows = block.rows || []
  return (
    <div className="animate-in overflow-hidden rounded-2xl border bg-card shadow-sm fade-in slide-in-from-bottom-2 duration-500">
      <p className="border-b bg-muted/40 px-3.5 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {block.row_count ?? rows.length} row{(block.row_count ?? rows.length) === 1 ? "" : "s"}
        {block.truncated ? " · first rows" : ""}
      </p>
      {columns.length > 0 && rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} className="px-3 py-1.5 font-medium text-muted-foreground">
                    {humanizeColumn(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-t">
                  {columns.map((column) => (
                    <td key={column} className="px-3 py-1.5 tabular-nums">
                      {row[column] == null ? "—" : String(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

function StatsBlock({ block }: { block: AiUiBlock }) {
  const pct =
    typeof block.percentage === "number" ? `${block.percentage}%` : null
  return (
    <div className="rounded-xl border bg-muted/40 px-3 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {block.title || "From the database"}
      </p>
      {pct ? (
        <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{pct}</p>
      ) : null}
      {block.summary ? (
        <p className="mt-1 text-sm text-foreground">{block.summary}</p>
      ) : null}
      {block.scope ? (
        <p className="mt-1 text-xs text-muted-foreground">{block.scope}</p>
      ) : null}
    </div>
  )
}

function UiBlocks({
  blocks,
  conversationId,
  streaming,
  onConfirmDone,
}: {
  blocks?: AiUiBlock[]
  conversationId: string | null
  streaming?: boolean
  onConfirmDone?: (note: string) => void
}) {
  if (!blocks?.length) return null
  const rendered: React.ReactNode[] = []
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (block.type === "query_result") {
      const group = [block]
      while (blocks[i + 1]?.type === "query_result") {
        i += 1
        group.push(blocks[i])
      }
      rendered.push(<QueryInsight key={`query-${i}`} blocks={group} />)
      continue
    }
    if (block.type === "lead_table") {
      rendered.push(<LeadResultsBlock key={`${block.type}-${i}`} block={block} />)
    } else if (block.type === "ranked_leads") {
      rendered.push(<LeadResultsBlock key={`${block.type}-${i}`} block={block} ranked />)
    } else if (block.type === "note_hits") {
      rendered.push(<NoteHitsBlock key={`${block.type}-${i}`} block={block} />)
    } else if (block.type === "crm_stats") {
      rendered.push(<StatsBlock key={`${block.type}-${i}`} block={block} />)
    } else if (block.type === "confirm_actions") {
      rendered.push(
        <ConfirmActionsBlock
          key={`${block.type}-${i}`}
          block={block}
          conversationId={conversationId}
          disabled={streaming}
          onDone={(note) => onConfirmDone?.(note)}
        />
      )
    }
  }
  return <div className="space-y-3">{rendered}</div>
}

function AssistantBubble({
  content,
  thinking,
  thinkingDone,
  thinkingMs,
  tools,
  uiBlocks,
  streaming,
  conversationId,
  onConfirmDone,
}: {
  content: string
  thinking?: string
  thinkingDone?: boolean
  thinkingMs?: number
  tools?: LiveTool[]
  uiBlocks?: AiUiBlock[]
  streaming?: boolean
  conversationId: string | null
  onConfirmDone?: (note: string) => void
}) {
  const displayContent = compactAssistantText(content, uiBlocks)
  const hasBlocks = Boolean(uiBlocks?.length)

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {(thinking || streaming) && (
          <ThinkingBlock
            text={thinking || ""}
            done={!!thinkingDone}
            durationMs={thinkingMs}
            streaming={streaming && !thinkingDone}
          />
        )}
        {tools && tools.length > 0 && <ToolChips tools={tools} />}

        {hasBlocks && (
          <UiBlocks
            blocks={uiBlocks}
            conversationId={conversationId}
            streaming={streaming}
            onConfirmDone={onConfirmDone}
          />
        )}

        {displayContent ? (
          <div className="rounded-2xl border bg-card px-3.5 py-3 shadow-sm">
            <AiMessageContent content={displayContent} />
            {streaming && (
              <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-foreground/70 align-middle" />
            )}
          </div>
        ) : streaming && !hasBlocks ? (
          <p className="text-sm text-muted-foreground">Working…</p>
        ) : null}

        {!displayContent && hasBlocks && !streaming && (
          <p className="text-xs text-muted-foreground">
            Results are shown above — open a lead or use Load more.
          </p>
        )}
      </div>
    </div>
  )
}

function mergeUiBlock(blocks: AiUiBlock[], incoming: AiUiBlock): AiUiBlock[] {
  if (incoming.type === "query_result") {
    const withoutCounts = blocks.filter((block) => block.type !== "query_result")
    return [...withoutCounts, incoming]
  }
  const idx = blocks.findIndex((b) => b.type === incoming.type)
  if (idx >= 0) {
    const next = [...blocks]
    next[idx] = incoming
    return next
  }
  return [...blocks, incoming]
}

export function AiCopilotPanel() {
  const { open, setOpen } = useAiCopilot()
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = React.useState<string | null>(null)
  const [conversationTitle, setConversationTitle] = React.useState("New chat")
  const restoredRef = React.useRef(false)
  const [input, setInput] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<AiMessage[]>([])
  const [live, setLive] = React.useState<LiveAssistant | null>(null)
  const [showHistory, setShowHistory] = React.useState(false)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  const statusQuery = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => AiAssistantService.status(),
    enabled: open,
  })

  const convQuery = useQuery({
    queryKey: ["ai-conversations"],
    queryFn: () => AiAssistantService.listConversations(),
    enabled: open,
  })
  const conversationsRef = React.useRef<AiConversationBrief[]>([])
  conversationsRef.current = convQuery.data || []

  React.useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(t)
    }
  }, [open])

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, live, open])

  const loadConversation = async (id: string) => {
    setError(null)
    setLive(null)
    setConversationId(id)
    sessionStorage.setItem(CHAT_STORAGE_KEY, id)
    setShowHistory(false)
    const data = await AiAssistantService.getConversation(id)
    setConversationTitle(data.title || "Chat")
    setMessages(data.messages || [])
  }

  React.useEffect(() => {
    if (!open || restoredRef.current || convQuery.isLoading) return
    restoredRef.current = true
    const saved = sessionStorage.getItem(CHAT_STORAGE_KEY)
    const nextId = saved || conversationsRef.current[0]?.id
    if (!nextId) return
    void loadConversation(nextId).catch(() => {
      sessionStorage.removeItem(CHAT_STORAGE_KEY)
    })
  }, [open, convQuery.isLoading, convQuery.data])

  const startNew = () => {
    abortRef.current?.abort()
    setConversationId(null)
    setConversationTitle("New chat")
    sessionStorage.removeItem(CHAT_STORAGE_KEY)
    setMessages([])
    setLive(null)
    setError(null)
    setInput("")
    setShowHistory(false)
  }

  const send = async (text?: string) => {
    const message = (text ?? input).trim()
    if (!message || sending) return
    if (!statusQuery.data?.enabled) {
      setError("Tikun AI is not configured. Set OPENAI_API_KEY on the backend.")
      return
    }

    setSending(true)
    setError(null)
    setInput("")
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: "user",
        content: message,
        created_at: new Date().toISOString(),
      },
    ])
    setLive({
      thinking: "",
      thinkingDone: false,
      tools: [],
      content: "",
      uiBlocks: [],
    })

    const ac = new AbortController()
    abortRef.current = ac

    try {
      await AiAssistantService.streamChat(
        message,
        conversationId,
        {
          onConversation: (c) => {
            setConversationId(c.id)
            setConversationTitle(c.title || "Chat")
            sessionStorage.setItem(CHAT_STORAGE_KEY, c.id)
            queryClient.invalidateQueries({ queryKey: ["ai-conversations"] })
          },
          onThinkingStart: () => {
            setLive((prev) =>
              prev ? { ...prev, thinking: "", thinkingDone: false } : prev
            )
          },
          onThinkingDelta: (t) => {
            setLive((prev) =>
              prev ? { ...prev, thinking: prev.thinking + t } : prev
            )
          },
          onThinkingDone: (d) => {
            setLive((prev) =>
              prev
                ? {
                    ...prev,
                    thinking: d.text || prev.thinking,
                    thinkingDone: true,
                    thinkingMs: d.duration_ms,
                  }
                : prev
            )
          },
          onToolStart: (d) => {
            setLive((prev) => {
              if (!prev) return prev
              const existing = prev.tools.findIndex((tool) => tool.name === d.name)
              if (existing >= 0) {
                const tools = [...prev.tools]
                tools[existing] = {
                  ...tools[existing],
                  status: "running",
                  label: d.label || tools[existing].label,
                }
                return { ...prev, tools }
              }
              return {
                ...prev,
                tools: [
                  ...prev.tools,
                  {
                    name: d.name,
                    label: d.label,
                    args: d.args,
                    status: "running",
                  },
                ],
              }
            })
          },
          onToolResult: (d) => {
            setLive((prev) => {
              if (!prev) return prev
              const tools = [...prev.tools]
              for (let i = tools.length - 1; i >= 0; i--) {
                if (tools[i].name === d.name && tools[i].status === "running") {
                  tools[i] = {
                    ...tools[i],
                    status: "done",
                    summary: d.summary,
                  }
                  break
                }
              }
              return { ...prev, tools }
            })
          },
          onMessageDelta: (t) => {
            setLive((prev) =>
              prev ? { ...prev, content: prev.content + t } : prev
            )
          },
          onUiBlock: (block) => {
            setLive((prev) =>
              prev
                ? { ...prev, uiBlocks: mergeUiBlock(prev.uiBlocks, block) }
                : prev
            )
          },
          onDone: (data) => {
            setLive((current) => {
              if (!current) return null
              const finalMsg: AiMessage = {
                id: String(data.message_id || `asst-${Date.now()}`),
                role: "assistant",
                content: current.content,
                thinking: current.thinking,
                tool_traces: current.tools.map((t) => ({
                  name: t.name,
                  args: t.args,
                  result_summary: t.summary,
                })),
                ui_blocks: current.uiBlocks,
                created_at: new Date().toISOString(),
              }
              setMessages((prev) => [...prev, finalMsg])
              return null
            })
            queryClient.invalidateQueries({ queryKey: ["ai-conversations"] })
          },
          onError: (msg) => setError(msg),
        },
        ac.signal
      )
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message || "Stream failed")
      }
    } finally {
      setSending(false)
      abortRef.current = null
    }
  }

  const deleteConv = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await AiAssistantService.deleteConversation(id)
    if (conversationId === id) startNew()
    queryClient.invalidateQueries({ queryKey: ["ai-conversations"] })
  }

  const conversations: AiConversationBrief[] = convQuery.data || []

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-20 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full border bg-primary text-primary-foreground shadow-lg transition hover:scale-105 md:bottom-6 md:right-6"
          aria-label="Open Tikun Copilot"
          title="Tikun Copilot (⌘⇧J)"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}

      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => setOpen(false)}
        aria-hidden={!open}
      />

      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col border-l bg-background shadow-2xl transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full"
        )}
        aria-hidden={!open}
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-tight">Tikun Copilot</h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {conversationTitle}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowHistory((v) => !v)}
            title="Chat history"
          >
            <History className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={startNew}
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setOpen(false)}
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        {showHistory && (
          <div className="min-h-0 flex-1 overflow-y-auto border-b bg-muted/20 px-2 py-2">
            <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Chat history
            </p>
            {conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => loadConversation(c.id)}
                className={cn(
                  "group mb-1 flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-muted",
                  conversationId === c.id && "bg-muted"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.title}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {new Date(c.updated_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
                <Trash2
                  className="mt-1 h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-70"
                  onClick={(e) => deleteConv(c.id, e)}
                />
              </button>
            ))}
            {!conversations.length && (
              <p className="px-2 py-2 text-xs text-muted-foreground">No chats yet</p>
            )}
          </div>
        )}

        <div className={cn("min-h-0 flex-1 overflow-y-auto px-3 py-4", showHistory && "hidden")}>
          <div className="flex flex-col gap-4">
            {!messages.length && !live && (
              <div className="px-1 py-6 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Sparkles className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold">How can I help?</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Search leads, notes, and priorities — results appear as cards you
                  can click or call.
                </p>
                <div className="mt-4 flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="rounded-lg border px-3 py-2 text-left text-xs hover:bg-muted/50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[90%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm">
                    {m.content}
                  </div>
                </div>
              ) : (
                <AssistantBubble
                  key={m.id}
                  content={m.content}
                  thinking={m.thinking || undefined}
                  thinkingDone
                  thinkingMs={4000}
                  tools={(m.tool_traces || []).map((t) => ({
                    name: t.name,
                    label: toolDisplayName(t.name),
                    args: t.args,
                    summary: t.result_summary,
                    status: "done" as const,
                  }))}
                  uiBlocks={m.ui_blocks}
                  conversationId={conversationId}
                  onConfirmDone={(note) => {
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: `confirm-${Date.now()}`,
                        role: "assistant",
                        content: note,
                        created_at: new Date().toISOString(),
                      },
                    ])
                  }}
                />
              )
            )}

            {live && (
              <AssistantBubble
                content={live.content}
                thinking={live.thinking}
                thinkingDone={live.thinkingDone}
                thinkingMs={live.thinkingMs}
                tools={live.tools}
                uiBlocks={live.uiBlocks}
                streaming
                conversationId={conversationId}
              />
            )}

            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        <div className="shrink-0 border-t p-3">
          <div className="flex gap-2">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Copilot…"
              className="min-h-[44px] max-h-32 resize-none text-sm"
              disabled={sending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <Button
              size="icon"
              className="h-11 w-11 shrink-0"
              disabled={sending || !input.trim()}
              onClick={() => send()}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
            Enter to send · Esc to close
          </p>
        </div>
      </aside>
    </>
  )
}
