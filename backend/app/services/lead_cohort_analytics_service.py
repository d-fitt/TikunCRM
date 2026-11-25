"""
Lead Cohort & BDC Productivity Analytics Service.

Computes:
1. Lead Cohort Analysis for leads arriving in a selected date/range:
   - End-to-end funnel with counts, % of total, and step-to-step %
   - Campaign performance matrix
   - Pipeline stage breakdown
   - Appointment & show-up outcome matrix
   - Partner store performance matrix
2. BDC Agent Productivity Matrix:
   - Supports two modes:
     - "activity": all work done by each BDC agent in the date range
       (leads worked, calls, connected calls, notes, appts set, arrived, no-show, sold)
     - "cohort": each BDC agent's work strictly on the leads that arrived in the date range
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from statistics import median
from typing import Any, Dict, List, Optional, Set
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityType
from app.models.appointment import Appointment, AppointmentStatus
from app.models.call_log import CallDirection, CallLog, CallStatus
from app.models.campaign_mapping import CampaignMapping
from app.models.campaign_mapping_version import CampaignMappingVersion
from app.models.customer_stip_document import CustomerStipDocument
from app.models.lead import Lead, LeadSource
from app.models.lead_stage import LeadStage
from app.models.lead_stip_document import LeadStipDocument
from app.models.partner_store import PartnerStore
from app.models.user import User, UserRole
from app.models.user_dealership_access import UserDealershipAccess

# Status groups for appointments
APPT_SET_STATUSES = {
    AppointmentStatus.SCHEDULED,
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.ARRIVED,
    AppointmentStatus.IN_SHOWROOM,
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.SOLD,
}

APPT_SHOWED_STATUSES = {
    AppointmentStatus.ARRIVED,
    AppointmentStatus.IN_SHOWROOM,
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.SOLD,
}

APPT_STATUS_LABELS: Dict[str, str] = {
    "scheduled": "Scheduled",
    "confirmed": "Confirmed",
    "arrived": "Arrived",
    "in_showroom": "In Showroom",
    "in_progress": "In Progress",
    "completed": "Completed",
    "sold": "Sold",
    "no_show": "No Show",
    "cancelled": "Cancelled",
    "rescheduled": "Rescheduled",
}

APPT_STATUS_ORDER = [
    "scheduled",
    "confirmed",
    "arrived",
    "in_showroom",
    "in_progress",
    "completed",
    "sold",
    "no_show",
    "cancelled",
    "rescheduled",
]

INTERESTED_STAGE_NAMES = {
    "interested",
    "in_showroom",
    "negotiation",
    "qualified",
    "converted",
}

LOST_STAGE_NAMES = {
    "lost",
    "not_interested",
    "couldnt_qualify",
}

WORK_ACTIVITY_TYPES = (
    ActivityType.NOTE_ADDED,
    ActivityType.CALL_LOGGED,
    ActivityType.EMAIL_SENT,
    ActivityType.SMS_SENT,
    ActivityType.WHATSAPP_SENT,
    ActivityType.APPOINTMENT_SCHEDULED,
    ActivityType.FOLLOW_UP_SCHEDULED,
)

SOURCE_LABELS: Dict[str, str] = {
    "google_sheets": "Google Sheets",
    "meta_ads": "Meta Ads",
    "manual": "Manual",
    "website": "Website",
    "referral": "Referral",
    "walk_in": "Walk-in",
    "whatsapp_inbound": "WhatsApp Inbound",
    "sms_inbound": "SMS Inbound",
}


def _pct(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round((numerator / denominator) * 100.0, 1)


def _status_str(val: Any) -> str:
    return val.value if hasattr(val, "value") else str(val)


class CohortFunnelStep(BaseModel):
    key: str
    label: str
    count: int
    pct_of_total: float
    pct_of_prev: Optional[float] = None


class CohortSummary(BaseModel):
    total_leads: int
    worked_leads: int
    worked_pct: float
    untouched_leads: int
    untouched_pct: float
    interested_leads: int
    interested_pct: float
    interested_of_worked_pct: float
    stips_leads: int
    stips_pct: float
    stips_of_interested_pct: float
    partner_sent_leads: int
    partner_sent_pct: float
    appointment_set_leads: int
    appointment_set_pct: float
    showed_up_leads: int
    showed_up_pct: float
    show_rate_pct: float
    no_show_leads: int
    no_show_pct: float
    converted_leads: int
    converted_pct: float
    close_rate_of_showed_pct: float
    lost_leads: int
    lost_pct: float
    active_leads: int
    active_pct: float
    median_speed_to_lead_minutes: Optional[float] = None
    avg_days_to_appointment: Optional[float] = None


class CampaignMatrixRow(BaseModel):
    campaign_name: str
    leads: int
    share_pct: float
    worked: int
    worked_pct: float
    interested: int
    interested_pct: float
    stips: int
    stips_pct: float
    partner_sent: int
    partner_sent_pct: float
    appt_set: int
    appt_set_pct: float
    showed_up: int
    show_rate_pct: float
    no_show: int
    no_show_pct: float
    converted: int
    converted_pct: float
    lost: int
    lost_pct: float


class StageMatrixRow(BaseModel):
    stage_id: str
    stage_name: str
    display_name: str
    color: Optional[str] = None
    is_terminal: bool
    count: int
    pct_of_total: float


class AppointmentStatusMatrixRow(BaseModel):
    status: str
    label: str
    count: int
    pct_of_appointments: float


class AppointmentsSummary(BaseModel):
    total_appointments: int
    active_outcome_denominator: int
    showed_up: int
    show_rate_pct: float
    no_show: int
    no_show_rate_pct: float
    cancelled: int
    cancel_rate_pct: float
    rescheduled: int
    by_status: List[AppointmentStatusMatrixRow]


class PartnerStoreMatrixRow(BaseModel):
    partner_store_id: Optional[str] = None
    partner_store_name: str
    leads_sent: int
    share_pct: float
    appt_set: int
    appt_set_pct: float
    showed_up: int
    show_rate_pct: float
    no_show: int
    no_show_pct: float
    cancelled: int
    sold: int
    close_rate_of_showed_pct: float
    sold_of_sent_pct: float


class BdcAgentProductivityRow(BaseModel):
    user_id: str
    user_name: str
    email: Optional[str] = None
    leads_worked: int
    calls_made: int
    connected_calls: int
    connect_rate_pct: float
    avg_call_duration_seconds: float
    notes_added: int
    touches_total: int
    avg_touches_per_lead: float
    median_speed_to_lead_minutes: Optional[float] = None
    stips_leads: int
    appts_scheduled: int
    appt_set_rate_pct: float
    appts_arrived: int
    show_rate_pct: float
    appts_no_show: int
    no_show_rate_pct: float
    appts_cancelled: int
    sold_leads: int
    sold_rate_pct: float


class LeadCohortAnalysisResponse(BaseModel):
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    dealership_id: Optional[str] = None
    bdc_mode: str = "activity"
    include_returning: bool = False
    available_campaigns: List[str] = []
    summary: CohortSummary
    funnel: List[CohortFunnelStep]
    campaigns: List[CampaignMatrixRow]
    stages: List[StageMatrixRow]
    appointments: AppointmentsSummary
    partner_stores: List[PartnerStoreMatrixRow]
    bdc_agents: List[BdcAgentProductivityRow]
    bdc_totals: BdcAgentProductivityRow


def _resolve_campaign_name(
    lead: Lead,
    version_names: Dict[UUID, str],
    mapping_names: Dict[UUID, str],
) -> str:
    if lead.campaign_version_id and lead.campaign_version_id in version_names:
        name = version_names[lead.campaign_version_id].strip()
        if name:
            return name
    if lead.campaign_mapping_id and lead.campaign_mapping_id in mapping_names:
        name = mapping_names[lead.campaign_mapping_id].strip()
        if name:
            return name
    raw = (lead.source_campaign_raw or "").strip()
    if raw:
        return raw
    meta = lead.meta_data or {}
    for key in ("campaign_display", "campaign_name", "campaign"):
        val = str(meta.get(key) or "").strip()
        if val:
            return val
    src = _status_str(lead.source) if lead.source else ""
    return SOURCE_LABELS.get(src, src.replace("_", " ").title() if src else "Unattributed")


async def _get_bdc_users(
    db: AsyncSession,
    dealership_id: Optional[UUID],
    bdc_agent_id: Optional[UUID] = None,
) -> List[User]:
    users_by_id: Dict[UUID, User] = {}

    if dealership_id:
        direct_res = await db.execute(
            select(User).where(
                User.role == UserRole.BDC,
                User.is_active == True,
                User.dealership_id == dealership_id,
            )
        )
        for u in direct_res.scalars().all():
            users_by_id[u.id] = u

        access_res = await db.execute(
            select(User)
            .join(UserDealershipAccess, UserDealershipAccess.user_id == User.id)
            .where(
                UserDealershipAccess.dealership_id == dealership_id,
                User.role == UserRole.BDC,
                User.is_active == True,
            )
        )
        for u in access_res.scalars().all():
            users_by_id[u.id] = u
    else:
        all_res = await db.execute(
            select(User).where(User.role == UserRole.BDC, User.is_active == True)
        )
        for u in all_res.scalars().all():
            users_by_id[u.id] = u

    if bdc_agent_id:
        if bdc_agent_id in users_by_id:
            return [users_by_id[bdc_agent_id]]
        one_res = await db.execute(select(User).where(User.id == bdc_agent_id))
        one = one_res.scalar_one_or_none()
        return [one] if one else []

    return sorted(
        users_by_id.values(),
        key=lambda u: f"{u.first_name or ''} {u.last_name or ''}".strip().lower(),
    )


async def build_lead_cohort_analysis(
    db: AsyncSession,
    *,
    dealership_id: Optional[UUID],
    date_from: Optional[datetime],
    date_to: Optional[datetime],
    assigned_to: Optional[UUID] = None,
    bdc_agent_id: Optional[UUID] = None,
    source: Optional[str] = None,
    stage_id: Optional[UUID] = None,
    partner_store_id: Optional[UUID] = None,
    campaign: Optional[str] = None,
    has_stip: Optional[str] = None,
    include_returning: bool = False,
    bdc_mode: str = "activity",
) -> LeadCohortAnalysisResponse:
    """Build the full lead cohort + BDC productivity report."""
    mode = "cohort" if bdc_mode == "cohort" else "activity"

    # 1. Build base lead query for the cohort
    lead_conds = []
    if dealership_id:
        lead_conds.append(Lead.dealership_id == dealership_id)
    if assigned_to:
        lead_conds.append(Lead.assigned_to == assigned_to)
    if source:
        try:
            lead_conds.append(Lead.source == LeadSource(source))
        except ValueError:
            pass
    if stage_id:
        lead_conds.append(Lead.stage_id == stage_id)
    if partner_store_id:
        lead_conds.append(
            or_(
                Lead.partner_store_id == partner_store_id,
                Lead.sold_partner_store_id == partner_store_id,
            )
        )

    if date_from is not None or date_to is not None:
        created_conds = []
        inbound_conds = []
        if date_from is not None:
            created_conds.append(Lead.created_at >= date_from)
            inbound_conds.append(Lead.last_inbound_at >= date_from)
        if date_to is not None:
            created_conds.append(Lead.created_at <= date_to)
            inbound_conds.append(Lead.last_inbound_at <= date_to)
        created_expr = and_(*created_conds)
        if include_returning:
            lead_conds.append(or_(created_expr, and_(Lead.last_inbound_at.isnot(None), *inbound_conds)))
        else:
            lead_conds.append(created_expr)

    leads_stmt = select(Lead)
    if lead_conds:
        leads_stmt = leads_stmt.where(and_(*lead_conds))
    all_period_leads: List[Lead] = list((await db.execute(leads_stmt)).scalars().all())

    # Resolve campaign names and track which campaign mappings are active
    version_ids = {l.campaign_version_id for l in all_period_leads if l.campaign_version_id}
    mapping_ids = {l.campaign_mapping_id for l in all_period_leads if l.campaign_mapping_id}
    version_names: Dict[UUID, str] = {}
    mapping_names: Dict[UUID, str] = {}
    active_mapping_ids: Set[UUID] = set()

    if version_ids:
        v_res = await db.execute(
            select(CampaignMappingVersion.id, CampaignMappingVersion.display_name).where(
                CampaignMappingVersion.id.in_(version_ids)
            )
        )
        version_names = {row[0]: row[1] for row in v_res.all()}
    if mapping_ids:
        m_res = await db.execute(
            select(
                CampaignMapping.id,
                CampaignMapping.display_name,
                CampaignMapping.is_active,
            ).where(CampaignMapping.id.in_(mapping_ids))
        )
        for mid, dname, is_act in m_res.all():
            mapping_names[mid] = dname
            if is_act:
                active_mapping_ids.add(mid)

    lead_campaign_map: Dict[UUID, str] = {
        l.id: _resolve_campaign_name(l, version_names, mapping_names)
        for l in all_period_leads
    }
    # Only active campaigns appear in the campaign filter dropdown and matrix
    available_campaigns = sorted(
        {
            lead_campaign_map[l.id]
            for l in all_period_leads
            if l.campaign_mapping_id in active_mapping_ids
        },
        key=str.lower,
    )

    # Filter by campaign if selected (active campaigns only)
    leads = all_period_leads
    if campaign:
        target_c = campaign.strip().lower()
        leads = [
            l
            for l in leads
            if l.campaign_mapping_id in active_mapping_ids
            and lead_campaign_map[l.id].lower() == target_c
        ]

    # Stip document detection for cohort leads
    lead_ids_pre = [l.id for l in leads]
    customer_ids_pre = {
        cid
        for l in leads
        for cid in (l.customer_id, l.secondary_customer_id)
        if cid is not None
    }
    leads_with_stip_doc: Set[UUID] = set()
    customers_with_stip_doc: Set[UUID] = set()
    if lead_ids_pre:
        lsd_res = await db.execute(
            select(LeadStipDocument.lead_id)
            .where(LeadStipDocument.lead_id.in_(lead_ids_pre))
            .distinct()
        )
        leads_with_stip_doc = {row[0] for row in lsd_res.all()}
    if customer_ids_pre:
        csd_res = await db.execute(
            select(CustomerStipDocument.customer_id)
            .where(CustomerStipDocument.customer_id.in_(customer_ids_pre))
            .distinct()
        )
        customers_with_stip_doc = {row[0] for row in csd_res.all()}

    def _lead_has_stip(l: Lead) -> bool:
        return bool(
            l.has_ssn_stip
            or l.has_dl_stip
            or l.id in leads_with_stip_doc
            or l.customer_id in customers_with_stip_doc
            or (l.secondary_customer_id and l.secondary_customer_id in customers_with_stip_doc)
        )

    if has_stip == "yes":
        leads = [l for l in leads if _lead_has_stip(l)]
    elif has_stip == "no":
        leads = [l for l in leads if not _lead_has_stip(l)]

    # If filtering by a specific BDC agent, include leads assigned to OR worked by that BDC agent
    if bdc_agent_id and leads:
        candidate_ids = [l.id for l in leads]
        acted_ids: Set[UUID] = set()
        act_res = await db.execute(
            select(Activity.lead_id)
            .where(
                Activity.lead_id.in_(candidate_ids),
                Activity.user_id == bdc_agent_id,
                Activity.type.in_(WORK_ACTIVITY_TYPES),
            )
            .distinct()
        )
        acted_ids.update(row[0] for row in act_res.all() if row[0])
        call_res = await db.execute(
            select(CallLog.lead_id)
            .where(CallLog.lead_id.in_(candidate_ids), CallLog.user_id == bdc_agent_id)
            .distinct()
        )
        acted_ids.update(row[0] for row in call_res.all() if row[0])
        appt_res = await db.execute(
            select(Appointment.lead_id)
            .where(Appointment.lead_id.in_(candidate_ids), Appointment.scheduled_by == bdc_agent_id)
            .distinct()
        )
        acted_ids.update(row[0] for row in appt_res.all() if row[0])
        leads = [
            l for l in leads
            if l.bdc_assigned_to_id == bdc_agent_id or l.id in acted_ids
        ]

    lead_ids = [l.id for l in leads]
    lead_by_id: Dict[UUID, Lead] = {l.id: l for l in leads}
    total_leads = len(leads)

    # 2. Load stages, partner stores, appointments, calls, and work activities for cohort leads
    stage_ids = {l.stage_id for l in leads if l.stage_id}
    stages_by_id: Dict[UUID, LeadStage] = {}
    if stage_ids:
        st_res = await db.execute(select(LeadStage).where(LeadStage.id.in_(stage_ids)))
        stages_by_id = {s.id: s for s in st_res.scalars().all()}

    partner_stores_res = await db.execute(select(PartnerStore).order_by(PartnerStore.name))
    partner_stores_by_id: Dict[UUID, PartnerStore] = {
        ps.id: ps for ps in partner_stores_res.scalars().all()
    }

    cohort_appointments: List[Appointment] = []
    worked_lead_ids: Set[UUID] = set()
    first_touch_at_by_lead: Dict[UUID, datetime] = {}

    if lead_ids:
        appt_res = await db.execute(
            select(Appointment).where(Appointment.lead_id.in_(lead_ids))
        )
        cohort_appointments = list(appt_res.scalars().all())

        # Any work activity or call counts a lead as "worked"
        act_min_res = await db.execute(
            select(Activity.lead_id, func.min(Activity.created_at))
            .where(
                Activity.lead_id.in_(lead_ids),
                Activity.type.in_(WORK_ACTIVITY_TYPES),
            )
            .group_by(Activity.lead_id)
        )
        for lid, ts in act_min_res.all():
            if lid:
                worked_lead_ids.add(lid)
                if ts:
                    first_touch_at_by_lead[lid] = ts

        call_min_res = await db.execute(
            select(CallLog.lead_id, func.min(CallLog.started_at))
            .where(CallLog.lead_id.in_(lead_ids))
            .group_by(CallLog.lead_id)
        )
        for lid, ts in call_min_res.all():
            if lid:
                worked_lead_ids.add(lid)
                if ts and (lid not in first_touch_at_by_lead or ts < first_touch_at_by_lead[lid]):
                    first_touch_at_by_lead[lid] = ts

    for l in leads:
        if l.first_contacted_at:
            worked_lead_ids.add(l.id)
            if l.id not in first_touch_at_by_lead or l.first_contacted_at < first_touch_at_by_lead[l.id]:
                first_touch_at_by_lead[l.id] = l.first_contacted_at

    # Group cohort appointments by lead_id
    appts_by_lead: Dict[UUID, List[Appointment]] = defaultdict(list)
    for a in cohort_appointments:
        if a.lead_id:
            appts_by_lead[a.lead_id].append(a)
            worked_lead_ids.add(a.lead_id)

    # Helper classifiers per lead
    def _is_converted(l: Lead) -> bool:
        st = stages_by_id.get(l.stage_id)
        return (l.outcome or "").lower() == "converted" or (st is not None and st.name.lower() == "converted")

    def _is_lost(l: Lead) -> bool:
        st = stages_by_id.get(l.stage_id)
        return (l.outcome or "").lower() == "lost" or (st is not None and st.name.lower() in LOST_STAGE_NAMES)

    def _is_interested(l: Lead) -> bool:
        if _is_converted(l):
            return True
        st = stages_by_id.get(l.stage_id)
        if st and st.name.lower() in INTERESTED_STAGE_NAMES:
            return True
        return False

    def _has_appt_set(lid: UUID) -> bool:
        return any(a.status in APPT_SET_STATUSES for a in appts_by_lead.get(lid, []))

    def _has_showed_up(lid: UUID) -> bool:
        return any(a.status in APPT_SHOWED_STATUSES for a in appts_by_lead.get(lid, []))

    def _has_no_show_only(lid: UUID) -> bool:
        appts = appts_by_lead.get(lid, [])
        return any(a.status == AppointmentStatus.NO_SHOW for a in appts) and not _has_showed_up(lid)

    # 3. Compute Cohort Summary & Funnel
    worked_count = 0
    interested_count = 0
    stips_count = 0
    partner_sent_count = 0
    appt_set_count = 0
    showed_up_count = 0
    no_show_lead_count = 0
    converted_count = 0
    lost_count = 0
    active_count = 0

    speed_minutes: List[float] = []
    days_to_appt: List[float] = []

    # Buckets for Campaign, Stage, Partner Store
    campaign_buckets: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    stage_counts: Dict[UUID, int] = defaultdict(int)
    store_buckets: Dict[Optional[UUID], Dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for l in leads:
        is_active_campaign = l.campaign_mapping_id in active_mapping_ids
        cb: Optional[Dict[str, int]] = None
        if is_active_campaign:
            c_name = lead_campaign_map[l.id]
            cb = campaign_buckets[c_name]
            cb["leads"] += 1

        if l.stage_id:
            stage_counts[l.stage_id] += 1

        is_worked = l.id in worked_lead_ids
        is_int = _is_interested(l)
        has_st = _lead_has_stip(l)
        is_conv = _is_converted(l)
        is_lst = _is_lost(l) and not is_conv
        has_appt = _has_appt_set(l.id)
        has_show = _has_showed_up(l.id)
        has_ns = _has_no_show_only(l.id)
        eff_store_id = l.sold_partner_store_id if is_conv and l.sold_partner_store_id else l.partner_store_id
        if not eff_store_id:
            # Check if any appointment on this lead has a partner store
            for a in appts_by_lead.get(l.id, []):
                if a.partner_store_id:
                    eff_store_id = a.partner_store_id
                    break
        is_sent = eff_store_id is not None

        if l.is_active and not is_conv and not is_lst:
            active_count += 1
        if is_worked:
            worked_count += 1
            if cb is not None:
                cb["worked"] += 1
            ft = first_touch_at_by_lead.get(l.id)
            if ft and l.created_at and ft >= l.created_at:
                diff_min = (ft - l.created_at).total_seconds() / 60.0
                # Ignore extreme outliers (> 30 days) for clean median
                if 0 <= diff_min <= 43200:
                    speed_minutes.append(diff_min)
        if is_int:
            interested_count += 1
            if cb is not None:
                cb["interested"] += 1
        if has_st:
            stips_count += 1
            if cb is not None:
                cb["stips"] += 1
        if is_sent:
            partner_sent_count += 1
            if cb is not None:
                cb["partner_sent"] += 1
        if has_appt:
            appt_set_count += 1
            if cb is not None:
                cb["appt_set"] += 1
            earliest_appt = min(
                (a.created_at for a in appts_by_lead[l.id] if a.status in APPT_SET_STATUSES and a.created_at),
                default=None,
            )
            if earliest_appt and l.created_at and earliest_appt >= l.created_at:
                days_to_appt.append((earliest_appt - l.created_at).total_seconds() / 86400.0)
        if has_show:
            showed_up_count += 1
            if cb is not None:
                cb["showed_up"] += 1
        if has_ns:
            no_show_lead_count += 1
            if cb is not None:
                cb["no_show"] += 1
        if is_conv:
            converted_count += 1
            if cb is not None:
                cb["converted"] += 1
        if is_lst:
            lost_count += 1
            if cb is not None:
                cb["lost"] += 1

        # Partner store matrix bucket (per lead)
        sb = store_buckets[eff_store_id]
        sb["leads_sent"] += 1
        if has_appt:
            sb["appt_set"] += 1
        if has_show:
            sb["showed_up"] += 1
        if has_ns:
            sb["no_show"] += 1
        if any(a.status == AppointmentStatus.CANCELLED for a in appts_by_lead.get(l.id, [])) and not has_appt:
            sb["cancelled"] += 1
        if is_conv:
            sb["sold"] += 1

    untouched_count = max(0, total_leads - worked_count)
    median_speed = round(median(speed_minutes), 1) if speed_minutes else None
    avg_days_appt = round(sum(days_to_appt) / len(days_to_appt), 2) if days_to_appt else None

    summary = CohortSummary(
        total_leads=total_leads,
        worked_leads=worked_count,
        worked_pct=_pct(worked_count, total_leads),
        untouched_leads=untouched_count,
        untouched_pct=_pct(untouched_count, total_leads),
        interested_leads=interested_count,
        interested_pct=_pct(interested_count, total_leads),
        interested_of_worked_pct=_pct(interested_count, worked_count),
        stips_leads=stips_count,
        stips_pct=_pct(stips_count, total_leads),
        stips_of_interested_pct=_pct(stips_count, interested_count),
        partner_sent_leads=partner_sent_count,
        partner_sent_pct=_pct(partner_sent_count, total_leads),
        appointment_set_leads=appt_set_count,
        appointment_set_pct=_pct(appt_set_count, total_leads),
        showed_up_leads=showed_up_count,
        showed_up_pct=_pct(showed_up_count, total_leads),
        show_rate_pct=_pct(showed_up_count, appt_set_count),
        no_show_leads=no_show_lead_count,
        no_show_pct=_pct(no_show_lead_count, appt_set_count),
        converted_leads=converted_count,
        converted_pct=_pct(converted_count, total_leads),
        close_rate_of_showed_pct=_pct(converted_count, showed_up_count),
        lost_leads=lost_count,
        lost_pct=_pct(lost_count, total_leads),
        active_leads=active_count,
        active_pct=_pct(active_count, total_leads),
        median_speed_to_lead_minutes=median_speed,
        avg_days_to_appointment=avg_days_appt,
    )

    funnel = [
        CohortFunnelStep(key="total", label="Total Leads", count=total_leads, pct_of_total=100.0 if total_leads else 0.0, pct_of_prev=None),
        CohortFunnelStep(key="worked", label="Worked / Contacted", count=worked_count, pct_of_total=_pct(worked_count, total_leads), pct_of_prev=_pct(worked_count, total_leads)),
        CohortFunnelStep(key="interested", label="Interested / Engaged", count=interested_count, pct_of_total=_pct(interested_count, total_leads), pct_of_prev=_pct(interested_count, worked_count)),
        CohortFunnelStep(key="stips", label="Stips Uploaded", count=stips_count, pct_of_total=_pct(stips_count, total_leads), pct_of_prev=_pct(stips_count, interested_count)),
        CohortFunnelStep(key="partner_sent", label="Sent to Partner Store", count=partner_sent_count, pct_of_total=_pct(partner_sent_count, total_leads), pct_of_prev=_pct(partner_sent_count, worked_count)),
        CohortFunnelStep(key="appt_set", label="Appointment Set", count=appt_set_count, pct_of_total=_pct(appt_set_count, total_leads), pct_of_prev=_pct(appt_set_count, worked_count)),
        CohortFunnelStep(key="showed_up", label="Showed Up (Arrived)", count=showed_up_count, pct_of_total=_pct(showed_up_count, total_leads), pct_of_prev=_pct(showed_up_count, appt_set_count)),
        CohortFunnelStep(key="converted", label="Converted / Sold", count=converted_count, pct_of_total=_pct(converted_count, total_leads), pct_of_prev=_pct(converted_count, showed_up_count)),
    ]

    # 4. Campaign matrix rows
    campaigns: List[CampaignMatrixRow] = []
    for c_name, cb in campaign_buckets.items():
        n = cb["leads"]
        appt_n = cb["appt_set"]
        campaigns.append(
            CampaignMatrixRow(
                campaign_name=c_name,
                leads=n,
                share_pct=_pct(n, total_leads),
                worked=cb["worked"],
                worked_pct=_pct(cb["worked"], n),
                interested=cb["interested"],
                interested_pct=_pct(cb["interested"], n),
                stips=cb["stips"],
                stips_pct=_pct(cb["stips"], n),
                partner_sent=cb["partner_sent"],
                partner_sent_pct=_pct(cb["partner_sent"], n),
                appt_set=appt_n,
                appt_set_pct=_pct(appt_n, n),
                showed_up=cb["showed_up"],
                show_rate_pct=_pct(cb["showed_up"], appt_n),
                no_show=cb["no_show"],
                no_show_pct=_pct(cb["no_show"], appt_n),
                converted=cb["converted"],
                converted_pct=_pct(cb["converted"], n),
                lost=cb["lost"],
                lost_pct=_pct(cb["lost"], n),
            )
        )
    campaigns.sort(key=lambda r: (-r.leads, r.campaign_name.lower()))

    # 5. Stage matrix rows
    stages: List[StageMatrixRow] = []
    for sid, cnt in stage_counts.items():
        st = stages_by_id.get(sid)
        stages.append(
            StageMatrixRow(
                stage_id=str(sid),
                stage_name=st.name if st else "unknown",
                display_name=st.display_name if st else "Unknown",
                color=st.color if st else None,
                is_terminal=bool(st.is_terminal) if st else False,
                count=cnt,
                pct_of_total=_pct(cnt, total_leads),
            )
        )
    stages.sort(key=lambda r: (-r.count, r.display_name.lower()))

    # 6. Appointments matrix (appointment-level counts for cohort leads)
    appt_status_counts: Dict[str, int] = defaultdict(int)
    for a in cohort_appointments:
        appt_status_counts[_status_str(a.status)] += 1
    total_appts = len(cohort_appointments)
    appt_cancelled = appt_status_counts.get("cancelled", 0)
    appt_rescheduled = appt_status_counts.get("rescheduled", 0)
    appt_active_denom = max(0, total_appts - appt_cancelled - appt_rescheduled)
    appt_showed = sum(appt_status_counts.get(s.value, 0) for s in APPT_SHOWED_STATUSES)
    appt_no_show = appt_status_counts.get("no_show", 0)

    by_status_rows = [
        AppointmentStatusMatrixRow(
            status=st_key,
            label=APPT_STATUS_LABELS.get(st_key, st_key.replace("_", " ").title()),
            count=appt_status_counts[st_key],
            pct_of_appointments=_pct(appt_status_counts[st_key], total_appts),
        )
        for st_key in APPT_STATUS_ORDER
        if appt_status_counts.get(st_key, 0) > 0
    ]

    appointments_summary = AppointmentsSummary(
        total_appointments=total_appts,
        active_outcome_denominator=appt_active_denom,
        showed_up=appt_showed,
        show_rate_pct=_pct(appt_showed, appt_active_denom),
        no_show=appt_no_show,
        no_show_rate_pct=_pct(appt_no_show, appt_active_denom),
        cancelled=appt_cancelled,
        cancel_rate_pct=_pct(appt_cancelled, total_appts),
        rescheduled=appt_rescheduled,
        by_status=by_status_rows,
    )

    # 7. Partner store matrix rows
    partner_store_rows: List[PartnerStoreMatrixRow] = []
    for ps_id, sb in store_buckets.items():
        if ps_id is None:
            ps_name = "Not Sent to Store Yet"
        else:
            ps = partner_stores_by_id.get(ps_id)
            if ps:
                ps_name = f"{ps.name} ({ps.brand})" if ps.brand else ps.name
            else:
                ps_name = "Unknown Store"
        sent_n = sb["leads_sent"]
        appt_n = sb["appt_set"]
        show_n = sb["showed_up"]
        partner_store_rows.append(
            PartnerStoreMatrixRow(
                partner_store_id=str(ps_id) if ps_id else None,
                partner_store_name=ps_name,
                leads_sent=sent_n,
                share_pct=_pct(sent_n, total_leads),
                appt_set=appt_n,
                appt_set_pct=_pct(appt_n, sent_n),
                showed_up=show_n,
                show_rate_pct=_pct(show_n, appt_n),
                no_show=sb["no_show"],
                no_show_pct=_pct(sb["no_show"], appt_n),
                cancelled=sb["cancelled"],
                sold=sb["sold"],
                close_rate_of_showed_pct=_pct(sb["sold"], show_n),
                sold_of_sent_pct=_pct(sb["sold"], sent_n),
            )
        )
    # Put real stores first sorted by leads_sent desc, then "Not Sent to Store Yet" last
    partner_store_rows.sort(
        key=lambda r: (r.partner_store_id is None, -r.leads_sent, r.partner_store_name.lower())
    )

    # 8. BDC Agent Productivity Matrix
    bdc_users = await _get_bdc_users(db, dealership_id, bdc_agent_id)
    bdc_ids = [u.id for u in bdc_users]
    bdc_rows, bdc_totals = await _build_bdc_productivity(
        db,
        bdc_users=bdc_users,
        bdc_ids=bdc_ids,
        dealership_id=dealership_id,
        date_from=date_from,
        date_to=date_to,
        mode=mode,
        cohort_lead_ids=set(lead_ids),
        cohort_leads_by_id=lead_by_id,
        partner_store_id=partner_store_id,
    )

    return LeadCohortAnalysisResponse(
        date_from=date_from.isoformat() if date_from else None,
        date_to=date_to.isoformat() if date_to else None,
        dealership_id=str(dealership_id) if dealership_id else None,
        bdc_mode=mode,
        include_returning=include_returning,
        available_campaigns=available_campaigns,
        summary=summary,
        funnel=funnel,
        campaigns=campaigns,
        stages=stages,
        appointments=appointments_summary,
        partner_stores=partner_store_rows,
        bdc_agents=bdc_rows,
        bdc_totals=bdc_totals,
    )


async def _build_bdc_productivity(
    db: AsyncSession,
    *,
    bdc_users: List[User],
    bdc_ids: List[UUID],
    dealership_id: Optional[UUID],
    date_from: Optional[datetime],
    date_to: Optional[datetime],
    mode: str,
    cohort_lead_ids: Set[UUID],
    cohort_leads_by_id: Dict[UUID, Lead],
    partner_store_id: Optional[UUID],
) -> tuple[List[BdcAgentProductivityRow], BdcAgentProductivityRow]:
    empty_total = BdcAgentProductivityRow(
        user_id="total",
        user_name="BDC Team Total",
        email=None,
        leads_worked=0,
        calls_made=0,
        connected_calls=0,
        connect_rate_pct=0.0,
        avg_call_duration_seconds=0.0,
        notes_added=0,
        touches_total=0,
        avg_touches_per_lead=0.0,
        median_speed_to_lead_minutes=None,
        stips_leads=0,
        appts_scheduled=0,
        appt_set_rate_pct=0.0,
        appts_arrived=0,
        show_rate_pct=0.0,
        appts_no_show=0,
        no_show_rate_pct=0.0,
        appts_cancelled=0,
        sold_leads=0,
        sold_rate_pct=0.0,
    )
    if not bdc_ids:
        return [], empty_total

    # Per-agent accumulators
    leads_worked_by_agent: Dict[UUID, Set[UUID]] = defaultdict(set)
    calls_made_by_agent: Dict[UUID, int] = defaultdict(int)
    connected_calls_by_agent: Dict[UUID, int] = defaultdict(int)
    call_durations_by_agent: Dict[UUID, List[int]] = defaultdict(list)
    notes_by_agent: Dict[UUID, int] = defaultdict(int)
    touches_by_agent: Dict[UUID, int] = defaultdict(int)
    first_touch_by_agent_lead: Dict[tuple[UUID, UUID], datetime] = {}
    appts_by_agent: Dict[UUID, List[Appointment]] = defaultdict(list)

    # Queries depend on mode:
    # - "cohort": all calls/activities/appts by these BDC agents on cohort_lead_ids (regardless of when the touch happened)
    # - "activity": all calls/activities/appts by these BDC agents with timestamp in [date_from, date_to]
    if mode == "cohort" and not cohort_lead_ids:
        calls: List[CallLog] = []
        activities: List[Activity] = []
        appointments: List[Appointment] = []
    else:
        # Calls
        call_conds = [CallLog.user_id.in_(bdc_ids)]
        if dealership_id:
            call_conds.append(or_(CallLog.dealership_id == dealership_id, CallLog.dealership_id.is_(None)))
        if mode == "cohort":
            call_conds.append(CallLog.lead_id.in_(cohort_lead_ids))
        else:
            if date_from is not None:
                call_conds.append(CallLog.started_at >= date_from)
            if date_to is not None:
                call_conds.append(CallLog.started_at <= date_to)
        calls = list((await db.execute(select(CallLog).where(and_(*call_conds)))).scalars().all())

        # Activities
        act_conds = [
            Activity.user_id.in_(bdc_ids),
            Activity.type.in_(WORK_ACTIVITY_TYPES),
            Activity.lead_id.isnot(None),
        ]
        if dealership_id:
            act_conds.append(or_(Activity.dealership_id == dealership_id, Activity.dealership_id.is_(None)))
        if mode == "cohort":
            act_conds.append(Activity.lead_id.in_(cohort_lead_ids))
        else:
            if date_from is not None:
                act_conds.append(Activity.created_at >= date_from)
            if date_to is not None:
                act_conds.append(Activity.created_at <= date_to)
        activities = list((await db.execute(select(Activity).where(and_(*act_conds)))).scalars().all())

        # Appointments scheduled by BDC agents
        appt_conds = [Appointment.scheduled_by.in_(bdc_ids)]
        if dealership_id:
            appt_conds.append(or_(Appointment.dealership_id == dealership_id, Appointment.dealership_id.is_(None)))
        if partner_store_id:
            appt_conds.append(Appointment.partner_store_id == partner_store_id)
        if mode == "cohort":
            appt_conds.append(Appointment.lead_id.in_(cohort_lead_ids))
        else:
            if date_from is not None:
                appt_conds.append(Appointment.created_at >= date_from)
            if date_to is not None:
                appt_conds.append(Appointment.created_at <= date_to)
        appointments = list((await db.execute(select(Appointment).where(and_(*appt_conds)))).scalars().all())

    # Process calls
    for c in calls:
        uid = c.user_id
        if not uid:
            continue
        calls_made_by_agent[uid] += 1
        touches_by_agent[uid] += 1
        if c.status == CallStatus.COMPLETED and (c.duration_seconds or 0) >= 15:
            connected_calls_by_agent[uid] += 1
            call_durations_by_agent[uid].append(c.duration_seconds or 0)
        if c.lead_id:
            leads_worked_by_agent[uid].add(c.lead_id)
            key = (uid, c.lead_id)
            if c.started_at and (key not in first_touch_by_agent_lead or c.started_at < first_touch_by_agent_lead[key]):
                first_touch_by_agent_lead[key] = c.started_at

    # Process activities (avoid double-counting CALL_LOGGED in touches if call_logs already counted)
    for act in activities:
        uid = act.user_id
        if not uid or not act.lead_id:
            continue
        leads_worked_by_agent[uid].add(act.lead_id)
        if act.type == ActivityType.NOTE_ADDED:
            notes_by_agent[uid] += 1
            touches_by_agent[uid] += 1
        elif act.type != ActivityType.CALL_LOGGED:
            touches_by_agent[uid] += 1
        key = (uid, act.lead_id)
        if act.created_at and (key not in first_touch_by_agent_lead or act.created_at < first_touch_by_agent_lead[key]):
            first_touch_by_agent_lead[key] = act.created_at

    # Process appointments
    for a in appointments:
        uid = a.scheduled_by
        if not uid:
            continue
        appts_by_agent[uid].append(a)
        if a.lead_id:
            leads_worked_by_agent[uid].add(a.lead_id)

    # Load Lead details for all leads worked by any BDC agent (for stips, sold, created_at speed-to-lead)
    all_worked_ids: Set[UUID] = set()
    for s in leads_worked_by_agent.values():
        all_worked_ids.update(s)

    worked_leads_map: Dict[UUID, Lead] = dict(cohort_leads_by_id)
    missing_lead_ids = [lid for lid in all_worked_ids if lid not in worked_leads_map]
    if missing_lead_ids:
        ml_res = await db.execute(select(Lead).where(Lead.id.in_(missing_lead_ids)))
        for l in ml_res.scalars().all():
            worked_leads_map[l.id] = l

    # If partner_store_id filter is active in activity mode, scope worked leads to that store
    if partner_store_id and mode == "activity":
        for uid in list(leads_worked_by_agent.keys()):
            leads_worked_by_agent[uid] = {
                lid
                for lid in leads_worked_by_agent[uid]
                if lid in worked_leads_map
                and (
                    worked_leads_map[lid].partner_store_id == partner_store_id
                    or worked_leads_map[lid].sold_partner_store_id == partner_store_id
                )
            }

    # Build rows per agent
    rows: List[BdcAgentProductivityRow] = []
    team_worked_leads: Set[UUID] = set()
    team_calls = 0
    team_connected = 0
    team_durations: List[int] = []
    team_notes = 0
    team_touches = 0
    team_speeds: List[float] = []
    team_stips_leads: Set[UUID] = set()
    team_appts_scheduled = 0
    team_appts_arrived = 0
    team_appts_no_show = 0
    team_appts_cancelled = 0
    team_appts_rescheduled = 0
    team_sold_leads: Set[UUID] = set()

    for u in bdc_users:
        uid = u.id
        worked_set = leads_worked_by_agent.get(uid, set())
        worked_n = len(worked_set)
        calls_n = calls_made_by_agent.get(uid, 0)
        conn_n = connected_calls_by_agent.get(uid, 0)
        durs = call_durations_by_agent.get(uid, [])
        avg_dur = round(sum(durs) / len(durs), 1) if durs else 0.0
        notes_n = notes_by_agent.get(uid, 0)
        touches_n = touches_by_agent.get(uid, 0)
        avg_touches = round(touches_n / worked_n, 2) if worked_n > 0 else 0.0

        # Speed to lead for this agent's worked leads
        agent_speeds: List[float] = []
        stips_n = 0
        sold_n = 0
        for lid in worked_set:
            lead = worked_leads_map.get(lid)
            if not lead:
                continue
            if lead.has_ssn_stip or lead.has_dl_stip:
                stips_n += 1
                team_stips_leads.add(lid)
            if (lead.outcome or "").lower() == "converted":
                sold_n += 1
                team_sold_leads.add(lid)
            ft = first_touch_by_agent_lead.get((uid, lid))
            if ft and lead.created_at and ft >= lead.created_at:
                diff_min = (ft - lead.created_at).total_seconds() / 60.0
                if 0 <= diff_min <= 43200:
                    agent_speeds.append(diff_min)
                    team_speeds.append(diff_min)

        agent_appts = appts_by_agent.get(uid, [])
        appts_sched = len(agent_appts)
        appts_arrived = sum(1 for a in agent_appts if a.status in APPT_SHOWED_STATUSES)
        appts_ns = sum(1 for a in agent_appts if a.status == AppointmentStatus.NO_SHOW)
        appts_canc = sum(1 for a in agent_appts if a.status == AppointmentStatus.CANCELLED)
        appts_resch = sum(1 for a in agent_appts if a.status == AppointmentStatus.RESCHEDULED)
        appts_denom = max(0, appts_sched - appts_canc - appts_resch)
        appt_distinct_leads = len({a.lead_id for a in agent_appts if a.lead_id and a.status in APPT_SET_STATUSES})

        full_name = f"{u.first_name or ''} {u.last_name or ''}".strip() or (u.email or "BDC Agent")
        rows.append(
            BdcAgentProductivityRow(
                user_id=str(uid),
                user_name=full_name,
                email=u.email,
                leads_worked=worked_n,
                calls_made=calls_n,
                connected_calls=conn_n,
                connect_rate_pct=_pct(conn_n, calls_n),
                avg_call_duration_seconds=avg_dur,
                notes_added=notes_n,
                touches_total=touches_n,
                avg_touches_per_lead=avg_touches,
                median_speed_to_lead_minutes=round(median(agent_speeds), 1) if agent_speeds else None,
                stips_leads=stips_n,
                appts_scheduled=appts_sched,
                appt_set_rate_pct=_pct(appt_distinct_leads, worked_n),
                appts_arrived=appts_arrived,
                show_rate_pct=_pct(appts_arrived, appts_denom),
                appts_no_show=appts_ns,
                no_show_rate_pct=_pct(appts_ns, appts_denom),
                appts_cancelled=appts_canc,
                sold_leads=sold_n,
                sold_rate_pct=_pct(sold_n, worked_n),
            )
        )

        team_worked_leads.update(worked_set)
        team_calls += calls_n
        team_connected += conn_n
        team_durations.extend(durs)
        team_notes += notes_n
        team_touches += touches_n
        team_appts_scheduled += appts_sched
        team_appts_arrived += appts_arrived
        team_appts_no_show += appts_ns
        team_appts_cancelled += appts_canc
        team_appts_rescheduled += appts_resch

    rows.sort(key=lambda r: (-r.leads_worked, -r.calls_made, r.user_name.lower()))

    team_worked_n = len(team_worked_leads)
    team_appts_denom = max(0, team_appts_scheduled - team_appts_cancelled - team_appts_rescheduled)
    totals = BdcAgentProductivityRow(
        user_id="total",
        user_name="BDC Team Total",
        email=None,
        leads_worked=team_worked_n,
        calls_made=team_calls,
        connected_calls=team_connected,
        connect_rate_pct=_pct(team_connected, team_calls),
        avg_call_duration_seconds=round(sum(team_durations) / len(team_durations), 1) if team_durations else 0.0,
        notes_added=team_notes,
        touches_total=team_touches,
        avg_touches_per_lead=round(team_touches / team_worked_n, 2) if team_worked_n > 0 else 0.0,
        median_speed_to_lead_minutes=round(median(team_speeds), 1) if team_speeds else None,
        stips_leads=len(team_stips_leads),
        appts_scheduled=team_appts_scheduled,
        appt_set_rate_pct=_pct(team_appts_scheduled, team_worked_n),
        appts_arrived=team_appts_arrived,
        show_rate_pct=_pct(team_appts_arrived, team_appts_denom),
        appts_no_show=team_appts_no_show,
        no_show_rate_pct=_pct(team_appts_no_show, team_appts_denom),
        appts_cancelled=team_appts_cancelled,
        sold_leads=len(team_sold_leads),
        sold_rate_pct=_pct(len(team_sold_leads), team_worked_n),
    )
    return rows, totals
