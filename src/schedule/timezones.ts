/**
 * Universal city → timezone resolution without a bundled dataset:
 * 1. Exact IANA city-name match ("Warsaw" → Europe/Warsaw, "New York" →
 *    America/New_York) against the runtime's own zone list.
 * 2. Country default for the rest (approximate in multi-zone countries —
 *    good enough for a send window; the lead's zone is owner-editable).
 * 3. null when neither works: fail-safe, the lead never enters a window
 *    until a human sets its timezone.
 */

const COUNTRY_DEFAULTS: Record<string, string> = {
  US: 'America/Chicago', CA: 'America/Toronto', MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo', AR: 'America/Argentina/Buenos_Aires', CO: 'America/Bogota',
  CL: 'America/Santiago', PE: 'America/Lima',
  GB: 'Europe/London', IE: 'Europe/Dublin', FR: 'Europe/Paris', DE: 'Europe/Berlin',
  ES: 'Europe/Madrid', PT: 'Europe/Lisbon', IT: 'Europe/Rome', NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels', CH: 'Europe/Zurich', AT: 'Europe/Vienna', PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague', SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki', GR: 'Europe/Athens', RO: 'Europe/Bucharest', UA: 'Europe/Kyiv',
  TR: 'Europe/Istanbul', RU: 'Europe/Moscow',
  JO: 'Asia/Amman', SA: 'Asia/Riyadh', AE: 'Asia/Dubai', QA: 'Asia/Qatar',
  KW: 'Asia/Kuwait', IL: 'Asia/Jerusalem', LB: 'Asia/Beirut', EG: 'Africa/Cairo',
  MA: 'Africa/Casablanca', TN: 'Africa/Tunis', NG: 'Africa/Lagos', KE: 'Africa/Nairobi',
  ZA: 'Africa/Johannesburg', GH: 'Africa/Accra', ET: 'Africa/Addis_Ababa',
  IN: 'Asia/Kolkata', PK: 'Asia/Karachi', BD: 'Asia/Dhaka', LK: 'Asia/Colombo',
  NP: 'Asia/Kathmandu', CN: 'Asia/Shanghai', JP: 'Asia/Tokyo', KR: 'Asia/Seoul',
  TW: 'Asia/Taipei', HK: 'Asia/Hong_Kong', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur',
  ID: 'Asia/Jakarta', PH: 'Asia/Manila', VN: 'Asia/Ho_Chi_Minh', TH: 'Asia/Bangkok',
  MM: 'Asia/Yangon', KH: 'Asia/Phnom_Penh', LA: 'Asia/Vientiane',
  AU: 'Australia/Sydney', NZ: 'Pacific/Auckland',
}

let zonesByCity: Map<string, string> | null = null

function cityIndex(): Map<string, string> {
  if (zonesByCity) return zonesByCity
  zonesByCity = new Map()
  for (const zone of Intl.supportedValuesOf('timeZone')) {
    const city = zone.split('/').pop()
    if (city) zonesByCity.set(city.toLowerCase(), zone)
  }
  return zonesByCity
}

export function resolveTimezone(city: string | null, country: string | null): string | null {
  if (city) {
    const key = city.trim().toLowerCase().replaceAll(' ', '_')
    const match = cityIndex().get(key)
    if (match) return match
  }
  if (country) {
    const byCountry = COUNTRY_DEFAULTS[country.trim().toUpperCase()]
    if (byCountry) return byCountry
  }
  return null
}
