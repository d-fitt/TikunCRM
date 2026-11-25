"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"

const TABS = [
    { href: "/call-reviews/dashboard", label: "Scores" },
    { href: "/call-reviews/recurring", label: "Patterns" },
] as const

/** Switches between the two "All Calls" views. */
export function AllCallsTabs({ active }: { active: "/call-reviews/dashboard" | "/call-reviews/recurring" }) {
    return (
        <nav aria-label="All Calls views" className="flex gap-1 border-b">
            {TABS.map((t) => (
                <Link
                    key={t.href}
                    href={t.href}
                    aria-current={active === t.href ? "page" : undefined}
                    className={cn(
                        "-mb-px border-b-2 px-3 pb-2 text-sm font-medium transition-colors",
                        active === t.href
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                >
                    {t.label}
                </Link>
            ))}
        </nav>
    )
}
