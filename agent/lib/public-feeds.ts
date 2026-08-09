export const PUBLIC_FEED_CATEGORIES = [
  "company",
  "sec",
  "macro",
  "antitrust",
  "banking",
  "commodities",
  "consumer-finance",
  "consumer-products",
  "healthcare",
  "transportation",
  "energy",
  "communications",
  "environment",
] as const;

export type PublicFeedCategory = (typeof PUBLIC_FEED_CATEGORIES)[number];

export type PublicFeedFormat = "atom" | "rss" | "json" | "html";

export type PublicFeedKind = "feed" | "api-template" | "url-template" | "discovery";

export interface PublicFeedSource {
  id: string;
  name: string;
  agency: string;
  category: PublicFeedCategory;
  kind: PublicFeedKind;
  format: PublicFeedFormat;
  url?: string;
  urlTemplate?: string;
  description: string;
  recommendedPollingMinutes: number;
  authentication: "none" | "free-key-optional" | "free-key-required";
  notes?: string;
}

export const PUBLIC_FEEDS: readonly PublicFeedSource[] = [
  {
    id: "issuer-ir",
    name: "Issuer investor-relations news and events",
    agency: "Company issuer",
    category: "company",
    kind: "discovery",
    format: "html",
    description:
      "The issuer's official IR press-release, SEC-filings, and events pages. Prefer a linked RSS/Atom feed when the issuer exposes one.",
    recommendedPollingMinutes: 30,
    authentication: "none",
    notes:
      "There is no universal URL. Discover it from the issuer's official investor-relations domain and store the exact HTTPS URL in the trigger.",
  },
  {
    id: "sec-company-filings",
    name: "SEC EDGAR company/form filings",
    agency: "SEC",
    category: "sec",
    kind: "url-template",
    format: "atom",
    urlTemplate:
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={CIK}&type={FORM_TYPE}&owner=include&count=40&output=atom",
    description:
      "Near-real-time EDGAR filings for one company, optionally filtered to a form such as 8-K, 10-Q, 10-K, or 4.",
    recommendedPollingMinutes: 15,
    authentication: "none",
    notes:
      "Use the 10-digit CIK. Keep SEC requests below 10 per second and use the configured SEC user agent.",
  },
  {
    id: "sec-latest-filings",
    name: "SEC EDGAR latest filings",
    agency: "SEC",
    category: "sec",
    kind: "feed",
    format: "atom",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&output=atom",
    description: "The latest EDGAR submissions across issuers.",
    recommendedPollingMinutes: 15,
    authentication: "none",
    notes:
      "This is a high-volume firehose. Prefer a company/form-specific feed whenever possible.",
  },
  {
    id: "sec-press-releases",
    name: "SEC press releases",
    agency: "SEC",
    category: "sec",
    kind: "feed",
    format: "rss",
    url: "https://www.sec.gov/news/pressreleases.rss",
    description: "SEC enforcement, rulemaking, and agency announcements.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "fed-press-all",
    name: "Federal Reserve annual press-release index",
    agency: "Federal Reserve Board",
    category: "macro",
    kind: "url-template",
    format: "html",
    urlTemplate:
      "https://www.federalreserve.gov/newsevents/pressreleases/{YYYY}-press.htm",
    description:
      "Federal Reserve monetary-policy, bank-supervision, enforcement, and other press releases.",
    recommendedPollingMinutes: 15,
    authentication: "none",
    notes:
      "The Board's advertised RSS feeds returned repeated HTTP 500 responses during live validation; use the yearly HTML index until they recover.",
  },
  {
    id: "fed-monetary-policy",
    name: "Federal Reserve FOMC calendar and releases",
    agency: "Federal Reserve Board",
    category: "macro",
    kind: "discovery",
    format: "html",
    url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    description:
      "FOMC meeting dates, statements, projections, press conferences, and minutes.",
    recommendedPollingMinutes: 15,
    authentication: "none",
  },
  {
    id: "fed-speeches",
    name: "Federal Reserve speeches",
    agency: "Federal Reserve Board",
    category: "macro",
    kind: "discovery",
    format: "html",
    url: "https://www.federalreserve.gov/newsevents/speeches.htm",
    description: "Speeches by Federal Reserve Board members.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "fed-testimony",
    name: "Federal Reserve testimony",
    agency: "Federal Reserve Board",
    category: "macro",
    kind: "discovery",
    format: "html",
    url: "https://www.federalreserve.gov/newsevents/testimony.htm",
    description: "Congressional testimony by Federal Reserve officials.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "bls-employment-situation",
    name: "BLS Employment Situation",
    agency: "Bureau of Labor Statistics",
    category: "macro",
    kind: "feed",
    format: "atom",
    url: "https://www.bls.gov/feed/empsit.rss",
    description: "Monthly payroll-employment and unemployment releases.",
    recommendedPollingMinutes: 15,
    authentication: "none",
  },
  {
    id: "bls-cpi",
    name: "BLS Consumer Price Index",
    agency: "Bureau of Labor Statistics",
    category: "macro",
    kind: "feed",
    format: "atom",
    url: "https://www.bls.gov/feed/cpi.rss",
    description: "Consumer Price Index news releases.",
    recommendedPollingMinutes: 15,
    authentication: "none",
  },
  {
    id: "bls-ppi",
    name: "BLS Producer Price Index",
    agency: "Bureau of Labor Statistics",
    category: "macro",
    kind: "feed",
    format: "atom",
    url: "https://www.bls.gov/feed/ppi.rss",
    description: "Producer Price Index news releases.",
    recommendedPollingMinutes: 15,
    authentication: "none",
  },
  {
    id: "bls-jolts",
    name: "BLS Job Openings and Labor Turnover",
    agency: "Bureau of Labor Statistics",
    category: "macro",
    kind: "feed",
    format: "atom",
    url: "https://www.bls.gov/feed/jolts.rss",
    description: "JOLTS job-openings, hires, and separations releases.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "bea-news-releases",
    name: "BEA economic releases",
    agency: "Bureau of Economic Analysis",
    category: "macro",
    kind: "feed",
    format: "rss",
    url: "https://apps.bea.gov/rss/rss.xml",
    description:
      "GDP, personal income and outlays, trade, corporate profits, and other BEA news releases.",
    recommendedPollingMinutes: 15,
    authentication: "none",
  },
  {
    id: "ftc-competition",
    name: "FTC competition press releases",
    agency: "Federal Trade Commission",
    category: "antitrust",
    kind: "feed",
    format: "rss",
    url: "https://www.ftc.gov/feeds/press-release-competition.xml",
    description: "FTC merger, antitrust, and competition enforcement announcements.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "ftc-consumer-protection",
    name: "FTC consumer-protection press releases",
    agency: "Federal Trade Commission",
    category: "antitrust",
    kind: "feed",
    format: "rss",
    url: "https://www.ftc.gov/feeds/press-release-consumer-protection.xml",
    description: "FTC consumer-protection, privacy, advertising, and fraud enforcement.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "doj-press-releases",
    name: "Department of Justice press releases",
    agency: "Department of Justice",
    category: "antitrust",
    kind: "feed",
    format: "rss",
    url: "https://www.justice.gov/news/rss?type=press_release&m=1",
    description:
      "DOJ civil and criminal enforcement announcements, including Antitrust Division actions.",
    recommendedPollingMinutes: 30,
    authentication: "none",
    notes: "Use a topic-filtered DOJ RSS URL when the broad feed is too noisy.",
  },
  {
    id: "cfpb-enforcement-actions",
    name: "CFPB enforcement actions",
    agency: "Consumer Financial Protection Bureau",
    category: "consumer-finance",
    kind: "feed",
    format: "rss",
    url: "https://www.consumerfinance.gov/enforcement/actions/feed/",
    description: "CFPB public enforcement actions and orders.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "occ-news-releases",
    name: "OCC news releases",
    agency: "Office of the Comptroller of the Currency",
    category: "banking",
    kind: "discovery",
    format: "html",
    url: "https://www.occ.treas.gov/news-issuances/news-releases/index-news-releases.html",
    description: "OCC bank-supervision, enforcement, and policy announcements.",
    recommendedPollingMinutes: 30,
    authentication: "none",
    notes:
      "The advertised OCC news RSS endpoint returned HTTP 500 during live validation; monitor the official HTML index.",
  },
  {
    id: "fdic-press-releases",
    name: "FDIC press releases",
    agency: "Federal Deposit Insurance Corporation",
    category: "banking",
    kind: "discovery",
    format: "html",
    url: "https://www.fdic.gov/news/press-releases",
    description:
      "FDIC supervision, resolution, enforcement, deposit-insurance, and banking-policy announcements.",
    recommendedPollingMinutes: 60,
    authentication: "none",
    notes:
      "FDIC does not currently expose a direct press-release RSS feed; monitor the official release index.",
  },
  {
    id: "cftc-press-releases",
    name: "CFTC press releases",
    agency: "Commodity Futures Trading Commission",
    category: "commodities",
    kind: "discovery",
    format: "html",
    url: "https://www.cftc.gov/PressRoom/PressReleases",
    description: "CFTC enforcement, derivatives-market, and rulemaking announcements.",
    recommendedPollingMinutes: 30,
    authentication: "none",
    notes:
      "CFTC's advertised enforcement feeds timed out or returned stale/empty data during live validation; do not use them as a sole dependency.",
  },
  {
    id: "cpsc-recalls",
    name: "CPSC recalls",
    agency: "Consumer Product Safety Commission",
    category: "consumer-products",
    kind: "feed",
    format: "rss",
    url: "https://www.cpsc.gov/Newsroom/CPSC-RSS-Feed/Recalls-RSS",
    description: "Official consumer-product recall and safety-warning announcements.",
    recommendedPollingMinutes: 60,
    authentication: "none",
  },
  {
    id: "openfda-drug-enforcement",
    name: "openFDA drug enforcement reports",
    agency: "Food and Drug Administration",
    category: "healthcare",
    kind: "api-template",
    format: "json",
    urlTemplate:
      "https://api.fda.gov/drug/enforcement.json?search=report_date:[{FROM_YYYYMMDD}+TO+{TO_YYYYMMDD}]&sort=report_date:asc&limit=50",
    description: "Drug recall and enforcement reports in a specified date window.",
    recommendedPollingMinutes: 60,
    authentication: "free-key-optional",
    notes: "No key is needed at low volume; openFDA applies stricter unauthenticated rate limits.",
  },
  {
    id: "openfda-device-enforcement",
    name: "openFDA device enforcement reports",
    agency: "Food and Drug Administration",
    category: "healthcare",
    kind: "api-template",
    format: "json",
    urlTemplate:
      "https://api.fda.gov/device/enforcement.json?search=report_date:[{FROM_YYYYMMDD}+TO+{TO_YYYYMMDD}]&sort=report_date:asc&limit=50",
    description: "Medical-device recall and enforcement reports in a specified date window.",
    recommendedPollingMinutes: 60,
    authentication: "free-key-optional",
    notes: "No key is needed at low volume; openFDA applies stricter unauthenticated rate limits.",
  },
  {
    id: "openfda-food-enforcement",
    name: "openFDA food enforcement reports",
    agency: "Food and Drug Administration",
    category: "consumer-products",
    kind: "api-template",
    format: "json",
    urlTemplate:
      "https://api.fda.gov/food/enforcement.json?search=report_date:[{FROM_YYYYMMDD}+TO+{TO_YYYYMMDD}]&sort=report_date:asc&limit=50",
    description: "Food recall and enforcement reports in a specified date window.",
    recommendedPollingMinutes: 60,
    authentication: "free-key-optional",
    notes: "The underlying FDA enforcement dataset is updated weekly.",
  },
  {
    id: "nhtsa-vehicle-recalls",
    name: "NHTSA vehicle recalls",
    agency: "National Highway Traffic Safety Administration",
    category: "transportation",
    kind: "api-template",
    format: "json",
    urlTemplate:
      "https://api.nhtsa.gov/recalls/recallsByVehicle?make={MAKE}&model={MODEL}&modelYear={YEAR}",
    description: "Safety recalls for a specified vehicle make, model, and model year.",
    recommendedPollingMinutes: 60,
    authentication: "none",
    notes:
      "This is a scoped lookup, not a complete manufacturer event stream. NHTSA's daily recall flat files are the authoritative bulk-diff source but are not supported by this text/JSON fetcher.",
  },
  {
    id: "fcc-enforcement",
    name: "FCC Enforcement Bureau documents",
    agency: "Federal Communications Commission",
    category: "communications",
    kind: "discovery",
    format: "html",
    url: "https://www.fcc.gov/enforcement",
    description:
      "FCC fines, settlements, notices, robocall orders, and cease-and-desist actions.",
    recommendedPollingMinutes: 60,
    authentication: "none",
    notes:
      "The official Enforcement Bureau RSS endpoint returned HTTP 403 from the deployment fetch path; monitor the official HTML page unless access recovers.",
  },
  {
    id: "fcc-daily-digest",
    name: "FCC Daily Digest",
    agency: "Federal Communications Commission",
    category: "communications",
    kind: "discovery",
    format: "html",
    url: "https://www.fcc.gov/proceedings-actions/daily-digest",
    description:
      "Daily synopsis of FCC orders, news releases, speeches, public notices, and other Commission documents.",
    recommendedPollingMinutes: 60,
    authentication: "none",
  },
  {
    id: "ferc-eforms-filings",
    name: "FERC accepted eForms filings",
    agency: "Federal Energy Regulatory Commission",
    category: "energy",
    kind: "feed",
    format: "rss",
    url: "https://ecollection.ferc.gov/api/rssfeed",
    description: "Accepted FERC eForms filings, limited to the most recent 650 entries.",
    recommendedPollingMinutes: 30,
    authentication: "none",
  },
  {
    id: "eia-today-in-energy",
    name: "EIA Today in Energy",
    agency: "Energy Information Administration",
    category: "energy",
    kind: "discovery",
    format: "html",
    url: "https://www.eia.gov/todayinenergy/",
    description: "EIA analysis and noteworthy energy-market developments.",
    recommendedPollingMinutes: 60,
    authentication: "none",
    notes:
      "EIA's public RSS endpoints returned HTTP 500 or timed out during live validation; use the HTML index or a separately configured API-key connection.",
  },
  {
    id: "epa-news-releases",
    name: "EPA news releases",
    agency: "Environmental Protection Agency",
    category: "environment",
    kind: "discovery",
    format: "html",
    url: "https://www.epa.gov/newsreleases/search",
    description:
      "EPA enforcement, rulemaking, grants, settlements, and environmental-policy announcements.",
    recommendedPollingMinutes: 60,
    authentication: "none",
  },
  {
    id: "cms-newsroom",
    name: "CMS newsroom",
    agency: "Centers for Medicare & Medicaid Services",
    category: "healthcare",
    kind: "feed",
    format: "rss",
    url: "https://www.cms.gov/newsroom/rss-feeds",
    description:
      "CMS payment rules, coverage decisions, program updates, fact sheets, and press releases.",
    recommendedPollingMinutes: 60,
    authentication: "none",
  },
  {
    id: "fsis-recalls",
    name: "USDA FSIS recalls and public-health alerts",
    agency: "USDA Food Safety and Inspection Service",
    category: "consumer-products",
    kind: "discovery",
    format: "html",
    url: "https://www.fsis.usda.gov/recalls-alerts",
    description:
      "Meat, poultry, and processed-egg recalls and public-health alerts.",
    recommendedPollingMinutes: 60,
    authentication: "none",
    notes:
      "The official recall RSS endpoint returned HTTP 403 from the deployment fetch path; monitor the official HTML page unless access recovers.",
  },
] as const;

const publicFeedsById = new Map(PUBLIC_FEEDS.map((source) => [source.id, source]));

export function getPublicFeed(id: string): PublicFeedSource | undefined {
  return publicFeedsById.get(id);
}

export function listPublicFeeds(options?: {
  category?: PublicFeedCategory;
  query?: string;
  includeTemplates?: boolean;
}): PublicFeedSource[] {
  const query = options?.query?.trim().toLocaleLowerCase();
  return PUBLIC_FEEDS.filter((source) => {
    if (options?.category && source.category !== options.category) return false;
    if (options?.includeTemplates === false && source.url === undefined) return false;
    if (!query) return true;

    return [
      source.id,
      source.name,
      source.agency,
      source.category,
      source.description,
      source.notes ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}
