import type { OsmSuggestion, RateRow } from "../types";
import { normalizeText } from "../utils/normalize";

const stateNameToCode: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

const toStateCode = (value?: string): string | undefined => {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return stateNameToCode[normalizeText(trimmed)] ?? undefined;
};

type NominatimItem = {
  place_id: number;
  display_name: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
    state?: string;
  };
};

let cachedRateSuggestions: OsmSuggestion[] | null = null;

const getRateSuggestions = async (): Promise<OsmSuggestion[]> => {
  if (cachedRateSuggestions) return cachedRateSuggestions;

  const response = await fetch(`${import.meta.env.BASE_URL}fy2026_master.json`);
  if (!response.ok) {
    cachedRateSuggestions = [];
    return cachedRateSuggestions;
  }

  const rows = (await response.json()) as RateRow[];
  const seen = new Set<string>();
  cachedRateSuggestions = rows.reduce<OsmSuggestion[]>((items, row) => {
    const key = `${row.destination}|${row.state}`;
    if (seen.has(key)) return items;
    seen.add(key);

    items.push({
      id: `gsa-${row.state}-${row.destination}`,
      city: row.destination,
      stateCode: row.state,
      county: row.county,
      display: `${row.destination}, ${row.state}${row.county ? ` - ${row.county} County` : ""}`,
    });
    return items;
  }, []);

  return cachedRateSuggestions;
};

const localCityMatches = async (query: string): Promise<OsmSuggestion[]> => {
  const q = normalizeText(query);
  const compactQuery = q.replace(/\s/g, "");
  const suggestions = await getRateSuggestions();

  return suggestions
    .filter((item) => {
      const city = normalizeText(item.city);
      const compactCity = city.replace(/\s/g, "");
      const display = normalizeText(item.display);
      return city.startsWith(q) || compactCity.startsWith(compactQuery) || display.includes(q);
    })
    .slice(0, 5);
};

const dedupeSuggestions = (items: OsmSuggestion[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${normalizeText(item.city)}|${item.stateCode ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const searchOsmPlaces = async (query: string, signal?: AbortSignal): Promise<OsmSuggestion[]> => {
  const q = query.trim();
  if (q.length < 3) return [];

  const localMatches = await localCityMatches(q);
  if (signal?.aborted) return [];

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=us&limit=5&q=${encodeURIComponent(q)}`;
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } }).catch((error) => {
    if (signal?.aborted) throw error;
    return null;
  });
  if (!response) return localMatches;
  if (!response.ok) return localMatches;

  const payload = (await response.json()) as NominatimItem[];
  const osmMatches = payload.map((item) => {
    const city =
      item.address?.city || item.address?.town || item.address?.village || item.address?.municipality || "";
    const stateCode = toStateCode(item.address?.state);
    return {
      id: String(item.place_id),
      city,
      stateCode,
      county: item.address?.county,
      display: item.display_name,
    };
  });

  return dedupeSuggestions([...localMatches, ...osmMatches]).slice(0, 6);
};
