import apiClient from "@/lib/api-client";

const DEALERSHIPS_PREFIX = "/dealerships";

export interface Dealership {
    id: string;
    name: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    postal_code?: string;
    phone?: string;
    email?: string;
    website?: string;
    config: Record<string, unknown>;
    working_hours: Record<string, unknown>;
    lead_assignment_rules: Record<string, unknown>;
    timezone: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    /** Optional aggregates when returned by list/detail endpoints */
    users_count?: number;
    leads_count?: number;
}

export interface UpdateDealershipData {
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    postal_code?: string;
    phone?: string;
    email?: string;
    website?: string;
    config?: Record<string, unknown>;
    working_hours?: Record<string, unknown>;
    lead_assignment_rules?: Record<string, unknown>;
    timezone?: string;
}

export const DealershipService = {
    // Get single dealership
    async getDealership(id: string): Promise<Dealership> {
        const response = await apiClient.get(`${DEALERSHIPS_PREFIX}/${id}`);
        return response.data;
    },

    // Update dealership
    async updateDealership(id: string, data: UpdateDealershipData): Promise<Dealership> {
        const response = await apiClient.put(`${DEALERSHIPS_PREFIX}/${id}`, data);
        return response.data;
    },

    // Partial update dealership
    async patchDealership(id: string, data: Partial<UpdateDealershipData>): Promise<Dealership> {
        const response = await apiClient.patch(`${DEALERSHIPS_PREFIX}/${id}`, data);
        return response.data;
    },

    async getTwilioConfig(dealershipId: string): Promise<DealershipTwilioConfig> {
        const response = await apiClient.get(`${DEALERSHIPS_PREFIX}/${dealershipId}/twilio-config`);
        return response.data;
    },

    async patchTwilioConfig(
        dealershipId: string,
        data: DealershipTwilioConfigUpdate
    ): Promise<DealershipTwilioConfig> {
        const response = await apiClient.patch(`${DEALERSHIPS_PREFIX}/${dealershipId}/twilio-config`, data);
        return response.data;
    },
};

export interface DealershipTwilioConfig {
    dealership_id: string;
    account_sid?: string | null;
    auth_token_set: boolean;
    /** Present after configuration unlock; decrypted server-side */
    auth_token?: string | null;
    sms_enabled: boolean;
    sms_from_number?: string | null;
    whatsapp_enabled: boolean;
    whatsapp_from_number?: string | null;
    voice_enabled: boolean;
    twilio_twiml_app_sid?: string | null;
    twilio_api_key_sid?: string | null;
    api_key_secret_set: boolean;
    /** Present after configuration unlock; decrypted server-side */
    twilio_api_key_secret?: string | null;
    voice_caller_id_number?: string | null;
    messaging_service_sid?: string | null;
    sms_auto_first_message_enabled: boolean;
    sms_promo_enabled: boolean;
}

export interface DealershipTwilioConfigUpdate {
    account_sid?: string | null;
    auth_token?: string | null;
    sms_enabled?: boolean;
    sms_from_number?: string | null;
    whatsapp_enabled?: boolean;
    whatsapp_from_number?: string | null;
    voice_enabled?: boolean;
    twilio_twiml_app_sid?: string | null;
    twilio_api_key_sid?: string | null;
    twilio_api_key_secret?: string | null;
    voice_caller_id_number?: string | null;
    messaging_service_sid?: string | null;
    sms_auto_first_message_enabled?: boolean;
    sms_promo_enabled?: boolean;
}
