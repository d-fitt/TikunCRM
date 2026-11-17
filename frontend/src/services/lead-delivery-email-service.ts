import apiClient from "@/lib/api-client"

export interface LeadDeliveryMailbox {
    smtp_host: string
    smtp_port: number
    smtp_user: string
    from_name: string
    use_tls: boolean
    use_ssl: boolean
    has_password: boolean
    active_email: string
    source: "portal" | "server" | "none" | string
}

export const LeadDeliveryEmailService = {
    async get(): Promise<LeadDeliveryMailbox> {
        const response = await apiClient.get<LeadDeliveryMailbox>("/admin/lead-delivery-email")
        return response.data
    },
    async save(body: {
        smtp_user: string
        password?: string
        from_name: string
        provider: "microsoft365" | "outlook"
    }): Promise<LeadDeliveryMailbox> {
        const response = await apiClient.put<LeadDeliveryMailbox>("/admin/lead-delivery-email", body)
        return response.data
    },
    async test(toEmail: string): Promise<{ sent: boolean; to_email: string }> {
        const response = await apiClient.post("/admin/lead-delivery-email/test", { to_email: toEmail })
        return response.data
    },
}
