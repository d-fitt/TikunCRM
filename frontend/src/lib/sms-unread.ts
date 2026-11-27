import { subscribeShellBadges } from "@/lib/shell-badges"

/** Header icon and sidebar text badge share the socket count. */
export function subscribeSmsUnread(listener: (count: number) => void): () => void {
    return subscribeShellBadges((badges) => listener(badges.smsUnread))
}
