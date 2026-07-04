const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// Common false positives on business sites: asset filenames and
// placeholder domains that match the email pattern.
const JUNK_PATTERNS = [
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /@(example|sentry|wixpress)\./i,
  /^(noreply|no-reply|donotreply)@/i,
]

/** Extracts candidate contact emails from page HTML, deduped, capped. */
export function extractEmails(html: string, limit = 10): string[] {
  const found = new Set<string>()
  // mailto: links are the strongest signal — take them first.
  for (const match of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    const email = match[1]?.toLowerCase().trim()
    if (email && EMAIL_RE.test(email)) found.add(email)
    EMAIL_RE.lastIndex = 0
  }
  for (const match of html.matchAll(EMAIL_RE)) {
    found.add(match[0].toLowerCase())
  }
  return [...found]
    .filter((email) => !JUNK_PATTERNS.some((re) => re.test(email)))
    .slice(0, limit)
}

/** Dedupe key for companies (map §4: dedupe by domain, deployed — keep). */
export function domainOf(website: string | null): string | null {
  if (!website) return null
  try {
    const url = new URL(website.startsWith('http') ? website : `https://${website}`)
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}
