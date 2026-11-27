"use client"

import * as React from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname, useSearchParams } from "next/navigation"
import {
    BarChart3,
    Users,
    Inbox,
    Calendar,
    CalendarClock,
    Settings,
    LogOut,
    ChevronRight,
    ChevronLeft,
    ChevronDown,
    Sparkles,
    LayoutDashboard,
    InboxIcon,
    ClipboardList,
    ClipboardCheck,
    Bell,
    MessageSquare,
    MessageCircle,
    Layers,
    MessagesSquare,
    Store,
    Contact,
    Activity,
    Car,
    FileBarChart,
    Target,
    Send,
    QrCode,
    Timer,
    Smartphone,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuthStore, UserRole } from "@/stores/auth-store"
import { useRole, getRoleDisplayName } from "@/hooks/use-role"
import { subscribeShellBadges } from "@/lib/shell-badges"
import { useSidebarOptional } from "@/contexts/sidebar-context"
import { UserAvatar } from "@/components/ui/avatar"
import { Badge, getRoleVariant } from "@/components/ui/badge"
import { GlobalSearchModal } from "@/components/search/global-search-modal"

interface SidebarLink {
    name: string
    icon: React.ComponentType<{ className?: string }>
    href: string
    roles?: UserRole[]
    badge?: string | number
}

interface SidebarItem {
    name: string
    icon: React.ComponentType<{ className?: string }>
    href?: string
    badge?: string | number
    roles?: UserRole[]
    /** If set, this item is a dropdown with child links */
    children?: SidebarLink[]
}

// All sidebar items with role restrictions
const allSidebarItems: SidebarItem[] = [
    { 
        name: "Dashboard", 
        icon: LayoutDashboard, 
        href: "/dashboard" 
    },
    {
        name: "Leads",
        icon: Inbox,
        children: [
            { name: "All leads", icon: Inbox, href: "/leads?filter=all" },
            { name: "Call next", icon: Sparkles, href: "/leads?filter=call_next", roles: ["bdc"] },
            { name: "Unassigned", icon: InboxIcon, href: "/leads?filter=unassigned" },
            {
                name: "Manager review",
                icon: ClipboardCheck,
                href: "/leads?filter=manager_review",
                roles: ["super_admin", "dealership_admin"],
            },
        ],
    },
    {
        name: "Customers",
        icon: Contact,
        href: "/customers",
    },
    { 
        name: "Appointments", 
        icon: CalendarClock, 
        href: "/appointments" 
    },
    { 
        name: "Carvaminos", 
        icon: Store, 
        href: "/showroom",
        roles: ["super_admin", "dealership_admin"],
    },
    {
        name: "Partner Stores",
        icon: Car,
        href: "/partner-stores",
        roles: ["super_admin", "dealership_admin"],
    },
    { 
        name: "Follow-ups", 
        icon: ClipboardList, 
        href: "/follow-ups" 
    },
    {
        name: "Conversations",
        icon: MessagesSquare,
        children: [
            { name: "Inbox", icon: Inbox, href: "/inbox" },
            { name: "Text (SMS)", icon: Smartphone, href: "/sms" },
            { name: "WhatsApp", icon: MessageCircle, href: "/whatsapp" },
            { name: "Email", icon: MessageSquare, href: "/communications" },
        ],
    },
    {
        name: "More",
        icon: Layers,
        children: [
            {
                name: "Team",
                icon: Users,
                href: "/team",
                roles: ["super_admin", "dealership_admin"],
            },
            {
                name: "Schedules",
                icon: Calendar,
                href: "/schedules",
                roles: ["super_admin", "dealership_admin"],
            },
            { name: "Tasks", icon: ClipboardCheck, href: "/tasks" },
            {
                name: "Time & Pay",
                icon: Timer,
                href: "/time-tracking",
                roles: ["bdc", "super_admin", "dealership_admin"],
            },
            {
                name: "Auto WhatsApp",
                icon: Send,
                href: "/auto-whatsapp",
                roles: ["super_admin", "dealership_admin"],
            },
        ],
    },
    { 
        name: "Notifications", 
        icon: Bell, 
        href: "/notifications" 
    },
    {
        name: "Reports",
        icon: FileBarChart,
        roles: ["super_admin", "dealership_admin", "bdc"],
        children: [
            { name: "Analytics", icon: BarChart3, href: "/analytics" },
            { name: "Leads Analysis", icon: Users, href: "/analytics?tab=leads" },
            { name: "Team Activity", icon: Activity, href: "/team-activity" },
            { name: "Sold Cars", icon: Car, href: "/sold-cars" },
            { name: "BDC Export", icon: QrCode, href: "/reports/bdc-export" },
            { name: "Team touch & close", icon: Target, href: "/reports/team-sales-touch" },
        ],
    },
    { 
        name: "Settings", 
        icon: Settings, 
        href: "/settings" 
    },
]

