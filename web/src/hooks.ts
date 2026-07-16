import { useMemo } from 'react'
import { applyFilters, computeView, sortRows, type LeadView } from './compute'
import { useDesk } from './store'

/** Every lead, view-computed against current settings and "now". */
export function useViews(): LeadView[] {
  const { st } = useDesk()
  return useMemo(
    () => (st.settings ? st.leads.map((l) => computeView(l, st.settings!, st.now)) : []),
    [st.leads, st.settings, st.now],
  )
}

/** Views under the active filters + search. */
export function useFiltered(views: LeadView[]): LeadView[] {
  const { st } = useDesk()
  return useMemo(
    () => applyFilters(views, st.filters, st.search, st.now),
    [views, st.filters, st.search, st.now],
  )
}

/** Filtered and sorted (leads table order). */
export function useSorted(filtered: LeadView[]): LeadView[] {
  const { st } = useDesk()
  return useMemo(
    () => (st.settings ? sortRows(filtered, st.sort, st.settings) : filtered),
    [filtered, st.sort, st.settings],
  )
}

/** Owner display options: 'Unassigned' + team member names. */
export function useOwnerOpts(): { names: string[]; idFor: (name: string) => string | null } {
  const { st } = useDesk()
  return useMemo(() => {
    const names = ['Unassigned', ...st.users.map((u) => u.name)]
    const idFor = (name: string): string | null => st.users.find((u) => u.name === name)?.id ?? null
    return { names, idFor }
  }, [st.users])
}
