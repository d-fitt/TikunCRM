"use client"

import * as React from "react"
import Link from "next/link"
import { UserPlus } from "lucide-react"
import { useWebSocketEvent } from "@/hooks/use-websocket"
import { LeadService } from "@/services/lead-service"

export function NewLeadsBell() {
    const [count, setCount] = React.useState(0)
    const timer = React.useRef<number | null>(null)

    const refresh = React.useCallback(() => {
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
            void LeadService.getFreshCount()
                .then((res) => setCount(res.count || 0))
                .catch(() => {})
        }, 300)
    }, [])

    React.useEffect(() => {
        refresh()
        return () => {
            if (timer.current) window.clearTimeout(timer.current)
        }
    }, [refresh])

    useWebSocketEvent("lead:created", refresh, [refresh])
    useWebSocketEvent("lead:updated", refresh, [refresh])
    useWebSocketEvent("badges:refresh", refresh, [refresh])
    useWebSocketEvent("stats:refresh", refresh, [refresh])

    return (
        <Link
            href="/leads?filter=fresh"
            className="relative rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={
                count > 0
                    ? `${count} new leads waiting for a first response`
                    : "New leads"
            }
            title="New leads"
        >
            <UserPlus className="h-5 w-5" />
            {count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
                    {count > 99 ? "99+" : count}
                </span>
            )}
        </Link>
    )
}
