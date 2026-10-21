// Mock mode runs the UI against an in-memory fake API: `?mock` in the URL or
// VITE_MOCK=1 at build/dev time.
export const isMock = import.meta.env.VITE_MOCK === '1' || new URLSearchParams(location.search).has('mock')
