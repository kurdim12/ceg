import type { PlacesAdapter, SourcedBusiness } from './types'

interface PlacesTextSearchResponse {
  places?: Array<{
    displayName?: { text?: string }
    websiteUri?: string
    internationalPhoneNumber?: string
    formattedAddress?: string
    addressComponents?: Array<{ types?: string[]; longText?: string; shortText?: string }>
  }>
}

function componentOf(
  components: NonNullable<PlacesTextSearchResponse['places']>[number]['addressComponents'],
  type: string,
): string | null {
  const hit = components?.find((c) => c.types?.includes(type))
  return hit?.longText ?? hit?.shortText ?? null
}

/** Google Places API (New) text search. Places never returns emails — the crawler does that. */
export function placesAdapter(apiKey: string, fetcher = fetch): PlacesAdapter {
  return {
    async searchBusinesses({ geo, businessType, count }) {
      const res = await fetcher('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': [
            'places.displayName',
            'places.websiteUri',
            'places.internationalPhoneNumber',
            'places.formattedAddress',
            'places.addressComponents',
          ].join(','),
        },
        body: JSON.stringify({
          textQuery: `${businessType} in ${geo}`,
          pageSize: Math.min(count, 20),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) {
        throw new Error(`Places search failed: ${res.status}`)
      }
      const body = (await res.json()) as PlacesTextSearchResponse
      const results: SourcedBusiness[] = []
      for (const place of body.places ?? []) {
        results.push({
          name: place.displayName?.text ?? 'Unknown business',
          website: place.websiteUri ?? null,
          phone: place.internationalPhoneNumber ?? null,
          address: place.formattedAddress ?? null,
          city: componentOf(place.addressComponents, 'locality') ?? geo,
          country: componentOf(place.addressComponents, 'country'),
        })
      }
      return results.slice(0, count)
    },
  }
}
