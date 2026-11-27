/**
 * SMS Service - API client for SMS messaging
 */
import apiClient from "@/lib/api-client";

export interface SMSConfig {
  sms_enabled: boolean;
  phone_number: string | null;
  promo_enabled?: boolean;
  auto_first_message_enabled?: boolean;
}

export type SMSCategory = "conversation" | "auto_first" | "promotional" | "compliance" | string;

export interface SMSConsentStatus {
  inquiry_consent: boolean | null;
  promo_consent: boolean | null;
  source: string | null;
  consent_at: string | null;
  opted_out: boolean;
  opted_out_at: string | null;
  can_text: boolean;
  block_reason: string | null;
}

export interface SMSLeadSearchItem {
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
}

export interface SMSCampaignFilters {
  stage_ids?: string[];
  campaigns?: string[];
  sources?: string[];
  date_from?: string | null;
  date_to?: string | null;
  has_stips?: boolean | null;
  assigned_to?: string | null;
  min_down_payment?: number | null;
  only_active?: boolean;
  exclude_contacted_in_days?: number | null;
  search?: string | null;
}

export interface SMSCampaignFilterOptions {
  stages: { id: string; name: string; color: string | null }[];
  campaigns: { name: string; count: number }[];
  sources: { value: string; count: number }[];
  agents: { id: string; name: string }[];
}

export interface SMSCampaignSampleLead {
  lead_id: string;
  customer_id: string;
  name: string;
  phone: string | null;
  stage_name: string | null;
  stage_color: string | null;
  campaign: string | null;
  source: string;
  interested_in: string | null;
  down_payment: number | null;
  has_stips: boolean;
  created_at: string | null;
}

export interface SMSCampaignAudiencePreview {
  total: number;
  sample_leads: SMSCampaignSampleLead[];
}

export interface SMSCampaign {
  id: string;
  name: string | null;
  body: string;
  media_urls: string[];
  filters: SMSCampaignFilters;
  status: "draft" | "queued" | "sending" | "completed" | "cancelled";
  scheduled_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  delivered_count?: number;
  undelivered_count?: number;
  pending_count?: number;
  created_at: string;
  completed_at: string | null;
  created_by_name: string | null;
}

export interface SMSCampaignPayload {
  name?: string | null;
  body: string;
  media_urls?: string[];
  filters?: SMSCampaignFilters;
  save_as_draft?: boolean;
  scheduled_at?: string | null;
}

export interface SMSCampaignOverview {
  promo_enabled: boolean;
  audience: number;
  in_send_window: boolean;
  send_window: string;
  timezone: string;
}

export interface SMSCampaignPreview {
  final_body: string;
  sample: string;
  segments: number;
  characters: number;
  blocked_links: string[];
  audience: number;
  is_mms: boolean;
}

export interface SendSMSRequest {
  to_number: string;
  body: string;
  lead_id?: string;
}

export interface SendSMSResponse {
  success: boolean;
  message_id?: string;
  error?: string;
}

export interface SMSMessage {
  id: string;
  lead_id: string | null;
  user_id: string | null;
  sender_name?: string | null;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  body: string;
  status: string;
  is_read: boolean;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  category?: SMSCategory | null;
  error_message?: string | null;
  media_urls?: string[];
  media_content_types?: string[];
  reactions?: Record<string, string[]>;
}

export interface SMSCallLog {
  id: string;
  direction: "inbound" | "outbound" | string;
  from_number: string;
  to_number: string;
  status: string;
  duration_seconds: number;
  recording_url: string | null;
  recording_duration_seconds: number | null;
  notes: string | null;
  outcome: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

export interface UploadSMSMediaResponse {
  url: string;
  content_type: string;
  filename: string;
}

export interface Conversation {
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
  messages: SMSMessage[];
  calls?: SMSCallLog[];
  consent?: SMSConsentStatus | null;
}

export interface ConversationListItem {
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
  last_message: {
    id: string;
    body: string;
    direction: string;
    created_at: string;
    status: string;
    category?: string | null;
    media_urls?: string[];
    media_content_types?: string[];
  };
  unread_count: number;
}

export type SMSListView = "all" | "unread" | "automatic" | "campaigns";

export interface SMSListCounts {
  all: number;
  unread: number;
  automatic: number;
  campaigns: number;
}

export interface SMSDeliveryCounts {
  delivered: number;
  sent: number;
  undelivered: number;
  failed: number;
}

export interface ConversationsListResponse {
  items: ConversationListItem[];
  total_unread: number;
  counts?: SMSListCounts;
  delivery?: SMSDeliveryCounts;
}

class SMSService {
  /**
   * Get SMS configuration status
   */
  async getConfig(): Promise<SMSConfig> {
    const response = await apiClient.get<SMSConfig>("/sms/config");
    return response.data;
  }

  /**
   * Send an SMS message
   */
  async sendSMS(request: SendSMSRequest): Promise<SendSMSResponse> {
    const response = await apiClient.post<SendSMSResponse>("/sms/send", request);
    return response.data;
  }

