"use client"

import * as React from "react"
import { MapPin } from "lucide-react"
import { PartnerStoreService, type DriveTimesResponse } from "@/services/partner-store-service"

function formatMinutes(minutes: number) {
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

export function LeadStoreDrive({ postalCode }: { postalCode?: string | null }) {
    const zip = (postalCode || "").trim()
    const [data, setData] = React.useState<DriveTimesResponse | null>(null)
    const [failed, setFailed] = React.useState(false)

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

    return (
        <div className="mt-4 w-full rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-left">
            <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                    {zip ? (
                        <p className="text-sm font-medium text-foreground">
                            {data?.postal_code || zip}
                            {data?.place ? <span className="font-normal text-muted-foreground"> · {data.place}</span> : null}
                        </p>
                    ) : (
                        <p className="text-sm text-muted-foreground">No ZIP on this lead</p>
                    )}
                    {zip && failed && (
                        <p className="mt-1 text-xs text-muted-foreground">Couldn’t place this ZIP.</p>
                    )}
                    {data && (data.stores?.length ?? 0) > 0 && (
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
                    {data && (data.stores?.length ?? 0) === 0 && !failed && (
                        <p className="mt-1 text-xs text-muted-foreground">No store ZIP to compare.</p>
                    )}
                </div>
            </div>
        </div>
    )
}
