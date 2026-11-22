"use client"

import * as React from "react"
import { Loader2, User, Mail, Phone, Target, Building2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { LeadService, Lead } from "@/services/lead-service"
import { DealershipService } from "@/services/dealership-service"
import { useAuthStore } from "@/stores/auth-store"
import { useOrgDealershipId } from "@/hooks/use-org-dealership"
import { getCountryAndDial, formatPhoneForDisplay, toE164, DIAL_CODE_OPTIONS } from "@/lib/phone-utils"

interface CreateLeadModalProps {
    isOpen: boolean
    onClose: () => void
    /** Called after lead is created; receives the new lead when available */
    onSuccess?: (lead?: Lead) => void
}

const LEAD_SOURCES = [
    { value: "manual", label: "Manual entry" },
    { value: "phone", label: "Phone inquiry" },
    { value: "website", label: "Website form" },
    { value: "referral", label: "Referral" },
    { value: "walk_in", label: "Walk-in" },
    { value: "social_media", label: "Social media" },
]

function apiErrorMessage(err: unknown): string {
    const detail =
        err && typeof err === "object" && "response" in err
            ? (err as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
            : undefined
    if (typeof detail === "string" && detail.trim()) return detail
    if (Array.isArray(detail)) {
        const parts = detail
            .map((item) => {
                if (typeof item === "string") return item
                if (!item || typeof item !== "object") return ""
                const row = item as { msg?: unknown; loc?: unknown }
                const msg = typeof row.msg === "string" ? row.msg.replace(/^Value error,\s*/i, "") : ""
                const loc = Array.isArray(row.loc)
                    ? row.loc.filter((part) => part !== "body").map(String).join(" ")
                    : ""
                if (msg && loc) return `${loc}: ${msg}`
                return msg
            })
            .filter(Boolean)
        if (parts.length) return parts.join(". ")
    }
    return "Could not create the lead. Check the fields and try again."
}

export function CreateLeadModal({ isOpen, onClose, onSuccess }: CreateLeadModalProps) {
    const user = useAuthStore((s) => s.user)
    const orgDealershipId = useOrgDealershipId()
    const isBdc = user?.role === "bdc"

    const [isLoading, setIsLoading] = React.useState(false)
    const [error, setError] = React.useState("")
    const [dialCode, setDialCode] = React.useState("+1")
    const [countryCode, setCountryCode] = React.useState("US")
    const [orgDealershipName, setOrgDealershipName] = React.useState("Carvaminos")

    const [formData, setFormData] = React.useState({
        first_name: "",
        last_name: "",
        email: "",
        phone: "",
        alternate_phone: "",
        source: "manual",
        interested_in: "",
        budget_range: "",
        notes: "",
    })

    // Default phone country from org (Carvaminos) dealership
    React.useEffect(() => {
        if (!isOpen) {
            setDialCode("+1")
            setCountryCode("US")
            return
        }
        const id = orgDealershipId || user?.dealership_id || null
        if (!id) {
            setDialCode("+1")
            setCountryCode("US")
            return
        }
        DealershipService.getDealership(id)
            .then((d) => {
                const { countryCode: code, dialCode: dial } = getCountryAndDial(d.country ?? undefined)
                setCountryCode(code)
                setDialCode(dial)
                if (d.name) setOrgDealershipName(d.name)
            })
            .catch(() => {
                setDialCode("+1")
                setCountryCode("US")
            })
    }, [isOpen, orgDealershipId, user?.dealership_id])

    const resetForm = () => {
        setFormData({
            first_name: "",
            last_name: "",
            email: "",
            phone: "",
            alternate_phone: "",
            source: "manual",
            interested_in: "",
            budget_range: "",
            notes: "",
        })
        setError("")
    }

    const handlePhoneChange = (field: "phone" | "alternate_phone", value: string) => {
        const digits = value.replace(/\D/g, "")
        const formatted = digits ? formatPhoneForDisplay(digits, dialCode) : ""
        setFormData((prev) => ({ ...prev, [field]: formatted }))
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()

        if (!formData.first_name.trim()) {
            setError("First name is required")
            return
        }

        if (!formData.email?.trim() && !formData.phone?.trim()) {
            setError("Enter a phone number or an email. Last name can be left blank.")
            return
        }

        if (isBdc && !orgDealershipId) {
            setError("Organization dealership is not available. Please refresh and try again.")
            return
        }

        setIsLoading(true)
        setError("")

        const phone = formData.phone.trim() ? toE164(formData.phone, dialCode) : undefined
        const alternatePhone = formData.alternate_phone.trim()
            ? toE164(formData.alternate_phone, dialCode)
            : undefined
        if ((phone && phone.length > 20) || (alternatePhone && alternatePhone.length > 20)) {
            setError("That phone number is too long. Use the country code and the local number only.")
            setIsLoading(false)
            return
        }
        // Phone inquiry and social media are labels, not database sources.
        const sourceChoice = formData.source
        const source =
            sourceChoice === "phone" || sourceChoice === "social_media" ? "manual" : sourceChoice
        const sourceDisplay =
            sourceChoice === "phone"
                ? "Phone inquiry"
                : sourceChoice === "social_media"
                  ? "Social media"
                  : undefined
        const payload: Parameters<typeof LeadService.createLead>[0] = {
            first_name: formData.first_name.trim(),
            last_name: formData.last_name.trim() || undefined,
            email: formData.email.trim() || undefined,
            phone,
            alternate_phone: alternatePhone,
            source,
            interested_in: formData.interested_in.trim() || undefined,
            budget_range: formData.budget_range.trim() || undefined,
            notes: formData.notes.trim() || undefined,
            meta_data: sourceDisplay ? { source_display: sourceDisplay } : undefined,
        }
        // BDC manual leads always go to Carvaminos (single-org)
        if (isBdc && orgDealershipId) {
            payload.dealership_id = orgDealershipId
        }

        try {
            const created = await LeadService.createLead(payload)
            resetForm()
            onSuccess?.(created)
            onClose()
        } catch (err: unknown) {
            console.error("Failed to create lead:", err)
            setError(apiErrorMessage(err))
        } finally {
            setIsLoading(false)
        }
    }

    const handleClose = () => {
        resetForm()
        onClose()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <User className="h-5 w-5" />
                        Add New Lead
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {isBdc && (
                        <div className="space-y-2">
                            <Label>Dealership</Label>
                            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="font-medium">{orgDealershipName}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Manual leads are added to Carvaminos by default.
                            </p>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="first_name">First Name *</Label>
                            <Input
                                id="first_name"
                                placeholder="John"
                                value={formData.first_name}
                                onChange={(e) => setFormData((prev) => ({ ...prev, first_name: e.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="last_name">Last Name (optional)</Label>
                            <Input
                                id="last_name"
                                placeholder="Doe"
                                value={formData.last_name}
                                onChange={(e) => setFormData((prev) => ({ ...prev, last_name: e.target.value }))}
                            />
                        </div>
                    </div>

                    <div className="space-y-4">
                        <p className="text-xs text-muted-foreground">
                            Phone or email is required. You can leave the other one blank.
                        </p>
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <div className="relative">
                                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    id="email"
                                    type="text"
                                    inputMode="email"
                                    placeholder="john@example.com"
                                    className="pl-9 w-full"
                                    value={formData.email}
                                    onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                                />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="phone">Phone</Label>
                            <div className="flex gap-2 w-full min-w-0">
                                <Select
                                    value={dialCode}
                                    onValueChange={(value) => {
                                        const option = DIAL_CODE_OPTIONS.find((o) => o.dial === value)
                                        if (option) {
                                            setDialCode(option.dial)
                                            setCountryCode(option.code)
                                        }
                                    }}
                                >
                                    <SelectTrigger className="w-[120px] shrink-0">
                                        <SelectValue placeholder="+1" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {DIAL_CODE_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.dial} value={opt.dial}>
                                                {opt.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <div className="relative flex-1 min-w-0">
                                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                                    <Input
                                        id="phone"
                                        type="tel"
                                        inputMode="tel"
                                        placeholder={countryCode === "US" ? "234 567 8900" : "phone number"}
                                        className="pl-9 w-full min-w-0"
                                        value={formData.phone}
                                        onChange={(e) => handlePhoneChange("phone", e.target.value)}
                                    />
                                </div>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Country: {countryCode} (default from dealership; you can change above)
                            </p>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="source">Lead Source</Label>
                        <Select
                            value={formData.source}
                            onValueChange={(v) => setFormData((prev) => ({ ...prev, source: v }))}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select source" />
                            </SelectTrigger>
                            <SelectContent>
                                {LEAD_SOURCES.map((source) => (
                                    <SelectItem key={source.value} value={source.value}>
                                        {source.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="interested_in">Interested In</Label>
                            <div className="relative">
                                <Target className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    id="interested_in"
                                    placeholder="e.g., SUV, Sedan"
                                    className="pl-9"
                                    value={formData.interested_in}
                                    onChange={(e) =>
                                        setFormData((prev) => ({ ...prev, interested_in: e.target.value }))
                                    }
                                />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="budget_range">Budget Range</Label>
                            <Input
                                id="budget_range"
                                placeholder="e.g., $20k - $30k"
                                value={formData.budget_range}
                                onChange={(e) => setFormData((prev) => ({ ...prev, budget_range: e.target.value }))}
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="notes">Notes</Label>
                        <Textarea
                            id="notes"
                            placeholder="Additional information about this lead..."
                            rows={3}
                            value={formData.notes}
                            onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                        />
                    </div>

                    {error ? (
                        <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-lg">{error}</div>
                    ) : null}

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={handleClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={isLoading || (isBdc && !orgDealershipId)}
                        >
                            {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                            Create Lead
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
