/**
 * Call Review Service — AI call feedback and the scoring rubric.
 */
import apiClient from "@/lib/api-client";

const PREFIX = "/call-reviews";

export type CallReviewStatus =
    | "pending"
    | "transcribing"
    | "evaluating"
    | "completed"
    | "failed"
    | "skipped";

export type AiCallOutcome =
    | "appointment_booked"
    | "follow_up_required"
    | "no_appointment"
    | "not_a_sales_conversation";

export interface RubricCriterion {
    key?: string;
    name: string;
    weight: number;
    what_good_looks_like: string;
    what_bad_looks_like: string;
}

export interface Rubric {
    id: string;
    version: number | null;
    status: "draft" | "active" | "archived";
    name: string;
    criteria: RubricCriterion[];
    guidance: string | null;
    change_note: string | null;
    published_at: string | null;
    updated_at: string | null;
    calls_scored?: number;
}

export interface RubricState {
    active: Rubric | null;
    draft: Rubric | null;
    can_edit: boolean;
}

export interface RubricDraftInput {
    name: string;
    criteria: RubricCriterion[];
    guidance: string | null;
    change_note?: string | null;
}

export interface Evidence {
    quote: string;
    timestamp_seconds: number | null;
    speaker: string | null;
}

export interface CategoryScore {
    key: string;
    name: string;
    weight: number;
    not_applicable: boolean;
    score: number | null;
    rationale: string;
    evidence: Evidence[];
}

export interface Observation {
    text: string;
    evidence: Evidence[];
}

export interface Objection {
    objection: string;
    how_rep_responded: string;
    resolved: boolean;
    evidence: Evidence[];
}

export interface CallEvaluation {
    id: string;
    overall_score: number | null;
    category_scores: CategoryScore[];
    ai_call_outcome: AiCallOutcome | null;
    rubric_version: number | null;
    llm_model: string;
    prompt_version: string;
    created_at: string | null;
    summary: string;
    strengths: Observation[];
    improvements: Observation[];
    missed_appointment_opportunities: Observation[];
    customer_objections: Objection[];
    coaching_suggestions: Observation[];
}

export interface TranscriptLine {
    speaker: string;
    start: number;
    end: number;
    text: string;
}

export interface CallSummary {
    id: string;
    direction: "inbound" | "outbound" | null;
    started_at: string | null;
    duration_seconds: number;
    has_recording: boolean;
}

export interface CallReviewListItem {
    id: string;
    status: CallReviewStatus;
    skip_reason: string | null;
    error: string | null;
    call: CallSummary | null;
    lead_id: string | null;
    customer_name: string | null;
    rep: { id: string; name: string } | null;
    overall_score: number | null;
    ai_call_outcome: AiCallOutcome | null;
    rubric_version: number | null;
    has_transcript: boolean;
}

export interface CallReviewListResponse {
    items: CallReviewListItem[];
    total: number;
    page: number;
    page_size: number;
    auto_review_enabled: boolean;
    can_manage: boolean;
}

export interface UnreviewedCall {
    call: CallSummary;
    lead_id: string | null;
    customer_name: string | null;
    rep: { id: string; name: string } | null;
}

export interface CrmOutcome {
    /** null = unknown (call is not linked to a lead) */
    appointment_booked: boolean | null;
    appointment: { id: string; scheduled_at: string | null; status: string } | null;
    rep_logged_outcome: string | null;
}

export interface CallReviewDetail {
    id: string;
    status: CallReviewStatus;
    skip_reason: string | null;
    error: string | null;
    attempts: number;
    can_manage: boolean;
    call: CallSummary | null;
    lead_id: string | null;
    customer_name: string | null;
    rep: { id: string; name: string } | null;
    dealership: { id: string; name: string } | null;
    transcript: TranscriptLine[];
    transcript_provider: string | null;
    transcript_model: string | null;
    evaluation: CallEvaluation | null;
    evaluation_count: number;
    crm_outcome: CrmOutcome | null;
}

export interface RubricTestResult {
    review_id: string;
    call_started_at: string | null;
    current: { overall_score: number | null; rubric_version: number | null; category_scores: CategoryScore[] } | null;
    draft: { overall_score: number | null; category_scores: CategoryScore[]; summary: string } | null;
    error: string | null;
}

export const AI_OUTCOME_LABELS: Record<AiCallOutcome, string> = {
    appointment_booked: "Appointment agreed",
    follow_up_required: "Follow-up needed",
    no_appointment: "No appointment",
    not_a_sales_conversation: "Not a sales call",
};

export const SKIP_REASON_LABELS: Record<string, string> = {
    too_short: "Call too short to review",
    too_little_speech: "Not enough conversation to review",
    voicemail: "Voicemail",
    not_answered: "Call was not answered",
    not_completed: "Call did not complete",
    no_recording: "No recording",
    ai_outbound_call: "Automated AI call",
};

/** Extract a readable message from an API error. */
export function apiErrorMessage(err: unknown, fallback: string): string {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    return typeof detail === "string" && detail ? detail : fallback;
}

export const CallReviewService = {
    async list(params: { page?: number; page_size?: number; status?: string } = {}): Promise<CallReviewListResponse> {
        const response = await apiClient.get(PREFIX, { params });
        return response.data;
    },

    async get(id: string): Promise<CallReviewDetail> {
        const response = await apiClient.get(`${PREFIX}/${id}`);
        return response.data;
    },

    async listUnreviewedCalls(): Promise<UnreviewedCall[]> {
        const response = await apiClient.get(`${PREFIX}/unreviewed-calls`);
        return response.data.items;
    },

    async reviewCall(callLogId: string): Promise<{ review_id: string }> {
        const response = await apiClient.post(`${PREFIX}/calls/${callLogId}/review`);
        return response.data;
    },

    async rerun(reviewId: string): Promise<void> {
        await apiClient.post(`${PREFIX}/${reviewId}/rerun`);
    },

    async getRubric(): Promise<RubricState> {
        const response = await apiClient.get(`${PREFIX}/rubric`);
        return response.data;
    },

    async listRubricVersions(): Promise<Rubric[]> {
        const response = await apiClient.get(`${PREFIX}/rubric/versions`);
        return response.data;
    },

    async saveDraft(data: RubricDraftInput): Promise<Rubric> {
        const response = await apiClient.put(`${PREFIX}/rubric/draft`, data);
        return response.data;
    },

    async discardDraft(): Promise<void> {
        await apiClient.delete(`${PREFIX}/rubric/draft`);
    },

    async publishDraft(): Promise<Rubric> {
        const response = await apiClient.post(`${PREFIX}/rubric/draft/publish`);
        return response.data;
    },

    async testRubric(reviewIds: string[], data: RubricDraftInput): Promise<RubricTestResult[]> {
        // Each call takes the AI several seconds to score
        const response = await apiClient.post(
            `${PREFIX}/rubric/test`,
            { review_ids: reviewIds, criteria: data.criteria, guidance: data.guidance },
            { timeout: 180_000 }
        );
        return response.data.results;
    },
};
