"""
User Endpoints
"""
from typing import Any, List, Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select, func, and_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import deps
from app.core.permissions import ARCHIVED_ROLES, ASSIGNABLE_ROLES, Permission, UserRole
from app.core.access_scope import get_carvaminos_dealership_id
from app.db.database import get_db
from app.models.user import User
from app.models.lead import Lead
from app.schemas.user import (
    UserResponse,
    UserCreate,
    UserUpdate,
    UserBrief,
    UserWithStats,
    TeamListResponse,
    SetConfigAccessPasswordRequest,
)
from app.core.security import get_password_hash, verify_password
from app.services.email_notifier import send_new_member_welcome_email

router = APIRouter()

_ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.DEALERSHIP_ADMIN)

# Roles each admin role may hand out when creating or editing a user.
_GRANTABLE_ROLES = {
    UserRole.SUPER_ADMIN: ASSIGNABLE_ROLES,
    UserRole.DEALERSHIP_ADMIN: frozenset({UserRole.BDC}),
}


def _current_team():
    """Base query for people who are part of the team today (excludes archived former staff)."""
    return select(User).where(User.role.notin_(ARCHIVED_ROLES))


def _check_can_grant(current_user: User, role: UserRole) -> None:
    if role not in _GRANTABLE_ROLES.get(current_user.role, frozenset()):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot give this role",
        )


@router.get("/", response_model=List[UserBrief])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user),
    role: Optional[UserRole] = None,
    is_active: Optional[bool] = None
) -> Any:
    """List team members. BDC agents only see themselves."""
    query = _current_team()
    if current_user.role not in _ADMIN_ROLES:
        query = query.where(User.id == current_user.id)
    if role:
        query = query.where(User.role == role)
    if is_active is not None:
        query = query.where(User.is_active == is_active)

    query = query.order_by(User.created_at.desc())
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/mentionable", response_model=List[UserBrief])
async def get_mentionable_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user),
    lead_id: Optional[UUID] = Query(None, description="Accepted for compatibility; everyone active is mentionable"),
) -> Any:
    """Active team members that can be @mentioned in notes."""
    result = await db.execute(
        _current_team()
        .where(User.is_active == True, User.id != current_user.id)
        .order_by(User.first_name, User.last_name)
    )
    return result.scalars().all()


@router.get("/team", response_model=TeamListResponse)
async def get_team_with_stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user),
) -> Any:
    """Team members (active and deactivated, not archived) with their lead statistics."""
    if current_user.role not in _ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Only admins and managers can view team stats")

    result = await db.execute(_current_team().order_by(User.first_name, User.last_name))
    users = result.scalars().all()

    team_members = []
    for user in users:
        total_leads = (await db.execute(
            select(func.count(Lead.id)).where(Lead.assigned_to == user.id)
        )).scalar() or 0
        active_leads = (await db.execute(
            select(func.count(Lead.id)).where(
                and_(Lead.assigned_to == user.id, Lead.is_active == True)
            )
        )).scalar() or 0
        converted_leads = (await db.execute(
            select(func.count(Lead.id)).where(
                and_(Lead.assigned_to == user.id, Lead.outcome == "converted")
            )
        )).scalar() or 0
        conversion_rate = (converted_leads / total_leads * 100) if total_leads > 0 else 0.0

        team_members.append(UserWithStats(
            id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            role=user.role,
            is_active=user.is_active,
            dealership_id=user.dealership_id,
            total_leads=total_leads,
            active_leads=active_leads,
            converted_leads=converted_leads,
            conversion_rate=round(conversion_rate, 1)
        ))

    return TeamListResponse(items=team_members, total=len(team_members))


@router.get("/salespersons", response_model=List[UserBrief])
async def list_assignable_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user),
) -> Any:
    """Active managers and BDC agents for the lead assignment dropdown."""
    result = await db.execute(
        select(User)
        .where(
            User.role.in_([UserRole.DEALERSHIP_ADMIN, UserRole.BDC]),
            User.is_active == True,
        )
        .order_by(User.role, User.first_name)
    )
    return result.scalars().all()