  /**
   * List SMS conversations
   */
  async listConversations(params?: {
    unread_only?: boolean;
    view?: SMSListView;
    limit?: number;
    offset?: number;
  }): Promise<ConversationsListResponse> {
    const response = await apiClient.get<ConversationsListResponse>("/sms/conversations", { params });
    return response.data;
  }

  /**
   * Get conversation with a lead
   */
  async getConversation(leadId: string, params?: {
    limit?: number;
    before?: string;
  }): Promise<Conversation> {
    const response = await apiClient.get<Conversation>(`/sms/conversations/${leadId}`, { params });
    return response.data;
  }

  /**
   * Send SMS or MMS to a specific lead
   */
  async sendToLead(
    leadId: string,
    body: string,
    mediaUrls?: string[],
    mediaContentTypes?: string[]
  ): Promise<SendSMSResponse> {
    const response = await apiClient.post<SendSMSResponse>(
      `/sms/conversations/${leadId}/send`,
      {
        body,
        to_number: "",
        media_urls: mediaUrls || [],
        media_content_types: mediaContentTypes || [],
      }
    );
    return response.data;
  }

  /**
   * Upload an image, video, or PDF for MMS (max 5MB)
   */
  async uploadMedia(file: File): Promise<UploadSMSMediaResponse> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await apiClient.post<UploadSMSMediaResponse>("/sms/upload-media", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return response.data;
  }

  /**
   * Toggle an emoji reaction on an SMS message
   */
  async toggleReaction(
    messageId: string,
    emoji: string
  ): Promise<{ message_id: string; reactions: Record<string, string[]> }> {
    const response = await apiClient.post<{ message_id: string; reactions: Record<string, string[]> }>(
      `/sms/messages/${messageId}/react`,
      { emoji }
    );
    return response.data;
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string): Promise<void> {
    await apiClient.patch(`/sms/messages/${messageId}/read`);
  }

  /**
   * Find leads by name or phone to start a new text
   */
  async searchLeads(q: string, limit = 20): Promise<SMSLeadSearchItem[]> {
    if (q.trim().length < 2) return [];
    const response = await apiClient.get<SMSLeadSearchItem[]>("/sms/leads/search", {
      params: { q: q.trim(), limit },
    });
    return response.data;
  }

  /**
   * Stop all texts to this lead's customer
   */
  async markOptedOut(leadId: string): Promise<SMSConsentStatus> {
    const response = await apiClient.post<SMSConsentStatus>(`/sms/conversations/${leadId}/opt-out`);
    return response.data;
  }

  async getCampaignOverview(): Promise<SMSCampaignOverview> {
    const response = await apiClient.get<SMSCampaignOverview>("/sms/campaigns/overview");
    return response.data;
  }

  async getCampaignFilterOptions(): Promise<SMSCampaignFilterOptions> {
    const response = await apiClient.get<SMSCampaignFilterOptions>("/sms/campaigns/filter-options");
    return response.data;
  }

  async previewCampaignAudience(
    filters: SMSCampaignFilters,
    limit = 25
  ): Promise<SMSCampaignAudiencePreview> {
    const response = await apiClient.post<SMSCampaignAudiencePreview>("/sms/campaigns/audience-preview", {
      filters,
      limit,
    });
    return response.data;
  }

  async previewCampaign(payload: SMSCampaignPayload): Promise<SMSCampaignPreview> {
    const response = await apiClient.post<SMSCampaignPreview>("/sms/campaigns/preview", payload);
    return response.data;
  }

  async testSendCampaign(payload: {
    to_number: string;
    body: string;
    media_urls?: string[];
    sample_first_name?: string;
  }): Promise<{ success: boolean; message_sid?: string }> {
    const response = await apiClient.post("/sms/campaigns/test-send", payload);
    return response.data;
  }

  async createCampaign(payload: SMSCampaignPayload): Promise<SMSCampaign> {
    const response = await apiClient.post<SMSCampaign>("/sms/campaigns", payload);
    return response.data;
  }

  async updateDraftCampaign(id: string, payload: SMSCampaignPayload): Promise<SMSCampaign> {
    const response = await apiClient.patch<SMSCampaign>(`/sms/campaigns/${id}`, payload);
    return response.data;
  }

  async launchCampaign(id: string): Promise<SMSCampaign> {
    const response = await apiClient.post<SMSCampaign>(`/sms/campaigns/${id}/launch`);
    return response.data;
  }

  async deleteCampaign(id: string): Promise<void> {
    await apiClient.delete(`/sms/campaigns/${id}`);
  }

  async listCampaigns(): Promise<SMSCampaign[]> {
    const response = await apiClient.get<SMSCampaign[]>("/sms/campaigns");
    return response.data;
  }

  async cancelCampaign(id: string): Promise<SMSCampaign> {
    const response = await apiClient.post<SMSCampaign>(`/sms/campaigns/${id}/cancel`);
    return response.data;
  }

  /**
   * Get unread count
   */
  async getUnreadCount(): Promise<number> {
    const response = await apiClient.get<{ count: number }>("/sms/unread-count");
    return response.data.count;
  }
}

export const smsService = new SMSService();
export default smsService;
