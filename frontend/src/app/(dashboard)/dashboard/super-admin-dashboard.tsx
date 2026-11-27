"use client"

import * as React from "react"
import Link from "next/link"
import {
    TrendingUp,
    Users,
    Inbox,
    ArrowUpRight,
    Loader2,
    InboxIcon,
    CalendarClock,
    Timer,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, MetricCard } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
    DashboardService, 
    SuperAdminStats, 
    LeadsBySource 
} from "@/services/dashboard-service"
import { AppointmentService, Appointment, getAppointmentStatusLabel } from "@/services/appointment-service"
import { useBrowserTimezone } from "@/hooks/use-browser-timezone"
import { formatDateInTimezone } from "@/utils/timezone"
import { DonutChart } from "@tremor/react"
import { useStatsRefresh } from "@/hooks/use-websocket"
import { TimeTrackingService } from "@/services/time-tracking-service"
import { formatMoney } from "@/lib/time-tracking"

export function SuperAdminDashboard() {
    const [stats, setStats] = React.useState<SuperAdminStats | null>(null)
    const [leadsBySource, setLeadsBySource] = React.useState<LeadsBySource[]>([])
    const [todayAppointments, setTodayAppointments] = React.useState<Appointment[]>([])
    const [isLoading, setIsLoading] = React.useState(true)
    const [bdcClockedIn, setBdcClockedIn] = React.useState<number | null>(null)
    const [bdcWeekPay, setBdcWeekPay] = React.useState<number | null>(null)
    const { timezone } = useBrowserTimezone()

    const fetchStats = React.useCallback(async () => {
        try {
            const [statsData, sourceData] = await Promise.all([
                DashboardService.getSuperAdminStats(),
                DashboardService.getLeadsBySource(),
            ])
            setStats(statsData)
            setLeadsBySource(sourceData)
        } catch (error) {
            console.error("Failed to fetch dashboard stats:", error)
        }
    }, [])

    // Listen for real-time stats refresh via WebSocket
    useStatsRefresh(React.useCallback(() => {
        fetchStats()
    }, [fetchStats]))

    React.useEffect(() => {
        const fetchData = async () => {
            try {
                const [statsData, sourceData, appointmentsData] = await Promise.all([
                    DashboardService.getSuperAdminStats(),
                    DashboardService.getLeadsBySource(),
                    AppointmentService.list({ today_only: true, page_size: 10 }).catch(() => ({ items: [] }))
                ])
                setStats(statsData)
                setLeadsBySource(sourceData)
                setTodayAppointments(appointmentsData.items || [])
            } catch (error) {
                console.error("Failed to fetch dashboard stats:", error)
            } finally {
                setIsLoading(false)
            }
        }
        fetchData()
        TimeTrackingService.getRoster()
            .then((roster) => {
                setBdcClockedIn(roster.clocked_in_count)
                setBdcWeekPay(Number(roster.team_week.estimated_pay) || 0)
            })
            .catch(() => {
                setBdcClockedIn(null)
                setBdcWeekPay(null)
            })
    }, [])

    const statCards = stats ? [
        {
            name: "Total Leads",
            value: stats.total_leads.toLocaleString(),
            change: stats.leads_change,
            trend: stats.leads_change.startsWith("+") ? "up" : "down",
            icon: Inbox,
            color: "blue" as const,
            href: "/leads"
        },
        {
            name: "Unassigned Leads",
            value: stats.unassigned_leads.toLocaleString(),
            trend: "neutral",
            icon: InboxIcon,
            color: "amber" as const,
            href: "/leads/unassigned"
        },
        {
            name: "Conversion Rate",
            value: stats.conversion_rate,
            change: stats.conversion_change,
            trend: stats.conversion_change.startsWith("+") ? "up" : "down",
            icon: TrendingUp,
            color: "emerald" as const,
            href: "/leads?filter=converted"
        },
        {
            name: "Team",
            value: stats.total_salesforce.toLocaleString(),
            trend: "neutral",
            icon: Users,
            color: "blue" as const,
            href: "/team"
        },
    ] : []

    // Format source data for chart
    const sourceChartData = leadsBySource.map(item => ({
        name: item.source.replace('_', ' ').toUpperCase(),
        value: item.count
    }))

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex items-end justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">System Overview</h1>
                    <p className="text-muted-foreground">Monitor performance across Carvaminos.</p>
                </div>
                <div className="flex gap-2">
                    <Link href="/leads/unassigned">
                        <Button variant="outline" leftIcon={<InboxIcon className="h-4 w-4" />}>
                            Unassigned Pool
                            {stats && stats.unassigned_leads > 0 && (
                                <Badge variant="new" className="ml-2">
                                    {stats.unassigned_leads}
                                </Badge>
                            )}
                        </Button>
                    </Link>
                </div>
            </div>

            {bdcClockedIn != null && (
                <Link href="/time-tracking">
                    <Card className="border-emerald-200 transition-colors hover:bg-emerald-50/80 dark:border-emerald-900 dark:hover:bg-emerald-950/40">
                        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                            <div className="flex items-center gap-3">
                                <div className="rounded-full bg-emerald-100 p-2 dark:bg-emerald-900">
                                    <Timer className="h-5 w-5 text-emerald-600" />
                                </div>
                                <div>
                                    <p className="font-medium">
                                        {bdcClockedIn} BDC agent{bdcClockedIn === 1 ? "" : "s"} on the clock
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                        Estimated team week pay {formatMoney(bdcWeekPay ?? 0)} · Open Time &amp; Pay
                                    </p>
                                </div>
                            </div>
                            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                        </CardContent>
                    </Card>
                </Link>
            )}

            {/* Today's Appointments Widget */}
            {todayAppointments.length > 0 && (
                <Card className="border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950">
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <div className="flex items-center gap-2">
                            <div className="rounded-full bg-emerald-100 p-2 dark:bg-emerald-900">
                                <CalendarClock className="h-5 w-5 text-emerald-600" />
                            </div>
                            <div>
                                <CardTitle className="text-base font-semibold text-emerald-700 dark:text-emerald-300">
                                    Today's Appointments ({todayAppointments.length})
                                </CardTitle>
                            </div>
                        </div>
                        <Link href="/appointments?filter=today">
                            <Button variant="outline" size="sm" className="border-emerald-300 text-emerald-700">
                                View All
                            </Button>
                        </Link>
                    </CardHeader>
                    <CardContent>
                        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                            {todayAppointments.slice(0, 4).map((apt) => (
                                <div 
                                    key={apt.id} 
                                    className="flex items-center gap-3 bg-white dark:bg-emerald-900/50 rounded-lg p-3"
                                >
                                    <div className="text-center min-w-[50px]">
                                        <p className="text-sm font-bold text-emerald-600">
                                            {formatDateInTimezone(apt.scheduled_at, timezone, { timeStyle: "short" })}
                                        </p>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium text-sm truncate">{apt.title}</p>
                                        {apt.lead && (
                                            <p className="text-xs text-muted-foreground truncate">
                                                {apt.lead.customer?.full_name || `${apt.lead.customer?.first_name || ""} ${apt.lead.customer?.last_name || ""}`.trim() || "Unknown"}
                                            </p>
                                        )}
                                    </div>
                                    <Badge variant={
                                        apt.status === "completed" ? "converted" :
                                        apt.status === "cancelled" ? "destructive" :
                                        "outline"
                                    } className="shrink-0">
                                        {getAppointmentStatusLabel(apt.status)}
                                    </Badge>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Stats Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {isLoading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                        <Card key={i} className="h-32 animate-pulse">
                            <CardContent className="flex h-full items-center justify-center">
                                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground opacity-20" />
                            </CardContent>
                        </Card>
                    ))
                ) : (
                    statCards.map((stat) => (
                        <MetricCard
                            key={stat.name}
                            title={stat.name}
                            metric={stat.value}
                            icon={<stat.icon className="h-5 w-5" />}
                            trend={stat.change ? {
                                value: stat.change,
                                isPositive: stat.trend === "up"
                            } : undefined}
                            color={stat.color}
                            href={stat.href}
                        />
                    ))
                )}
            </div>

            {/* Charts Row */}
            <div className="grid gap-6">
                {/* Lead Sources Chart */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base font-semibold">Lead Sources</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {isLoading ? (
                            <div className="flex h-48 items-center justify-center">
                                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : (
                            <DonutChart
                                data={sourceChartData}
                                category="value"
                                index="name"
                                colors={["emerald", "blue", "gray", "indigo", "amber", "teal"]}
                                className="h-48"
                                showLabel
                                valueFormatter={(value) => value.toLocaleString()}
                            />
                        )}
                    </CardContent>
                </Card>

            </div>
        </div>
    )
}
