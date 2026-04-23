// Places API (New) Text Search.
//
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
//
// Field mask is mandatory — Google bills by SKU tier and the mask decides
// which tiers get charged. Keep this tight; every extra field is money.
// Mask stays in sync with the PlaceResult shape below.

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.types",
  "places.rating",
  "places.userRatingCount",
  "nextPageToken",
].join(",");

const PAGE_SIZE = 20;
const MAX_PAGES = 3; // API hard cap: 60 results per text query
const MAX_RETRIES = 4;

export type PlaceResult = {
  placeId: string;
  name: string;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  types: string[];
  rating: number | null;
  userRatingCount: number;
  raw: Record<string, unknown>;
};

type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  types?: string[];
  rating?: number;
  userRatingCount?: number;
};

type RawResponse = {
  places?: RawPlace[];
  nextPageToken?: string;
  error?: { message?: string; status?: string; code?: number };
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function fromComponents(
  components: RawPlace["addressComponents"],
): { city: string | null; country: string | null } {
  if (!components) return { city: null, country: null };
  const by = (type: string) =>
    components.find((c) => c.types?.includes(type));
  const city =
    by("postal_town")?.longText ??
    by("locality")?.longText ??
    by("administrative_area_level_2")?.longText ??
    null;
  const country = by("country")?.shortText ?? null;
  return { city, country };
}

function normalize(raw: RawPlace): PlaceResult | null {
  if (!raw.id || !raw.displayName?.text) return null;
  const { city, country } = fromComponents(raw.addressComponents);
  return {
    placeId: raw.id,
    name: raw.displayName.text,
    website: raw.websiteUri ?? null,
    phone: raw.nationalPhoneNumber ?? null,
    address: raw.formattedAddress ?? null,
    city,
    country,
    types: raw.types ?? [],
    rating: raw.rating ?? null,
    userRatingCount: raw.userRatingCount ?? 0,
    raw: raw as unknown as Record<string, unknown>,
  };
}

async function fetchPage(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<RawResponse> {
  let attempt = 0;
  while (true) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      return (await res.json()) as RawResponse;
    }

    const retryable = res.status === 429 || res.status >= 500;
    const text = await res.text().catch(() => "");
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(
        `Places API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      );
    }
    const backoffMs = Math.min(2 ** attempt * 1000, 16000);
    await sleep(backoffMs);
    attempt++;
  }
}

export async function searchPlaces(
  query: string,
  location: { lat: number; lng: number },
  radiusMeters: number,
): Promise<PlaceResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not set");
  }

  const baseBody = {
    textQuery: query,
    pageSize: PAGE_SIZE,
    locationBias: {
      circle: {
        center: { latitude: location.lat, longitude: location.lng },
        radius: radiusMeters,
      },
    },
  };

  const out: PlaceResult[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = pageToken
      ? { ...baseBody, pageToken }
      : baseBody;

    const data = await fetchPage(apiKey, body);

    for (const p of data.places ?? []) {
      const normalized = normalize(p);
      if (normalized) out.push(normalized);
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    // The API needs a brief moment before a page token becomes valid.
    await sleep(1500);
  }

  return out;
}
