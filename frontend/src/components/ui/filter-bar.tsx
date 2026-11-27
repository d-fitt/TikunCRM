"use client"

import * as React from "react"
import { Menu, RotateCcw, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface AdvancedFiltersMenuProps {
    /** Number of currently active filters inside this menu (shows a badge on the hamburger icon). */
    activeCount?: number
    /** Reset only the filters inside this menu (or all filters). */
    onReset?: () => void
    /** Optional heading inside the popover. */
    title?: string
    /** Alignment of the popover relative to the hamburger button. */
    align?: "start" | "center" | "end"
    /** Popover width class override. */
    contentClassName?: string
    /** Button class override. */
    triggerClassName?: string
    /** Show text next to hamburger icon (default: false — compact hamburger button, or pass a label). */
    label?: string
    children: React.ReactNode
}

/**
 * Unified hamburger-icon trigger for secondary / advanced filters.
 * Keeps main screens clean while exposing all advanced filters consistently across pages.
 */
export function AdvancedFiltersMenu({
    activeCount = 0,
    onReset,
    title = "More filters",
    align = "end",
    contentClassName,
    triggerClassName,
    label,
    children,
}: AdvancedFiltersMenuProps) {
    const [open, setOpen] = React.useState(false)

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant={activeCount > 0 ? "secondary" : "outline"}
                    size="sm"
                    aria-label={label || title}
                    title={label || title}
                    className={cn(
                        "h-9 shrink-0 gap-1.5 px-2.5",
                        activeCount > 0 && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
                        triggerClassName
                    )}
                >
                    <Menu className="h-4 w-4 shrink-0" />
                    {label ? <span className="text-xs font-medium">{label}</span> : null}
                    {activeCount > 0 ? (
                        <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground tabular-nums">
                            {activeCount}
                        </span>
                    ) : null}
                </Button>
            </PopoverTrigger>
            <PopoverContent
                align={align}
                sideOffset={6}
                className={cn(
                    "w-[min(92vw,420px)] max-h-[78vh] overflow-y-auto p-4",
                    contentClassName
                )}
            >
                <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2.5">
                    <div className="flex items-center gap-2">
                        <Menu className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">{title}</span>
                        {activeCount > 0 ? (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
                                {activeCount} active
                            </span>
                        ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                        {onReset && activeCount > 0 ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                onClick={onReset}
                            >
                                <RotateCcw className="mr-1 h-3 w-3" />
                                Reset
                            </Button>
                        ) : null}
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground"
                            onClick={() => setOpen(false)}
                            aria-label="Close filters"
                        >
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
                <div className="space-y-3">{children}</div>
            </PopoverContent>
        </Popover>
    )
}

export function FilterField({
    label,
    className,
    children,
}: {
    label: string
    className?: string
    children: React.ReactNode
}) {
    return (
        <div className={cn("flex flex-col gap-1.5", className)}>
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {children}
        </div>
    )
}