function visibleToRole(roles: UserRole[] | undefined, role: UserRole): boolean {
    return !roles || roles.includes(role)
}

function getSidebarItemsForRole(role: UserRole | null): SidebarItem[] {
    if (!role) return []

    return allSidebarItems.flatMap((item) => {
        if (!visibleToRole(item.roles, role)) return []
        if (!item.children) return [item]
        const children = item.children.filter((child) => visibleToRole(child.roles, role))
        if (children.length === 0) return []
        return [{ ...item, children }]
    })
}

// Badge counts interface
interface BadgeCounts {
    appointments: number
    followUps: number
    unassigned: number
    managerReview: number
    notifications: number
    whatsappUnread: number
    smsUnread: number
}

function isSidebarLinkActive(pathname: string, searchParams: URLSearchParams, href: string): boolean {
    if (href === "/leads" || href === "/leads?filter=all") {
        const onLeads = pathname === "/leads" || pathname.startsWith("/leads/")
        if (!onLeads) return false
        if (pathname.startsWith("/leads/")) return true
        const filter = searchParams.get("filter")
        return !filter || filter === "all"
    }
    if (href === "/analytics") {
        return pathname === "/analytics" && searchParams.get("tab") !== "leads"
    }
    if (href.includes("?")) {
        const [path, query] = href.split("?", 2)
        if (pathname !== path) return false
        const expected = new URLSearchParams(query)
        for (const [key, value] of expected.entries()) {
            if (searchParams.get(key) !== value) return false
        }
        return true
    }
    return pathname === href || (href !== "/dashboard" && pathname.startsWith(href))
}

