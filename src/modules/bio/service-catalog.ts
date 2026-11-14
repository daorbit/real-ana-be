export type BioServiceSpec = { id: string; name: string; hosts: string[] };

export const CUSTOM_SERVICE_ID = "custom";

export const BIO_SERVICES: BioServiceSpec[] = [
  { id: "spotify", name: "Spotify", hosts: ["open.spotify.com", "spotify.link"] },
  { id: "apple-music", name: "Apple Music", hosts: ["music.apple.com"] },
  { id: "youtube-music", name: "YouTube Music", hosts: ["music.youtube.com"] },
  { id: "youtube", name: "YouTube", hosts: ["youtube.com", "youtu.be", "m.youtube.com"] },
  { id: "jiosaavn", name: "JioSaavn", hosts: ["jiosaavn.com"] },
  { id: "gaana", name: "Gaana", hosts: ["gaana.com"] },
  { id: "wynk", name: "Wynk Music", hosts: ["wynk.in"] },
  { id: "amazon-music", name: "Amazon Music", hosts: ["music.amazon.com", "music.amazon.in"] },
  { id: "itunes", name: "iTunes Store", hosts: ["itunes.apple.com"] },
  { id: "deezer", name: "Deezer", hosts: ["deezer.com", "deezer.page.link"] },
  { id: "tidal", name: "Tidal", hosts: ["tidal.com", "listen.tidal.com"] },
  { id: "soundcloud", name: "SoundCloud", hosts: ["soundcloud.com", "on.soundcloud.com"] },
  { id: "audiomack", name: "Audiomack", hosts: ["audiomack.com"] },
  { id: "bandcamp", name: "Bandcamp", hosts: ["bandcamp.com"] },
  { id: "pandora", name: "Pandora", hosts: ["pandora.com"] },
  { id: "boomplay", name: "Boomplay", hosts: ["boomplay.com"] },
  { id: "anghami", name: "Anghami", hosts: ["anghami.com"] },
  { id: "beatport", name: "Beatport", hosts: ["beatport.com"] },
  { id: "napster", name: "Napster", hosts: ["napster.com"] },
  { id: "apple-podcasts", name: "Apple Podcasts", hosts: ["podcasts.apple.com"] },
  { id: "spotify-podcasts", name: "Spotify Podcasts", hosts: [] },
  { id: "instagram", name: "Instagram", hosts: ["instagram.com", "instagr.am"] },
  { id: "facebook", name: "Facebook", hosts: ["facebook.com", "fb.com", "fb.me", "m.facebook.com"] },
  { id: "whatsapp", name: "WhatsApp", hosts: ["wa.me", "whatsapp.com", "api.whatsapp.com", "chat.whatsapp.com"] },
  { id: "x", name: "X", hosts: ["x.com", "twitter.com"] },
  { id: "threads", name: "Threads", hosts: ["threads.net", "threads.com"] },
  { id: "linkedin", name: "LinkedIn", hosts: ["linkedin.com", "lnkd.in"] },
  { id: "tiktok", name: "TikTok", hosts: ["tiktok.com", "vm.tiktok.com"] },
  { id: "snapchat", name: "Snapchat", hosts: ["snapchat.com"] },
  { id: "telegram", name: "Telegram", hosts: ["t.me", "telegram.me", "telegram.org"] },
  { id: "netflix", name: "Netflix", hosts: ["netflix.com"] },
  { id: "prime-video", name: "Prime Video", hosts: ["primevideo.com"] },
  { id: "app-store", name: "App Store", hosts: ["apps.apple.com"] },
  { id: "google-play", name: "Google Play", hosts: ["play.google.com"] },
  { id: "google-play-books", name: "Google Play Books", hosts: [] },
  { id: "steam", name: "Steam", hosts: ["store.steampowered.com", "steampowered.com"] },
  { id: "amazon", name: "Amazon", hosts: ["amazon.in", "amazon.com", "amzn.to", "amzn.in"] },
  { id: "flipkart", name: "Flipkart", hosts: ["flipkart.com", "fkrt.it"] },
  { id: "myntra", name: "Myntra", hosts: ["myntra.com"] },
  { id: "meesho", name: "Meesho", hosts: ["meesho.com"] },
  { id: "nykaa", name: "Nykaa", hosts: ["nykaa.com"] },
  { id: "shopify", name: "Online store", hosts: ["myshopify.com"] },
  { id: "bookmyshow", name: "BookMyShow", hosts: ["bookmyshow.com", "in.bookmyshow.com"] },
  { id: "district", name: "District", hosts: ["district.in"] },
  { id: "ticketmaster", name: "Ticketmaster", hosts: ["ticketmaster.com", "ticketmaster.co.uk"] },
  { id: "website", name: "Website", hosts: [] },
  { id: CUSTOM_SERVICE_ID, name: "Custom", hosts: [] },
];

const IDS = new Set(BIO_SERVICES.map((s) => s.id));

export function isBioService(id: string): boolean {
  return IDS.has(id);
}

export function hostOf(url: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function detectService(url: string): BioServiceSpec | null {
  const host = hostOf(url);
  if (!host) return null;
  const match = BIO_SERVICES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
  if (match?.id === "spotify" && /\/(show|episode)\//.test(url)) return BIO_SERVICES.find((s) => s.id === "spotify-podcasts") ?? match;
  return match;
}