@router.post("/", response_model=UserResponse)
async def create_user(
    *,
    db: AsyncSession = Depends(get_db),
    background_tasks: BackgroundTasks,
    user_in: UserCreate,
    current_user: User = Depends(deps.require_permission(Permission.CREATE_USER))
) -> Any:
    """
    Create a team member. Sends a welcome email with temporary credentials;
    the user must change the password on first login.

    - Super Admin: can create Super Admins, Managers and BDC agents
    - Manager: can create BDC agents
    """
    _check_can_grant(current_user, user_in.role)

    email_normalized = user_in.email.strip().lower()
    existing = (await db.execute(
        select(User).where(func.lower(User.email) == email_normalized).limit(1)
    )).scalar_one_or_none()
    if existing:
        detail = (
            "This email belongs to a former team member"
            if existing.role in ARCHIVED_ROLES
            else "A team member with this email already exists"
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    phone_val = (user_in.phone or "").strip() or None

    user = User(
        email=user_in.email,
        password_hash=get_password_hash(user_in.password),
        first_name=user_in.first_name,
        last_name=user_in.last_name,
        phone=phone_val,
        role=user_in.role,
        dealership_id=await get_carvaminos_dealership_id(db),
        is_active=True,
        must_change_password=True,
        hourly_rate=user_in.hourly_rate if user_in.role == UserRole.BDC else None,
    )

    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A team member with this email already exists",
        ) from None

    to_name = f"{user.first_name} {user.last_name}".strip() or user.email
    added_by_name = current_user.full_name or current_user.email
    background_tasks.add_task(
        send_new_member_welcome_email,
        user.email,
        to_name,
        user_in.password,
        added_by_name,
        "Carvaminos",
    )

    return user


@router.get("/me", response_model=UserResponse)
async def get_current_user_profile(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user)
) -> Any:
    """
    Get current user's profile.
    """
    return current_user


@router.patch("/me", response_model=UserResponse)
async def update_current_user_profile(
    user_update: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user)
) -> Any:
    """
    Update current user's profile.
    Users can update their own name, phone, and email settings.
    """
    update_data = user_update.model_dump(exclude_unset=True)

    # Users cannot change their own status or role
    update_data.pop("is_active", None)
    update_data.pop("role", None)

    for field, value in update_data.items():
        setattr(current_user, field, value)

    await db.commit()
    await db.refresh(current_user)

    return current_user


@router.put("/me/config-access-password", response_model=UserResponse)
async def set_config_access_password(
    body: SetConfigAccessPasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user),
) -> Any:
    """
    Set or change the configuration-access password (used with /auth/verify-config-access).
    Must differ from your CRM login password.
    """
    if current_user.role not in _ADMIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your role cannot set a configuration-access password",
        )
    if not verify_password(body.login_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Login password is incorrect",
        )
    if body.config_password != body.config_password_confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Configuration passwords do not match",
        )
    if body.config_password == body.login_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Configuration-access password must differ from your login password",
        )
    if verify_password(body.config_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Configuration-access password must differ from your login password",
        )
    if current_user.config_access_password_hash:
        if not body.current_config_password:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current configuration password is required to change it",
            )
        if not verify_password(body.current_config_password, current_user.config_access_password_hash):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current configuration password is incorrect",
            )

    current_user.config_access_password_hash = get_password_hash(body.config_password)
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: UUID,
    user_update: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user)
) -> Any:
    """
    Update a team member. Super Admins and Managers can edit details and
    activate/deactivate; role changes follow the same rules as creation.
    Archived former staff cannot be edited.
    """
    if current_user.role not in _ADMIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins and managers can update team members",
        )

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user or user.role in ARCHIVED_ROLES:
        raise HTTPException(status_code=404, detail="User not found")

    update_data = user_update.model_dump(exclude_unset=True)

    if current_user.id == user_id and ("is_active" in update_data or "role" in update_data):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot change your own status or role",
        )

    # Managers only manage BDC agents; touching another admin needs Super Admin.
    if current_user.role != UserRole.SUPER_ADMIN and user.role != UserRole.BDC and current_user.id != user_id:
        raise HTTPException(status_code=403, detail="Only a Super Admin can edit admins and managers")

    if "role" in update_data:
        _check_can_grant(current_user, update_data["role"])

    for field, value in update_data.items():
        if hasattr(user, field):
            setattr(user, field, value)

    await db.commit()
    await db.refresh(user)
    return user


@router.get("/bdc-agents", response_model=List[UserBrief])
async def list_bdc_agents(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user),
) -> Any:
    """Active BDC agents. BDC agents see their colleagues, not themselves."""
    query = select(User).where(User.role == UserRole.BDC, User.is_active == True)
    if current_user.role == UserRole.BDC:
        query = query.where(User.id != current_user.id)
    result = await db.execute(query.order_by(User.first_name, User.last_name))
    return result.scalars().all()


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user)
) -> Any:
    """
    Get user by ID.
    """
    if current_user.role not in _ADMIN_ROLES and current_user.id != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user
