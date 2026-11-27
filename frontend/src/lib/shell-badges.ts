import { wsService } from "@/lib/websocket"

export type ShellBadges = {
    appointments: number
    followUps: number
    unassigned: number
    managerReview: number
    notifications: number
    whatsappUnread: number
    smsUnread: number
    freshLeads: number
    missedCalls: number
}

const empty: ShellBadges = {
    appointments: 0,
    followUps: 0,
    unassigned: 0,
    managerReview: 0,
    notifications: 0,
    whatsappUnread: 0,
    smsUnread: 0,
    freshLeads: 0,
    missedCalls: 0,
}

let state: ShellBadges = { ...empty }
const listeners = new Set<(badges: ShellBadges) => void>()
let bound = false

function emit() {
    const snapshot = state
    listeners.forEach((listener) => listener(snapshot))
}

function patch(partial: Partial<ShellBadges>) {
    state = { ...state, ...partial }
    emit()
}

function asRecord(data: unknown): Record<string, unknown> {
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {}
}

function num(value: unknown): number | null {
    return typeof value === "number" ? value : null
}

function bindSocket() {
    if (bound) return
    bound = true

    wsService.on("shell:badges", (data: unknown) => {
        const row = asRecord(data)
        patch({
            appointments: num(row.appointments) ?? state.appointments,
            followUps: num(row.follow_ups) ?? state.followUps,
            unassigned: num(row.unassigned) ?? state.unassigned,
            managerReview: num(row.manager_review) ?? state.managerReview,
            notifications: num(row.notifications) ?? state.notifications,
            whatsappUnread: num(row.whatsapp_unread) ?? state.whatsappUnread,
            smsUnread: num(row.sms_unread) ?? state.smsUnread,
            freshLeads: num(row.fresh_leads) ?? state.freshLeads,
            missedCalls: num(row.missed_calls) ?? state.missedCalls,
        })
    })

    wsService.on("sms:unread", (data: unknown) => {
        const count = num(asRecord(data).count)
        if (count !== null) patch({ smsUnread: count })
    })

    const onNotification = (data: unknown) => {
        const count = num(asRecord(data).unread_count)
        if (count !== null) patch({ notifications: count })
    }
    wsService.on("notification:new", onNotification)
    wsService.on("notification:read", onNotification)

    const onWhatsApp = (data: unknown) => {
        const count = num(asRecord(data).total_unread)
        if (count !== null) patch({ whatsappUnread: count })
    }
    wsService.on("whatsapp:received", onWhatsApp)
    wsService.on("whatsapp:read", onWhatsApp)
}

export function subscribeShellBadges(listener: (badges: ShellBadges) => void): () => void {
    bindSocket()
    listeners.add(listener)
    listener(state)
    return () => {
        listeners.delete(listener)
    }
}
