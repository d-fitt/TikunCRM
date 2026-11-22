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

export default function LeadDeliveryEmailPage() {
    const { isSuperAdmin } = useRole()
    const { toast } = useToast()
    const [loading, setLoading] = React.useState(true)
    const [saving, setSaving] = React.useState(false)
    const [testing, setTesting] = React.useState(false)
    const [mailbox, setMailbox] = React.useState<LeadDeliveryMailbox | null>(null)
    const [email, setEmail] = React.useState("leads@carvamonos.com")
    const [fromName, setFromName] = React.useState("Carvamonos")
    const [tenantId, setTenantId] = React.useState("")
    const [clientId, setClientId] = React.useState("")
    const [clientSecret, setClientSecret] = React.useState("")
    const [testTo, setTestTo] = React.useState("")

    React.useEffect(() => {
        if (!isSuperAdmin) {
            setLoading(false)
            return
        }
        LeadDeliveryEmailService.get()
            .then((row) => {
                setMailbox(row)
                setEmail(row.smtp_user || row.active_email || "leads@carvamonos.com")
                setFromName(row.from_name || "Carvamonos")
                setTenantId(row.graph_tenant_id || "")
                setClientId(row.graph_client_id || "")
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
                from_name: fromName.trim() || "Carvamonos",
                graph_tenant_id: tenantId.trim(),
                graph_client_id: clientId.trim(),
                graph_client_secret: clientSecret.trim() || undefined,
            })
            setMailbox(row)
            setClientSecret("")
            setTestTo(row.smtp_user)
            toast({ title: "Lead delivery app saved" })
        } catch (err: unknown) {
            toast({ title: "Could not save the mailbox", description: errorDetail(err), variant: "destructive" })
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

    const usingGraph = mailbox?.send_mode === "graph"

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
                    Leads go out through Microsoft Graph as this mailbox. TikunCRM asks Microsoft for a new send token when the last one expires. Security defaults stays on.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Microsoft app</CardTitle>
                    <CardDescription>
                        {usingGraph
                            ? `Leads go out from ${mailbox?.active_email} with the saved app.`
                            : "Paste the tenant ID, client ID, and client secret from the app registration. The secret is shown only once."}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    ) : (
                        <form className="space-y-4" onSubmit={save}>
                            <div className="space-y-2">
                                <Label htmlFor="mailbox">Send as</Label>
                                <Input
                                    id="mailbox"
                                    type="email"
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    placeholder="leads@carvamonos.com"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="from-name">Name on the email</Label>
                                <Input id="from-name" value={fromName} onChange={(event) => setFromName(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="tenant-id">Tenant ID</Label>
                                <Input
                                    id="tenant-id"
                                    value={tenantId}
                                    onChange={(event) => setTenantId(event.target.value)}
                                    placeholder="Directory (tenant) ID"
                                    autoComplete="off"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="client-id">Client ID</Label>
                                <Input
                                    id="client-id"
                                    value={clientId}
                                    onChange={(event) => setClientId(event.target.value)}
                                    placeholder="Application (client) ID"
                                    autoComplete="off"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="client-secret">Client secret</Label>
                                <Input
                                    id="client-secret"
                                    type="password"
                                    value={clientSecret}
                                    onChange={(event) => setClientSecret(event.target.value)}
                                    placeholder={mailbox?.has_graph_secret ? "Leave blank to keep the saved secret" : "Secret value"}
                                    autoComplete="new-password"
                                />
                                <p className="text-xs text-muted-foreground">
                                    The hourly send token is renewed by TikunCRM. The client secret itself lasts until the date chosen in Microsoft, at most 24 months. Paste a new secret here when that date arrives.
                                </p>
                            </div>
                            <Button type="submit" disabled={saving}>
                                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Save app
                            </Button>
                        </form>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Send a test</CardTitle>
                    <CardDescription>Confirms the app can send as this mailbox. Save first, then send the test.</CardDescription>
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
