/**
 * Partner Store Service — CRUD for external dealer partners
 * where approved customers are connected to buy cars.
 */
import apiClient from "@/lib/api-client";

const PREFIX = "/partner-stores";

export interface PartnerStore {
    id: string;
    name: string;
    brand?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    postal_code?: string | null;
    phone?: string | null;
    email?: string | null;
    external_code?: string | null;
    monthly_leads_min?: number | null;
    monthly_leads_max?: number | null;
    website?: string | null;
    contact_person?: string | null;
    notes?: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    program_type?: "leads_only" | "full_bdc" | null;
    program_status?: string | null;
}

export interface PartnerStoreCreate {
    name: string;
    brand?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string;
    postal_code?: string | null;
    phone?: string | null;
    email?: string | null;
    external_code?: string | null;
    monthly_leads_min?: number | null;
    monthly_leads_max?: number | null;
    website?: string | null;
    contact_person?: string | null;
    notes?: string | null;
}

export interface PartnerStoreUpdate {
    name?: string;
    brand?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    postal_code?: string | null;
    phone?: string | null;
    email?: string | null;
    external_code?: string | null;
    monthly_leads_min?: number | null;
    monthly_leads_max?: number | null;
    website?: string | null;
    contact_person?: string | null;
    notes?: string | null;
    is_active?: boolean;
}

export interface InventoryUrlInput {
    url: string
    inventory_type: "new" | "used" | "cpo"
}

export interface InventorySourceInput {
    source_id?: string | null
    source_name: string
    inventory_urls: InventoryUrlInput[]
    platforms: string[]
    enabled: boolean
}

export interface LeadChannelInput {
    channel_type: "marketplace" | "website" | "other"
    platform?: string
    label: string
    enabled: boolean
}

export interface StoreProfile {
    opt_in: "leads_only" | "full_bdc"
    recipient_emails: string[]
    campaign_mapping_ids: string[]
    lead_channels: LeadChannelInput[]
    inventory_sources: InventorySourceInput[]
}

export interface StoreSendResult {
    partner_store_id: string
    partner_store_name: string
    delivery_id: string
    status: "sent" | "already_sent"
    program_type: string
    recipients: string[]
    emailed: string[]
    email_error?: string | null
}

export interface PartnerStoreDashboard {
    id: string
    name: string
    brand?: string | null
    email?: string | null
    phone?: string | null
    website?: string | null
    contact_person?: string | null
    address?: string | null
    city?: string | null
    state?: string | null
    postal_code?: string | null
    external_code?: string | null
    is_active: boolean
    opt_in?: "leads_only" | "full_bdc" | null
    monthly_leads_min?: number | null
    monthly_leads_max?: number | null
    sent_this_month: number
    range_position?: "below" | "in_range" | "above" | null
    recipient_emails: string[]
    campaigns: { campaign_mapping_id: string; label: string; type: string }[]
    lead_channels: LeadChannelInput[]
    inventory_sources: InventorySourceInput[]
    metrics: {
        total_sent: number
        sent_this_month: number
        sold: number
        by_status: { status: string; count: number }[]
        by_sender: { user_id?: string | null; name: string; count: number }[]
    }
    leads: {
        delivery_id: string
        lead_id: string
        customer_name: string
        phone?: string | null
        email?: string | null
        sent_at?: string | null
        sent_by?: string | null
        delivery_status: string
        lead_outcome?: string | null
        program_type: string
    }[]
}

export interface PartnerStoreBrief {
    id: string
    name: string
    brand?: string | null
}

export interface LeadPartnerDestinations {
    lead_id: string
    sent_to_partner_store_id?: string | null
    sent_to_partner_store?: PartnerStoreBrief | null
    sold_to_partner_store_id?: string | null
    sold_to_partner_store?: PartnerStoreBrief | null
}

export interface PartnerStoreListResponse {
    items: PartnerStore[];
    total: number;
}

export interface PartnerStoreListParams {
    brand?: string;
    active_only?: boolean;
    search?: string;
}

/** In-memory cache for the common active-only list (avoids N duplicate requests). */
let activeStoresCache: PartnerStoreListResponse | null = null
let activeStoresPromise: Promise<PartnerStoreListResponse> | null = null

function invalidateActiveStoresCache() {
    activeStoresCache = null
    activeStoresPromise = null
}

export const PartnerStoreService = {
    async list(params: PartnerStoreListParams = {}): Promise<PartnerStoreListResponse> {
        const isDefaultActive =
            params.active_only === true &&
            !params.brand &&
            !params.search
        if (isDefaultActive) {
            if (activeStoresCache) return activeStoresCache
            if (!activeStoresPromise) {
                activeStoresPromise = apiClient
                    .get(`${PREFIX}/`, { params })
                    .then((response) => {
                        activeStoresCache = response.data
                        return activeStoresCache!
                    })
                    .catch((err) => {
                        activeStoresPromise = null
                        throw err
                    })
            }
            return activeStoresPromise
        }
        const response = await apiClient.get(`${PREFIX}/`, { params });
        return response.data;
    },

    async getBrands(): Promise<string[]> {
        const response = await apiClient.get<string[]>(`${PREFIX}/brands`);
        return response.data;
    },

    async getById(id: string): Promise<PartnerStore> {
        const response = await apiClient.get(`${PREFIX}/${id}`);
        return response.data;
    },

    async create(data: PartnerStoreCreate): Promise<PartnerStore> {
        invalidateActiveStoresCache()
        const response = await apiClient.post(`${PREFIX}/`, data);
        return response.data;
    },

    async update(id: string, data: PartnerStoreUpdate): Promise<PartnerStore> {
        invalidateActiveStoresCache()
        const response = await apiClient.put(`${PREFIX}/${id}`, data);
        return response.data;
    },

    async delete(id: string): Promise<void> {
        invalidateActiveStoresCache()
        await apiClient.delete(`${PREFIX}/${id}`);
    },

    async connectLeadToPartner(
        leadId: string,
        partnerStoreId: string,
        notes?: string,
    ): Promise<unknown> {
        const response = await apiClient.post(`/leads/${leadId}/connect-partner`, {
            partner_store_id: partnerStoreId,
            notes,
        });
        return response.data;
    },

    async disconnectLeadFromPartner(leadId: string): Promise<unknown> {
        const response = await apiClient.delete(`/leads/${leadId}/connect-partner`);
        return response.data;
    },

    async getProfile(id: string): Promise<StoreProfile> {
        const response = await apiClient.get(`${PREFIX}/${id}/profile`)
        return response.data
    },

    async saveProfile(id: string, data: StoreProfile): Promise<StoreProfile> {
        const response = await apiClient.put(`${PREFIX}/${id}/profile`, data)
        return response.data
    },

    async dashboard(id: string): Promise<PartnerStoreDashboard> {
        const response = await apiClient.get(`${PREFIX}/${id}/dashboard`)
        return response.data
    },

    async sendLead(leadId: string, partnerStoreIds: string[]): Promise<{ lead_id: string; results: StoreSendResult[] }> {
        const response = await apiClient.post(`/leads/${leadId}/send-to-partner-stores`, {
            partner_store_ids: partnerStoreIds,
        })
        return response.data
    },

    async setLeadPartnerDestinations(
        leadId: string,
        data: {
            sent_to_partner_store_id?: string | null
            sold_to_partner_store_id?: string | null
        },
    ): Promise<LeadPartnerDestinations> {
        const response = await apiClient.patch(`/leads/${leadId}/partner-destinations`, data)
        return response.data
    },
}
