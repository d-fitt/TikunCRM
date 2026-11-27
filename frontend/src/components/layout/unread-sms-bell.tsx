"use client"

import * as React from "react"
import Link from "next/link"
import { MessageSquare } from "lucide-react"
import { useWebSocketEvent } from "@/hooks/use-websocket"
import { smsService } from "@/services/sms-service"

export function UnreadSmsBell() {
    const [count, setCount] = React.useState(0)
    const timer = React.useRef<number | null>(null)

    const refresh = React.useCallback(() => {
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
            void smsService
                .getUnreadCount()
                .then((n) => setCount(n || 0))
                .catch(() => {})
        }, 250)
    }, [])

    React.useEffect(() => {
        refresh()
        const onChanged = () => refresh()
        window.addEventListener("sms:unread-changed", onChanged)
        const interval = window.setInterval(() => {
            if (document.visibilityState === "visible") refresh()
        }, 20000)
        return () => {
            if (timer.current) window.clearTimeout(timer.current)
            window.removeEventListener("sms:unread-changed", onChanged)
            window.clearInterval(interval)
        }
    }, [refresh])

    useWebSocketEvent("sms:received", refresh, [refresh])
    useWebSocketEvent("badges:refresh", refresh, [refresh])

    return (
        <Link
            href="/sms"
            className="relative rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={
                count > 0
                    ? `${count} unread text ${count === 1 ? "message" : "messages"}`
                    : "Text messages"
            }
            title={count > 0 ? `${count} unread text ${count === 1 ? "message" : "messages"}` : "Text (SMS)"}
        >
            <MessageSquare className="h-5 w-5" />
            {count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-white">
                    {count > 99 ? "99+" : count}
                </span>
            )}
        </Link>
    )
}
