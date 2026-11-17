"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeft, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { useRole } from "@/hooks/use-role"
import { LeadDeliveryEmailService, type LeadDeliveryMailbox } from "@/services/lead-delivery-email-service"

function providerFor(host: string): "microsoft365" | "outlook" {
    return host === "smtp-mail.outlook.com" ? "outlook" : "microsoft365"
}

export default function LeadDeliveryEmailPage() {
    const { isSuperAdmin } = useRole()
    const { toast } = useToast()
    const [loading, setLoading] = React.useState(true)
    const [saving, setSaving] = React.useState(false)
    const [testing, setTesting] = React.useState(false)
    const [mailbox, setMailbox] = React.useState<LeadDeliveryMailbox | null>(null)
    const [email, setEmail] = React.useState("")
    const [password, setPassword] = React.useState("")
    const [fromName, setFromName] = React.useState("Carvaminos")
    const [provider, setProvider] = React.useState<"microsoft365" | "outlook">("microsoft365")
    const [testTo, setTestTo] = React.useState("")

    React.useEffect(() => {
        if (!isSuperAdmin) {
            setLoading(false)
            return
        }
        LeadDeliveryEmailService.get()
            .then((row) => {
                setMailbox(row)
                setEmail(row.smtp_user || row.active_email || "")
                setFromName(row.from_name || "Carvaminos")
                setProvider(providerFor(row.smtp_host))
                setTestTo(row.smtp_user || row.active_email || "")
            })
            .catch(() => {
                toast({ title: "Could not load the mailbox", variant: "destructive" })
            })
            .finally(() => setLoading(false))
    }, [isSuperAdmin, toast])

    async function save(event: React.FormEvent) {
        event.preventDefault()
        setSaving(true)
        try {
            const row = await LeadDeliveryEmailService.save({
                smtp_user: email.trim(),
                password: password.trim() || undefined,
                from_name: fromName.trim() || "Carvaminos",
                provider,
            })
            setMailbox(row)
            setPassword("")
            setTestTo(row.smtp_user)
            toast({ title: "Lead delivery mailbox saved" })
        } catch (err: unknown) {
            const detail = errorDetail(err)
            toast({ title: "Could not save the mailbox", description: detail, variant: "destructive" })
        } finally {
            setSaving(false)
        }
    }

    async function sendTest() {
        setTesting(true)
        try {
            await LeadDeliveryEmailService.test(testTo.trim())
            toast({ title: `Test sent to ${testTo.trim()}` })
        } catch (err: unknown) {
            toast({
                title: "Test was not sent",
                description: errorDetail(err),
                variant: "destructive",
            })
        } finally {
            setTesting(false)
        }
    }

    if (!isSuperAdmin) {
        return <p className="text-sm text-muted-foreground">Only a super admin can change this mailbox.</p>
    }

    return (
        <div className="mx-auto max-w-2xl space-y-6">
            <div>
                <Button variant="ghost" size="sm" className="-ml-2 mb-2" asChild>
                    <Link href="/settings">
                        <ArrowLeft className="mr-1 h-4 w-4" />
                        Settings
                    </Link>
                </Button>
                <h1 className="text-2xl font-bold">Lead delivery email</h1>
                <p className="text-muted-foreground">
                    This Microsoft mailbox sends a lead to a partner store. TikunCRM notifications stay on the other mailbox.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Sending mailbox</CardTitle>
                    <CardDescription>
                        {mailbox?.source === "portal"
                            ? `Leads go out from ${mailbox.active_email}.`
                            : mailbox?.source === "server"
                                ? `Leads currently go out from the server mailbox ${mailbox.active_email}. Save here to replace it.`
                                : "No mailbox is set yet. Leads are saved, and the store email waits until this is filled in."}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    ) : (
                        <form className="space-y-4" onSubmit={save}>
                            <div className="space-y-2">
                                <Label htmlFor="provider">Microsoft account</Label>
                                <select
                                    id="provider"
                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                                    value={provider}
                                    onChange={(event) => setProvider(event.target.value as "microsoft365" | "outlook")}
                                >
                                    <option value="microsoft365">Microsoft 365 work mailbox</option>
                                    <option value="outlook">Outlook, Hotmail, or Live</option>
                                </select>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="from-name">Name on the email</Label>
                                <Input id="from-name" value={fromName} onChange={(event) => setFromName(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="mailbox">Mailbox address</Label>
                                <Input
                                    id="mailbox"
                                    type="email"
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    placeholder="leads@yourcompany.com"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="password">Password</Label>
                                <Input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    placeholder={mailbox?.has_password ? "Leave blank to keep the saved password" : "Mailbox or app password"}
                                    autoComplete="new-password"
                                />
                                <p className="text-xs text-muted-foreground">
                                    SMTP sending must be turned on for this mailbox. Use an app password when the account has multi-factor authentication.
                                </p>
                            </div>
                            <Button type="submit" disabled={saving}>
                                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Save mailbox
                            </Button>
                        </form>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Send a test</CardTitle>
                    <CardDescription>Confirms the saved mailbox can send. Save first, then send the test.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 sm:flex-row">
                    <Input
                        type="email"
                        value={testTo}
                        onChange={(event) => setTestTo(event.target.value)}
                        placeholder="you@company.com"
                    />
                    <Button type="button" variant="outline" onClick={sendTest} disabled={testing || !testTo.trim()}>
                        {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Send test
                    </Button>
                </CardContent>
            </Card>
        </div>
    )
}

function errorDetail(err: unknown): string {
    if (err && typeof err === "object" && "response" in err) {
        const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
        if (typeof detail === "string") return detail
    }
    return "Please try again."
}