export function Sidebar() {
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const { user, logout } = useAuthStore()
    const { role, isSuperAdmin, isDealershipAdmin, isSalesperson } = useRole()
    const sidebarContext = useSidebarOptional()
    const mobileOpen = sidebarContext?.mobileOpen ?? false
    // Mobile drawer always shows the expanded sidebar
    const collapsed = (sidebarContext?.collapsed ?? false) && !mobileOpen
    const [showSearch, setShowSearch] = React.useState(false)

    // Close mobile drawer on navigation
    React.useEffect(() => {
        sidebarContext?.setMobileOpen(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname])
    const [badgeCounts, setBadgeCounts] = React.useState<BadgeCounts>({
        appointments: 0,
        followUps: 0,
        unassigned: 0,
        managerReview: 0,
        notifications: 0,
        whatsappUnread: 0,
        smsUnread: 0,
    })

    React.useEffect(() => subscribeShellBadges((badges) => {
        setBadgeCounts({
            appointments: badges.appointments,
            followUps: badges.followUps,
            unassigned: badges.unassigned,
            managerReview: badges.managerReview,
            notifications: badges.notifications,
            whatsappUnread: badges.whatsappUnread,
            smsUnread: badges.smsUnread,
        })
    }), [])
    
    // Expand Conversations when on any conversation surface
    const isConversationsActive = ["/whatsapp", "/inbox", "/communications", "/sms", "/calls"].some(
        (p) => pathname === p || pathname.startsWith(`${p}/`)
    )
    const reportPaths = ["/analytics", "/team-activity", "/sold-cars", "/reports/team-sales-touch", "/reports/bdc-export"]
    const isReportsSectionActive = reportPaths.some(
        (p) => pathname === p || pathname.startsWith(`${p}/`)
    )
    const morePaths = ["/team", "/schedules", "/tasks", "/time-tracking", "/auto-whatsapp"]
    const isMoreSectionActive = morePaths.some(
        (p) => pathname === p || pathname.startsWith(`${p}/`)
    )
    const isLeadsSectionActive = pathname === "/leads" || pathname.startsWith("/leads/")
    const activeGroup = isConversationsActive
        ? "Conversations"
        : isReportsSectionActive
            ? "Reports"
            : isLeadsSectionActive
                ? "Leads"
                : isMoreSectionActive
                    ? "More"
                    : null
    const [expandedGroup, setExpandedGroup] = React.useState<string | null>(activeGroup)
    React.useEffect(() => {
        if (activeGroup) setExpandedGroup(activeGroup)
    }, [activeGroup])

    // Build sidebar items with dynamic badges
    const sidebarItems = React.useMemo(() => {
        const items = getSidebarItemsForRole(role)
        return items.map(item => {
            if (!item.children && item.href === "/appointments" && badgeCounts.appointments > 0) {
                return { ...item, badge: badgeCounts.appointments }
            }
            if (!item.children && item.href === "/follow-ups" && badgeCounts.followUps > 0) {
                return { ...item, badge: badgeCounts.followUps }
            }
            if (!item.children && item.href === "/notifications" && badgeCounts.notifications > 0) {
                return { ...item, badge: badgeCounts.notifications }
            }
            if (item.children) {
                const updatedChildren = item.children.map(child => {
                    if (child.href === "/sms" && badgeCounts.smsUnread > 0) {
                        return { ...child, badge: badgeCounts.smsUnread }
                    }
                    if (child.href === "/whatsapp" && badgeCounts.whatsappUnread > 0) {
                        return { ...child, badge: badgeCounts.whatsappUnread }
                    }
                    if (child.href === "/leads?filter=unassigned" && badgeCounts.unassigned > 0) {
                        return { ...child, badge: badgeCounts.unassigned }
                    }
                    if (child.href === "/leads?filter=manager_review" && badgeCounts.managerReview > 0) {
                        return { ...child, badge: badgeCounts.managerReview }
                    }
                    return child
                })
                const totalChildBadge = updatedChildren.reduce((sum, child) => sum + (Number(child.badge) || 0), 0)
                const isExpanded = expandedGroup === item.name
                return {
                    ...item,
                    children: updatedChildren,
                    badge: (!isExpanded && totalChildBadge > 0) ? totalChildBadge : undefined,
                }
            }
            return item
        })
    }, [role, badgeCounts, expandedGroup])

    const handleLogout = () => {
        logout()
        window.location.href = "/login"
    }
    
    // Keyboard shortcut for search (Cmd+K / Ctrl+K)
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault()
                setShowSearch(true)
            }
        }
        
        document.addEventListener("keydown", handleKeyDown)
        return () => document.removeEventListener("keydown", handleKeyDown)
    }, [])

    return (
        <>
        {/* Mobile drawer backdrop */}
        {mobileOpen && (
            <div
                className="fixed inset-0 z-40 bg-black/50 md:hidden"
                onClick={() => sidebarContext?.setMobileOpen(false)}
                aria-hidden="true"
            />
        )}
        <aside
            className={cn(
                "fixed left-0 top-0 z-50 flex h-screen w-72 flex-col border-r bg-background transition-transform duration-200 md:z-40 md:transition-[width]",
                collapsed ? "md:w-16" : "md:w-64",
                mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
            )}
        >
            <div className="flex h-full min-h-0 flex-col px-2 py-4">
                {/* Logo - click navigates to dashboard */}
                <Link
                    href="/dashboard"
                    prefetch={false}
                    className={cn(
                        "shrink-0 flex items-center hover:opacity-90 transition-opacity",
                        collapsed ? "mb-6 justify-center px-0" : "mb-10 px-2"
                    )}
                >
                    <Image
                        src="/brand/app-icon-192.png"
                        alt="TikunCRM"
                        width={40}
                        height={40}
                        className="h-10 w-10 rounded-lg object-contain shrink-0"
                    />
                    {!collapsed && <span className="ml-3 text-xl font-bold tracking-tight truncate">TikunCRM</span>}
                </Link>

                {/* Search */}
                <button
                    onClick={() => setShowSearch(true)}
                    className={cn(
                        "relative shrink-0 flex items-center rounded-md border border-input bg-muted/50 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors",
                        collapsed ? "mb-6 w-10 justify-center px-0" : "mb-6 w-full gap-2 px-3"
                    )}
                    title="AI search (⌘K)"
                >
                    <Sparkles className="h-4 w-4 shrink-0 text-violet-500" />
                    {!collapsed && (
                        <>
                            <span className="flex-1 text-left">Ask Tikun…</span>
                            <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium">
                                <span className="text-xs">⌘</span>K
                            </kbd>
                        </>
                    )}
                </button>

                {/* Navigation - scrollable when many items */}
                <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain py-1">
                    {sidebarItems.map((item) => {
                        if (item.children) {
                            const isOpen = expandedGroup === item.name
                            const isChildActive = item.children.some((child) =>
                                isSidebarLinkActive(pathname, searchParams, child.href)
                            )
                            const sectionActive = isChildActive || (
                                item.name === "Leads" && (pathname === "/leads" || pathname.startsWith("/leads/"))
                            )
                            if (collapsed) {
                                const first = item.children[0]
                                return (
                                    <Link
                                        key={item.name}
                                        href={first.href}
                                        prefetch={false}
                                        title={item.name}
                                        className={cn(
                                            "relative flex items-center justify-center rounded-md py-2 text-sm font-medium transition-colors hover:bg-accent",
                                            sectionActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                                        )}
                                    >
                                        <item.icon className="h-4 w-4 shrink-0" />
                                        {item.badge && (
                                            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                                                {item.badge}
                                            </span>
                                        )}
                                    </Link>
                                )
                            }
                            return (
                                <div key={item.name} className="space-y-0.5">
                                    <button
                                        type="button"
                                        onClick={() => setExpandedGroup(isOpen ? null : item.name)}
                                        title={item.name}
                                        className={cn(
                                            "group relative flex w-full items-center rounded-md py-2 text-sm font-medium transition-colors hover:bg-accent",
                                            "justify-between px-3",
                                            sectionActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                                        )}
                                    >
                                        <div className="flex items-center min-w-0">
                                            <item.icon
                                                className={cn(
                                                    "h-4 w-4 shrink-0 mr-3",
                                                    sectionActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                                                )}
                                            />
                                            <span className="truncate">{item.name}</span>
                                        </div>
                                        <span className="flex items-center gap-2">
                                            {item.badge && (
                                                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                                                    {item.badge}
                                                </span>
                                            )}
                                            <ChevronDown
                                                className={cn("h-4 w-4 shrink-0 transition-transform", isOpen && "rotate-180")}
                                            />
                                        </span>
                                    </button>
                                    {isOpen && (
                                        <div className="ml-4 space-y-0.5 border-l border-border pl-2">
                                            {item.children.map((child) => {
                                                const active = isSidebarLinkActive(pathname, searchParams, child.href)
                                                return (
                                                    <Link
                                                        key={child.href}
                                                        href={child.href}
                                                        prefetch={false}
                                                        className={cn(
                                                            "flex items-center justify-between rounded-md py-1.5 pl-2 pr-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                                                            active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
                                                        )}
                                                    >
                                                        <div className="flex items-center min-w-0">
                                                            <child.icon className={cn("h-3.5 w-3.5 shrink-0 mr-2", active ? "text-primary" : "text-muted-foreground")} />
                                                            <span className="truncate">{child.name}</span>
                                                        </div>
                                                        {(child as any).badge > 0 && (
                                                            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-white">
                                                                {(child as any).badge}
                                                            </span>
                                                        )}
                                                    </Link>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>
                            )
                        }
                        const isActive = isSidebarLinkActive(pathname, searchParams, item.href!)
                        return (
                            <Link
                                key={item.href!}
                                href={item.href!}
                                prefetch={false}
                                title={collapsed ? item.name : undefined}
                                className={cn(
                                    "group relative flex items-center rounded-md py-2 text-sm font-medium transition-colors hover:bg-accent",
                                    collapsed ? "justify-center px-0" : "justify-between px-3",
                                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                                )}
                            >
                                <div className={cn("flex items-center min-w-0", collapsed && "justify-center")}>
                                    <item.icon
                                        className={cn(
                                            "h-4 w-4 shrink-0",
                                            !collapsed && "mr-3",
                                            isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                                        )}
                                    />
                                    {!collapsed && <span className="truncate">{item.name}</span>}
                                </div>
                                {!collapsed && (
                                    <div className="flex items-center gap-2 shrink-0">
                                        {item.badge && (
                                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                                                {item.badge}
                                            </span>
                                        )}
                                        {isActive && <ChevronRight className="h-4 w-4 text-primary" />}
                                    </div>
                                )}
                                {collapsed && item.badge && (
                                    <span className="absolute top-1/2 right-1 -translate-y-1/2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                                        {item.badge}
                                    </span>
                                )}
                            </Link>
                        )
                    })}
                </nav>

                {/* Footer: collapse, dealership scope, user */}
                <div className="mt-auto shrink-0 space-y-2 border-t pt-3">
                    {sidebarContext && (
                        <button
                            type="button"
                            onClick={sidebarContext.toggle}
                            className={cn(
                                "flex w-full items-center rounded-md border border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground",
                                collapsed && "justify-center px-2"
                            )}
                            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                        >
                            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4 shrink-0" />}
                            {!collapsed && <span className="ml-2 text-xs font-medium">Collapse sidebar</span>}
                        </button>
                    )}

                    <div className={cn("flex items-center rounded-md bg-muted/30 px-2 py-2", collapsed && "flex-col justify-center gap-2 px-1")}>
                        <UserAvatar user={user || undefined} size={collapsed ? "sm" : "md"} />
                        {!collapsed && (
                            <>
                                <div className="ml-3 min-w-0 flex-1 overflow-hidden">
                                    <p className="truncate text-sm font-medium text-foreground">
                                        {user?.first_name} {user?.last_name}
                                    </p>
                                    <Badge variant={getRoleVariant(role || "")} size="sm" className="mt-0.5">
                                        {role ? getRoleDisplayName(role) : "Unknown"}
                                    </Badge>
                                </div>
                                <button
                                    onClick={handleLogout}
                                    className="ml-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                    title="Logout"
                                >
                                    <LogOut className="h-4 w-4" />
                                </button>
                            </>
                        )}
                        {collapsed && (
                            <button
                                onClick={handleLogout}
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                title="Logout"
                            >
                                <LogOut className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <GlobalSearchModal open={showSearch} onOpenChange={setShowSearch} />
        </aside>
        </>
    )
}
