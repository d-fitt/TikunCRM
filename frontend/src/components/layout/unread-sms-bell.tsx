"use client"

import * as React from "react"
import Link from "next/link"
import { MessageSquare } from "lucide-react"
import { subscribeSmsUnread } from "@/lib/sms-unread"

export function UnreadSmsBell() {
    const [count, setCount] = React.useState(0)

    React.useEffect(() => subscribeSmsUnread(setCount), [])

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
