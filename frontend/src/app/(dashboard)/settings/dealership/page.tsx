"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
    ArrowLeft,
    Building2,
    Loader2,
    CheckCircle2,
    Globe,
    Phone,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { TimezonePicker } from "@/components/ui/timezone-picker"
import { TwilioConfigModal } from "@/components/settings/twilio-config-modal"
import { DealershipService, Dealership } from "@/services/dealership-service"
import { useRole } from "@/hooks/use-role"
import { useOrgDealershipId } from "@/hooks/use-org-dealership"
import { clearDealershipTimezoneCache } from "@/hooks/use-dealership-timezone"

export default function CompanySettingsPage() {
    const router = useRouter()
    const orgDealershipId = useOrgDealershipId()
    const { isDealershipAdmin, isSuperAdmin } = useRole()
    
    const [isLoading, setIsLoading] = React.useState(true)
    const [isSaving, setIsSaving] = React.useState(false)
    const [dealership, setDealership] = React.useState<Dealership | null>(null)
    const [timezone, setTimezone] = React.useState<string>("UTC")
    const [error, setError] = React.useState<string | null>(null)
    const [successMessage, setSuccessMessage] = React.useState<string | null>(null)
    const [twilioOpen, setTwilioOpen] = React.useState(false)
    
    // Load dealership settings
    React.useEffect(() => {
        const loadDealership = async () => {
            const dealershipId = orgDealershipId
            if (!dealershipId) {
                setIsLoading(false)
                return
            }
            
            setIsLoading(true)
            try {
                const data = await DealershipService.getDealership(dealershipId)
                setDealership(data)
                setTimezone(data.timezone || "UTC")
            } catch (err: any) {
                console.error("Failed to load company settings:", err)
                setError(err?.response?.data?.detail || "Failed to load company settings")
            } finally {
                setIsLoading(false)
            }
        }
        
        loadDealership()
    }, [orgDealershipId])
    
    const handleSave = async () => {
        if (!dealership || !orgDealershipId) return
        
        setIsSaving(true)
        setError(null)
        setSuccessMessage(null)
        
        try {
            const updated = await DealershipService.updateDealership(dealership.id, {
                timezone,
            })
            setDealership(updated)
            // Clear timezone cache so hook will refetch the new timezone
            clearDealershipTimezoneCache(dealership.id)
            setSuccessMessage("Company settings saved successfully!")
        } catch (err: any) {
            setError(err?.response?.data?.detail || "Failed to save settings")
        } finally {
            setIsSaving(false)
        }
    }
    
    if (!isDealershipAdmin && !isSuperAdmin) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <div className="text-center">
                    <p className="text-muted-foreground">You don't have permission to access this page.</p>
                </div>
            </div>
        )
    }
    
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        )
    }
    
    if (!dealership) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <div className="text-center">
                    <p className="text-muted-foreground">Company settings not found.</p>
                </div>
            </div>
        )
    }
    
    return (
        <div className="space-y-6 max-w-2xl">
            {/* Header */}
            <div className="flex items-center gap-4">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => router.push("/settings")}
                >
                    <ArrowLeft className="h-5 w-5" />
                </Button>
                <div className="flex-1">
                    <h1 className="text-2xl font-bold">Company Settings</h1>
                    <p className="text-muted-foreground">
                        Timezone and phone/messaging setup for Carvaminos
                    </p>
                </div>
            </div>
            
            {/* Messages */}
            {error && (
                <Card className="border-red-200 bg-red-50">
                    <CardContent className="py-3 flex items-center gap-2 text-red-800">
                        <CheckCircle2 className="h-4 w-4" />
                        {error}
                    </CardContent>
                </Card>
            )}
            
            {successMessage && (
                <Card className="border-green-200 bg-green-50">
                    <CardContent className="py-3 flex items-center gap-2 text-green-800">
                        <CheckCircle2 className="h-4 w-4" />
                        {successMessage}
                    </CardContent>
                </Card>
            )}
            
            {/* Timezone Settings */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Globe className="h-5 w-5" />
                        Timezone Configuration
                    </CardTitle>
                    <CardDescription>
                        Appointment and follow-up times use this timezone for everyone on the team.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="timezone">Company Timezone</Label>
                        <TimezonePicker
                            value={timezone}
                            onChange={setTimezone}
                            placeholder="Search and select timezone..."
                        />
                        <p className="text-xs text-muted-foreground">
                            This timezone is the single source of truth for appointment times
                            across the CRM, guest QR, and share previews.
                        </p>
                    </div>
                    
                    <div className="flex justify-end pt-4 border-t">
                        <Button onClick={handleSave} disabled={isSaving}>
                            {isSaving ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                "Save Settings"
                            )}
                        </Button>
                    </div>
                </CardContent>
            </Card>
            
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Phone className="h-5 w-5" />
                        Phone, SMS &amp; WhatsApp (Twilio)
                    </CardTitle>
                    <CardDescription>
                        Twilio account, sending numbers, and softphone settings used for calls, texts and WhatsApp.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button variant="outline" onClick={() => setTwilioOpen(true)}>
                        Configure Twilio
                    </Button>
                </CardContent>
            </Card>

            {/* Info Card */}
            <Card className="border-blue-200 bg-blue-50/50">
                <CardContent className="pt-6">
                    <div className="flex gap-3">
                        <Building2 className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
                        <div className="text-sm text-blue-900">
                            <p className="font-medium mb-2">How timezone affects your CRM:</p>
                            <ul className="list-disc list-inside space-y-1 text-blue-800">
                                <li>All notification timestamps will show in the company timezone</li>
                                <li>Lead creation dates and activity logs use this timezone</li>
                                <li>Follow-up reminders and schedules are based on this timezone</li>
                                <li>Everyone on the team sees times in this timezone</li>
                            </ul>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <TwilioConfigModal
                open={twilioOpen}
                onOpenChange={setTwilioOpen}
                dealershipId={dealership.id}
                dealershipName={dealership.name}
            />
        </div>
    )
}
