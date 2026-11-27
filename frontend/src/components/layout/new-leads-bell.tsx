"use client"

import * as React from "react"
import Link from "next/link"
import { UserPlus } from "lucide-react"
import { subscribeShellBadges } from "@/lib/shell-badges"

export function NewLeadsBell() {
    const [count, setCount] = React.useState(0)

    React.useEffect(
        () => subscribeShellBadges((badges) => setCount(badges.freshLeads)),
        []
    )

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
