"use client"

import * as React from "react"
import { useOrgDealershipId } from "@/hooks/use-org-dealership"

export type BdcDealershipOption = {
    id: string
    name: string
}

type BdcDealershipContextValue = {
    dealerships: BdcDealershipOption[]
    selectedDealershipId: string | null
    setSelectedDealershipId: (id: string | null) => void
    selectedDealershipName: string
    isLoading: boolean
}

const COMPANY_NAME = "Carvaminos"

const BdcDealershipContext = React.createContext<BdcDealershipContextValue | null>(null)

/**
 * The one company everyone works in. Kept as a context so the softphone and
 * reports can read the company id the same way they always have.
 */
export function BdcDealershipProvider({ children }: { children: React.ReactNode }) {
    const orgDealershipId = useOrgDealershipId()

    const value = React.useMemo<BdcDealershipContextValue>(
        () => ({
            dealerships: orgDealershipId ? [{ id: orgDealershipId, name: COMPANY_NAME }] : [],
            selectedDealershipId: orgDealershipId ?? null,
            setSelectedDealershipId: () => {},
            selectedDealershipName: COMPANY_NAME,
            isLoading: false,
        }),
        [orgDealershipId]
    )

    return (
        <BdcDealershipContext.Provider value={value}>
            {children}
        </BdcDealershipContext.Provider>
    )
}

export function useBdcDealership(): BdcDealershipContextValue {
    const ctx = React.useContext(BdcDealershipContext)
    if (!ctx) {
        return {
            dealerships: [],
            selectedDealershipId: null,
            setSelectedDealershipId: () => {},
            selectedDealershipName: COMPANY_NAME,
            isLoading: false,
        }
    }
    return ctx
}

export function useBdcDealershipOptional() {
    return React.useContext(BdcDealershipContext)
}
