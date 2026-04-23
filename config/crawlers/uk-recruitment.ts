export const UK_RECRUITMENT_CRAWL = {
  searchTerms: [
    "recruitment agency",
    "recruitment consultancy",
    "staffing agency",
    "executive search firm",
    "talent acquisition agency",
    "headhunter",
  ],
  cities: [
    { name: "London", lat: 51.5074, lng: -0.1278 },
    { name: "Manchester", lat: 53.4808, lng: -2.2426 },
    { name: "Birmingham", lat: 52.4862, lng: -1.8904 },
    { name: "Leeds", lat: 53.8008, lng: -1.5491 },
    { name: "Bristol", lat: 51.4545, lng: -2.5879 },
    { name: "Edinburgh", lat: 55.9533, lng: -3.1883 },
    { name: "Glasgow", lat: 55.8642, lng: -4.2518 },
    { name: "Liverpool", lat: 53.4084, lng: -2.9916 },
    { name: "Reading", lat: 51.4543, lng: -0.9781 },
    { name: "Cambridge", lat: 52.2053, lng: 0.1218 },
  ],
  radiusMeters: 15000,
  maxResultsPerQuery: 60,
  source: "google_places",
} as const;

export type CrawlCity = (typeof UK_RECRUITMENT_CRAWL.cities)[number];
