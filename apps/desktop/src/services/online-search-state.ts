import { reactive } from 'vue'
import type { OnlineSearchHit, SearchEngine } from './online-search'

// Keep navigation context in memory; no queries or page contents are written to disk.
export const onlineSearchSession = reactive({
  query: '', pages: [] as OnlineSearchHit[][], page: 1, searched: false, preview: false,
  pendingHits: [] as OnlineSearchHit[],
  cursor: undefined as string | undefined, submittedQuery: '', engine: 'bing' as SearchEngine,
  scrollTop: 0, failures: {} as Record<string, string>, recent: [] as string[]
})
