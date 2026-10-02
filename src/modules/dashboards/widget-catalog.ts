export type WidgetSpan = 1 | 2 | 3 | 4;

export type CatalogWidget = {
  id: string;
  label: string;
  group: "Metrics" | "Charts" | "Breakdowns" | "Search";
  description: string;
  span: WidgetSpan;
};

export const DASHBOARD_WIDGETS: CatalogWidget[] = [
  { id: "visitors", label: "Visitors", group: "Metrics", description: "Unique people, with trend", span: 1 },
  { id: "pageviews", label: "Pageviews", group: "Metrics", description: "Total pages loaded", span: 1 },
  { id: "live", label: "Live now", group: "Metrics", description: "People on the site right now", span: 1 },
  { id: "sessions", label: "Sessions", group: "Metrics", description: "Distinct visits", span: 1 },
  { id: "bounce", label: "Bounce rate", group: "Metrics", description: "Left after one page", span: 1 },
  { id: "avgSession", label: "Avg. session", group: "Metrics", description: "Time spent per visit", span: 1 },
  { id: "pagesPerSession", label: "Pages / session", group: "Metrics", description: "Depth of each visit", span: 1 },
  { id: "sites", label: "Sites", group: "Metrics", description: "Sites in this workspace", span: 1 },

  { id: "traffic", label: "Traffic chart", group: "Charts", description: "Views over time", span: 3 },
  { id: "livePages", label: "Right now", group: "Charts", description: "Pages being viewed live", span: 1 },
  { id: "worldMap", label: "World map", group: "Charts", description: "Visitors by country", span: 2 },
  { id: "clicks", label: "CTA clicks", group: "Charts", description: "Which buttons get clicked, and where", span: 2 },
  { id: "heatmap", label: "Traffic heatmap", group: "Charts", description: "When visitors show up, by hour and day", span: 4 },
  { id: "seoScore", label: "SEO health", group: "Charts", description: "Latest SEO audit score", span: 2 },
  { id: "targets", label: "Goal progress", group: "Charts", description: "Monthly and quarterly targets", span: 2 },

  { id: "topPages", label: "Top pages", group: "Breakdowns", description: "Most viewed pages", span: 1 },
  { id: "entryPages", label: "Entry pages", group: "Breakdowns", description: "Where visits begin", span: 1 },
  { id: "exitPages", label: "Exit pages", group: "Breakdowns", description: "Where visits end", span: 1 },
  { id: "topReferrers", label: "Referrers", group: "Breakdowns", description: "Sites sending traffic", span: 1 },
  { id: "topCountries", label: "Countries", group: "Breakdowns", description: "Top locations", span: 1 },
  { id: "browsers", label: "Browsers", group: "Breakdowns", description: "Chrome, Safari and others", span: 1 },
  { id: "operatingSystems", label: "Operating systems", group: "Breakdowns", description: "Windows, macOS and others", span: 1 },
  { id: "devices", label: "Devices", group: "Breakdowns", description: "Desktop, mobile, tablet", span: 1 },
  { id: "screenSizes", label: "Screen sizes", group: "Breakdowns", description: "Viewport width buckets", span: 1 },
  { id: "languages", label: "Languages", group: "Breakdowns", description: "Browser language", span: 1 },
  { id: "utmSources", label: "UTM sources", group: "Breakdowns", description: "Campaign sources", span: 1 },
  { id: "utmCampaigns", label: "UTM campaigns", group: "Breakdowns", description: "Campaign names", span: 1 },
  { id: "scrollDepth", label: "Scroll depth", group: "Breakdowns", description: "How far down each page people read", span: 2 },
  { id: "landingPages", label: "Landing pages", group: "Breakdowns", description: "Which entry points hold people", span: 2 },
  { id: "channels", label: "Channels", group: "Breakdowns", description: "Direct, organic, paid, social and others", span: 1 },
  { id: "goals", label: "Conversions", group: "Breakdowns", description: "Goal conversion rates", span: 2 },
  { id: "outbound", label: "Outbound & downloads", group: "Breakdowns", description: "Where visitors leave to", span: 1 },
  { id: "errors", label: "JS errors", group: "Breakdowns", description: "Broken pages and failed scripts", span: 1 },

  { id: "searchClicks", label: "Google clicks", group: "Search", description: "Clicks from Google Search results", span: 1 },
  { id: "searchImpressions", label: "Google impressions", group: "Search", description: "Times the site appeared in Google", span: 1 },
  { id: "searchCtr", label: "Search CTR", group: "Search", description: "Share of impressions that became clicks", span: 1 },
  { id: "searchPosition", label: "Avg. position", group: "Search", description: "Average ranking in Google results", span: 1 },
  { id: "searchTrend", label: "Search performance", group: "Search", description: "Google clicks and impressions over time", span: 4 },
  { id: "searchQueries", label: "Top search queries", group: "Search", description: "What people searched before finding the site", span: 2 },
  { id: "searchPages", label: "Top pages in Google", group: "Search", description: "Pages earning the most search clicks", span: 2 },
  { id: "searchRankings", label: "Ranking positions", group: "Search", description: "How many queries rank top 3, page 1 and beyond", span: 2 },
  { id: "searchOpportunities", label: "Quick wins", group: "Search", description: "Queries close to page one worth improving", span: 2 },
];

export const DASHBOARD_WIDGET_MAP = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));
