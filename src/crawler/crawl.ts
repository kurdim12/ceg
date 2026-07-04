import type { SiteFetcher } from '../adapters/types'
import { contactPageUrls } from '../adapters/crawler'
import { extractEmails } from './extract'

/**
 * Crawl strategy (map §4, load-bearing): homepage first; if it yields no
 * addresses, up to two same-host contact-ish pages. Never leaves the
 * lead's own domain.
 */
export async function crawlForEmails(
  fetcher: SiteFetcher,
  website: string,
  limit = 3,
): Promise<string[]> {
  const home = await fetcher.fetchPage(website)
  if (!home) return []
  const fromHome = extractEmails(home, limit)
  if (fromHome.length > 0) return fromHome

  const found = new Set<string>()
  for (const url of contactPageUrls(home, website)) {
    const page = await fetcher.fetchPage(url)
    if (!page) continue
    for (const email of extractEmails(page, limit)) found.add(email)
    if (found.size >= limit) break
  }
  return [...found].slice(0, limit)
}
