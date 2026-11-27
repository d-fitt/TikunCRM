"use client"

import * as React from "react"
import { Loader2, UserPlus, Mail, Phone, Shield, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { UserService } from "@/services/user-service"
import { getApiErrorMessage } from "@/lib/api-errors"
import { useRole } from "@/hooks/use-role"

interface CreateUserModalProps {
    isOpen: boolean
    onClose: () => void
    onSuccess?: () => void
}

const MANAGER_ROLE_OPTIONS = [
    { value: "bdc", label: "BDC Agent" },
]

const SUPER_ADMIN_ROLE_OPTIONS = [
    { value: "bdc", label: "BDC Agent" },
    { value: "dealership_admin", label: "Manager" },
    { value: "super_admin", label: "Super Admin" },
]

const EMPTY_FORM = {
    email: "",
    password: "",
    first_name: "",
    last_name: "",
    phone: "",
    role: "bdc",
    hourly_rate: "",
}

export function CreateUserModal({ isOpen, onClose, onSuccess }: CreateUserModalProps) {
    const { isSuperAdmin } = useRole()
    const [isLoading, setIsLoading] = React.useState(false)
    const [error, setError] = React.useState("")
    const [showPassword, setShowPassword] = React.useState(false)
    const [formData, setFormData] = React.useState(EMPTY_FORM)

    const resetForm = () => {
        setFormData(EMPTY_FORM)
        setError("")
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()

        if (!formData.email.trim()) {
            setError("Email is required")
            return
        }

        if (!formData.password || formData.password.length < 6) {
            setError("Password must be at least 6 characters")
            return
        }

        if (!formData.first_name.trim()) {
            setError("First name is required")
            return
        }

        setIsLoading(true)
        setError("")

        try {
            const payload: Record<string, unknown> = { ...formData }
            if (formData.role === "bdc") {
                const rate = Number(formData.hourly_rate)
                payload.hourly_rate = Number.isFinite(rate) && rate > 0 ? rate : null
            } else {
                delete payload.hourly_rate
            }
            await UserService.createUser(payload)
            resetForm()
            onSuccess?.()
            onClose()
        } catch (err: any) {
            console.error("Failed to create user:", err)
            setError(getApiErrorMessage(err, "Failed to create user. Please try again."))
        } finally {
            setIsLoading(false)
        }
    }

    const handleClose = () => {
        resetForm()
        onClose()
    }

    const roleOptions = isSuperAdmin ? SUPER_ADMIN_ROLE_OPTIONS : MANAGER_ROLE_OPTIONS

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <UserPlus className="h-5 w-5" />
                        Add Team Member
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Name Row */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="first_name">First Name *</Label>
                            <Input
                                id="first_name"
                                placeholder="John"
                                value={formData.first_name}
                                onChange={(e) => setFormData(prev => ({ ...prev, first_name: e.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="last_name">Last Name</Label>
                            <Input
                                id="last_name"
                                placeholder="Doe"
                                value={formData.last_name}
                                onChange={(e) => setFormData(prev => ({ ...prev, last_name: e.target.value }))}
                            />
                        </div>
                    </div>

                    {/* Email */}
                    <div className="space-y-2">
                        <Label htmlFor="email">Email *</Label>
                        <div className="relative">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="email"
                                type="email"
                                placeholder="john@carvaminos.com"
                                className="pl-9"
                                value={formData.email}
                                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                            />
                        </div>
                    </div>

                    {/* Password */}
                    <div className="space-y-2">
                        <Label htmlFor="password">Password *</Label>
                        <div className="relative">
                            <Input
                                id="password"
                                type={showPassword ? "text" : "password"}
                                placeholder="Min 6 characters"
                                value={formData.password}
                                onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                                className="pr-10"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                tabIndex={-1}
                            >
                                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                        </div>
                    </div>

                    {/* Phone */}
                    <div className="space-y-2">
                        <Label htmlFor="phone">Phone</Label>
                        <div className="relative">
                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="phone"
                                placeholder="+1 234 567 8900"
                                className="pl-9"
                                value={formData.phone}
                                onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                            />
                        </div>
                    </div>

                    {/* Role */}
                    <div className="space-y-2">
                        <Label htmlFor="role">Role *</Label>
                        <div className="relative">
                            <Shield className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground z-10" />
                            <Select
                                value={formData.role}
                                onValueChange={(v) => setFormData(prev => ({ ...prev, role: v }))}
                            >
                                <SelectTrigger className="pl-9">
                                    <SelectValue placeholder="Select role" />
                                </SelectTrigger>
                                <SelectContent>
                                    {roleOptions.map((role) => (
                                        <SelectItem key={role.value} value={role.value}>
                                            {role.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    {formData.role === "bdc" && isSuperAdmin && (
                        <div className="space-y-2">
                            <Label htmlFor="hourly_rate">Hourly rate (USD)</Label>
                            <Input
                                id="hourly_rate"
                                type="number"
                                min={0}
                                step="0.01"
                                placeholder="20.00"
                                value={formData.hourly_rate}
                                onChange={(e) => setFormData((prev) => ({ ...prev, hourly_rate: e.target.value }))}
                            />
                            <p className="text-xs text-muted-foreground">
                                Used for Time &amp; Pay. You can also set this later from Team or Time &amp; Pay.
                            </p>
                        </div>
                    )}

                    {/* Error */}
                    {error && (
                        <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-lg">
                            {error}
                        </div>
                    )}

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={handleClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isLoading}>
                            {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                            Create User
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
