"use client"

import * as React from "react"
import { Loader2, MapPin } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PartnerStoreService, type DriveTimesResponse } from "@/services/partner-store-service"

function formatMinutes(minutes: number) {
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

function normalizeZip(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 9)
    if (digits.length <= 5) return digits
    return `${digits.slice(0, 5)}-${digits.slice(5)}`
}

function errorText(err: unknown) {
    const detail =
        err && typeof err === "object" && "response" in err
            ? (err as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
            : undefined
    if (typeof detail === "string" && detail.trim()) return detail
    if (Array.isArray(detail)) {
        const parts = detail
            .map((item) => (item && typeof item === "object" && "msg" in item ? String((item as { msg?: unknown }).msg || "") : ""))
            .filter(Boolean)
        if (parts.length) return parts.join(". ")
    }
    return "Could not save the ZIP."
}

export function LeadStoreDrive({
    postalCode,
    onSave,
}: {
    postalCode?: string | null
    onSave?: (postalCode: string) => Promise<void>
}) {
    const zip = (postalCode || "").trim()
    const [data, setData] = React.useState<DriveTimesResponse | null>(null)
    const [failed, setFailed] = React.useState(false)
    const [editing, setEditing] = React.useState(false)
    const [draft, setDraft] = React.useState("")
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState("")
    const showForm = Boolean(onSave) && (!zip || editing)

    React.useEffect(() => {
        if (zip.replace(/\D/g, "").length < 5) {
            setData(null)
            setFailed(false)
            return
        }
        let cancelled = false
        setFailed(false)
        PartnerStoreService.driveTimes(zip)
            .then((next) => {
                if (!cancelled) setData(next)
            })
            .catch(() => {
                if (!cancelled) {
                    setData(null)
                    setFailed(true)
                }
            })
        return () => {
            cancelled = true
        }
    }, [zip])

    const save = async (event: React.FormEvent) => {
        event.preventDefault()
        if (!onSave) return
        const next = normalizeZip(draft)
        if (next.replace(/\D/g, "").length < 5) {
            setError("Enter a 5-digit ZIP.")
            return
        }
        setSaving(true)
        setError("")
        try {
            await onSave(next)
            setEditing(false)
            setDraft("")
        } catch (err) {
            setError(errorText(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="mt-4 w-full rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-left">
            <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                    {showForm ? (
                        <form onSubmit={save} className="space-y-1.5">
                            <p className="text-xs text-muted-foreground">
                                {zip ? "Change ZIP" : "Add a ZIP to see drive time to each store."}
                            </p>
                            <div className="flex items-center gap-2">
                                <Input
                                    value={draft}
                                    onChange={(event) => {
                                        setDraft(event.target.value)
                                        setError("")
                                    }}
                                    placeholder="30071"
                                    inputMode="numeric"
                                    autoComplete="postal-code"
                                    maxLength={10}
                                    aria-label="ZIP code"
                                    className="h-8 bg-background text-sm"
                                />
                                <Button type="submit" size="sm" className="h-8 px-3" disabled={saving}>
                                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : zip ? "Save" : "Add"}
                                </Button>
                                {zip ? (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2"
                                        disabled={saving}
                                        onClick={() => {
                                            setEditing(false)
                                            setDraft("")
                                            setError("")
                                        }}
                                    >
                                        Cancel
                                    </Button>
                                ) : null}
                            </div>
                            {error ? <p className="text-xs text-destructive">{error}</p> : null}
                        </form>
                    ) : zip ? (
                        <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium text-foreground">
                                {data?.postal_code || zip}
                                {data?.place ? <span className="font-normal text-muted-foreground"> · {data.place}</span> : null}
                            </p>
                            {onSave ? (
                                <button
                                    type="button"
                                    className="shrink-0 text-xs font-medium text-primary hover:underline"
                                    onClick={() => {
                                        setDraft(zip)
                                        setError("")
                                        setEditing(true)
                                    }}
                                >
                                    Change
                                </button>
                            ) : null}
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">No ZIP on this lead</p>
                    )}
                    {zip && !showForm && failed && (
                        <p className="mt-1 text-xs text-muted-foreground">Couldn’t place this ZIP.</p>
                    )}
                    {zip && !showForm && data && (data.stores?.length ?? 0) > 0 && (
                        <ul className="mt-2 space-y-1">
                            {data.stores.map((store, index) => (
                                <li key={store.id} className="flex items-baseline justify-between gap-3 text-xs">
                                    <span className={index === 0 ? "min-w-0 truncate font-medium text-foreground" : "min-w-0 truncate text-muted-foreground"}>
                                        {store.name}
                                        {store.city ? <span className="text-muted-foreground"> · {store.city}</span> : null}
                                    </span>
                                    <span className="shrink-0 tabular-nums text-foreground">{formatMinutes(store.minutes)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {zip && !showForm && data && (data.stores?.length ?? 0) === 0 && !failed && (
                        <p className="mt-1 text-xs text-muted-foreground">No store address to compare.</p>
                    )}
                </div>
            </div>
        </div>
    )
}
