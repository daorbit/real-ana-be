const ENGINES: { match: string; name: string }[] = [
  { match: "google.", name: "Google" },
  { match: "bing.", name: "Bing" },
  { match: "duckduckgo.", name: "DuckDuckGo" },
  { match: "yahoo.", name: "Yahoo" },
  { match: "yandex.", name: "Yandex" },
  { match: "baidu.", name: "Baidu" },
  { match: "ecosia.", name: "Ecosia" },
  { match: "brave.", name: "Brave" },
  { match: "startpage.", name: "Startpage" },
  { match: "qwant.", name: "Qwant" },
  { match: "naver.", name: "Naver" },
  { match: "seznam.", name: "Seznam" },
  { match: "ask.com", name: "Ask" },
  { match: "aol.", name: "AOL" },
  { match: "perplexity.", name: "Perplexity" },
  { match: "chatgpt.com", name: "ChatGPT" },
  { match: "openai.com", name: "ChatGPT" },
  { match: "copilot.microsoft", name: "Copilot" },
  { match: "gemini.google", name: "Gemini" },
];

export function engineOf(referrer: string): string | null {
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  const hit = ENGINES.find((e) => host.includes(e.match));
  return hit ? hit.name : null;
}
