(function () {
  "use strict";

  // Sent with every event so the dashboard can tell which sites are still on an
  // older script and are therefore missing the metrics it added. Bump this
  // whenever the tracker starts collecting something new.
  var VERSION = 4;

  // Find our own <script> tag.
  // document.currentScript is null when the tag is injected dynamically
  // (next/script, React-rendered <script>, async loaders), so fall back to a query.
  function findScript() {
    var s = document.currentScript;
    if (s && s.getAttribute("data-site")) return s;
    return document.querySelector("script[data-site]");
  }

  var script = findScript();
  if (!script) return;

  var siteId = script.getAttribute("data-site");
  if (!siteId) return;

  var src = script.src || "";
  var i = src.indexOf("/tracker.js");
  var origin = i > -1 ? src.slice(0, i) : "";
  var endpoint = origin + "/api/collect";

  /* ------------------------------------------------------------------
   * Script options, all set as data-* attributes on the <script> tag.
   * Every one is opt-in or opt-out against the current behaviour, so an
   * existing snippet keeps working unchanged.
   * ------------------------------------------------------------------ */
  function opt(name) {
    return script.getAttribute("data-" + name);
  }

  /** Comma-separated attribute -> trimmed, non-empty list. */
  function optList(name) {
    var raw = opt(name);
    if (!raw) return [];
    return raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // Honour the browser's Do Not Track signal. Off by default: DNT is advisory,
  // and this tracker stores no personal data either way — but sites with a
  // stricter policy need the switch.
  if (opt("dnt") === "on") {
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    if (dnt === "1" || dnt === "yes") return;
  }

  // Hash routing: sites that navigate with `#/path` report the same pathname on
  // every view, so their whole site collapses into one row without this.
  var hashMode = opt("hash") === "on";

  // Report a different hostname than the one being browsed — for staging or
  // preview deploys that should land in the production site's numbers.
  var domainOverwrite = opt("domain") || "";

  /**
   * Pages to leave out entirely, as comma-separated globs: "/admin/*,/preview".
   * A `*` matches any run of characters; everything else is literal.
   */
  var ignoreRules = optList("ignore-pages").map(function (pattern) {
    var escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$");
  });

  function ignored(path) {
    for (var n = 0; n < ignoreRules.length; n++) {
      if (ignoreRules[n].test(path)) return true;
    }
    return false;
  }

  /**
   * Query parameters worth keeping on the reported path.
   *
   * Full query strings are a personal-data risk (emails and tokens end up in
   * them) and they shatter one page into thousands of rows, so the default is
   * to drop them. Naming params here opts them back in.
   */
  var allowedParams = optList("allow-params");

  /** The path we report: ignore rules and param policy applied. */
  function currentPath() {
    var path = location.pathname;

    if (hashMode && location.hash) {
      // "#/pricing" -> "/pricing"; "#pricing" -> "/pricing"
      path = "/" + location.hash.replace(/^#\/?/, "");
    }

    if (allowedParams.length) {
      var q = new URLSearchParams(location.search);
      var kept = new URLSearchParams();
      allowedParams.forEach(function (k) {
        if (q.has(k)) kept.set(k, q.get(k));
      });
      var qs = kept.toString();
      if (qs) path += "?" + qs;
    }

    return path;
  }

  /* ------------------------------------------------------------------
   * Session: a 30-minute sliding window, kept in sessionStorage so it
   * survives SPA navigation and reloads within the same tab.
   * ------------------------------------------------------------------ */
  var SESSION_TTL = 30 * 60 * 1000;
  var SKEY = "_va_sess_" + siteId;

  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function session() {
    var now = Date.now();
    var raw;
    try {
      raw = JSON.parse(sessionStorage.getItem(SKEY) || "null");
    } catch (e) {
      raw = null;
    }
    if (!raw || now - raw.last > SESSION_TTL) {
      raw = { id: uid(), start: now, last: now, views: 0, entry: currentPath() };
    }
    raw.last = now;
    try {
      sessionStorage.setItem(SKEY, JSON.stringify(raw));
    } catch (e) {
      /* storage disabled — session degrades to per-pageview */
    }
    return raw;
  }

  function bumpViews() {
    var s = session();
    s.views += 1;
    try {
      sessionStorage.setItem(SKEY, JSON.stringify(s));
    } catch (e) {}
    return s;
  }

  /* ------------------------------------------------------------------
   * Static client context — cheap, read once.
   * ------------------------------------------------------------------ */
  function context() {
    var tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {}
    return {
      screenW: window.screen ? window.screen.width : 0,
      screenH: window.screen ? window.screen.height : 0,
      viewportW: window.innerWidth || 0,
      viewportH: window.innerHeight || 0,
      language: navigator.language || "",
      timezone: tz,
    };
  }

  function utm() {
    var q = new URLSearchParams(location.search);
    return {
      source: q.get("utm_source") || "",
      medium: q.get("utm_medium") || "",
      campaign: q.get("utm_campaign") || "",
    };
  }

  /* ------------------------------------------------------------------
   * Transport
   * sendBeacon with an application/json Blob triggers a CORS preflight,
   * which beacons cannot perform — the request is silently dropped.
   * text/plain is CORS-safelisted, so no preflight is needed.
   * ------------------------------------------------------------------ */
  function post(payload) {
    payload.v = VERSION;
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      var ok = navigator.sendBeacon(
        endpoint,
        new Blob([body], { type: "text/plain;charset=UTF-8" })
      );
      if (ok) return;
    }
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: body,
      keepalive: true,
      mode: "cors",
      credentials: "omit",
    }).catch(function () {});
  }

  /* ------------------------------------------------------------------
   * Engagement: measure how long the page was actually *visible*, so a
   * backgrounded tab doesn't inflate time-on-page.
   * ------------------------------------------------------------------ */
  var visibleMs = 0;
  var visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
  var lastPath = null;
  var currentView = null; // { path, startedAt }

  function accumulate() {
    if (visibleSince) {
      visibleMs += Date.now() - visibleSince;
      visibleSince = 0;
    }
  }

  /* ------------------------------------------------------------------
   * Scroll depth: the furthest point of the page the visitor reached.
   * Sampled on scroll (throttled by rAF) and reported with the engagement
   * record, since it is only final once they leave.
   * ------------------------------------------------------------------ */
  var maxScroll = 0;
  var scrollQueued = false;
  // Elements already counted as seen on this page — see the impression block.

  function measureScroll() {
    scrollQueued = false;
    var doc = document.documentElement;
    var body = document.body;
    var height = Math.max(
      doc.scrollHeight, body ? body.scrollHeight : 0,
      doc.offsetHeight, body ? body.offsetHeight : 0
    );
    var viewport = window.innerHeight || doc.clientHeight || 0;
    // A page shorter than the viewport is fully seen the moment it loads.
    if (height <= viewport) {
      maxScroll = 100;
      return;
    }
    var scrolled = window.pageYOffset || doc.scrollTop || 0;
    var pct = Math.round(((scrolled + viewport) / height) * 100);
    if (pct > maxScroll) maxScroll = Math.min(100, pct);
  }

  window.addEventListener(
    "scroll",
    function () {
      // Scroll fires far faster than the page can repaint; one sample per frame
      // is plenty and keeps the handler off the critical path.
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(measureScroll);
    },
    { passive: true }
  );

  measureScroll();

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      if (!visibleSince) visibleSince = Date.now();
    } else {
      accumulate();
      flush(); // a hidden tab may never come back — report what we have
    }
  });

  // Send the engagement record for the page we are leaving.
  var flushed = false;
  function flush() {
    if (!currentView || flushed) return;
    accumulate();
    var s = session();
    post({
      siteId: siteId,
      type: "engagement",
      path: currentView.path,
      sessionId: s.id,
      durationMs: visibleMs,
      // bounce = the session ended with only one pageview
      bounce: s.views <= 1,
      isExit: true,
      scrollDepth: maxScroll,
      utm: utm(),
    });
    flushed = true;
  }

  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);

  /* ------------------------------------------------------------------
   * Pageview
   * ------------------------------------------------------------------ */
  function pageview() {
    var path = currentPath();

    // SPA routers can fire several history events for a single navigation.
    // Compare the resolved path, not location.pathname — under hash routing
    // every route shares one pathname and only the hash tells them apart.
    if (path === lastPath) return;

    // An ignored page is not reported, and does not end the previous page's
    // engagement either — as far as the numbers go, it was never visited.
    if (ignored(path)) return;

    // Leaving the previous in-SPA page: report its engagement first.
    if (currentView) {
      accumulate();
      var prev = session();
      post({
        siteId: siteId,
        type: "engagement",
        path: currentView.path,
        sessionId: prev.id,
        durationMs: visibleMs,
        bounce: false, // they navigated on, so it isn't a bounce
        isExit: false,
        scrollDepth: maxScroll,
        utm: utm(),
      });
    }

    lastPath = path;
    visibleMs = 0;
    visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
    flushed = false;

    // A new page starts unscrolled, and its height is not the old page's.
    maxScroll = 0;
    // The router may not have painted the new page yet, so measure after it has.
    setTimeout(measureScroll, 0);

    var s = bumpViews();
    currentView = { path: path, startedAt: Date.now() };

    var ctx = context();
    post({
      siteId: siteId,
      type: "pageview",
      path: path,
      hostname: domainOverwrite,
      referrer: document.referrer,
      sessionId: s.id,
      isEntry: s.views === 1,
      entryPath: s.entry,
      screenW: ctx.screenW,
      screenH: ctx.screenH,
      viewportW: ctx.viewportW,
      viewportH: ctx.viewportH,
      language: ctx.language,
      timezone: ctx.timezone,
      utm: utm(),
    });
  }

  pageview();

  // SPA route changes: Next.js and friends drive the history API.
  var push = history.pushState;
  history.pushState = function () {
    push.apply(this, arguments);
    setTimeout(pageview, 0);
  };
  var replace = history.replaceState;
  history.replaceState = function () {
    replace.apply(this, arguments);
    setTimeout(pageview, 0);
  };
  window.addEventListener("popstate", function () {
    setTimeout(pageview, 0);
  });
  // Hash routers never touch the history API, so nothing above fires for them.
  if (hashMode) {
    window.addEventListener("hashchange", function () {
      setTimeout(pageview, 0);
    });
  }

  /* ------------------------------------------------------------------
   * Click tracking
   * Delegated on the document, so it also covers elements added later.
   * We report buttons, links, and anything tagged with data-va-cta.
   * Opt out per element with data-va-ignore, or globally with
   * data-clicks="off" on the script tag.
   * ------------------------------------------------------------------ */
  var trackClicks = script.getAttribute("data-clicks") !== "off";

  function label(el) {
    // An explicit name always wins over whatever text happens to be inside.
    var explicit =
      el.getAttribute("data-va-cta") ||
      el.getAttribute("aria-label") ||
      el.id ||
      "";
    if (explicit) return explicit.slice(0, 120);
    var text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 120);
  }

  function trackable(target) {
    // Walk up from the clicked node: the user may have hit an icon inside a button.
    for (var el = target; el && el !== document.body; el = el.parentElement) {
      if (el.hasAttribute && el.hasAttribute("data-va-ignore")) return null;
      if (!el.tagName) continue;
      var tag = el.tagName.toLowerCase();
      var isCta =
        tag === "button" ||
        tag === "a" ||
        el.getAttribute("role") === "button" ||
        el.hasAttribute("data-va-cta") ||
        (tag === "input" && (el.type === "submit" || el.type === "button"));
      if (isCta) return { el: el, tag: tag };
    }
    return null;
  }

  // File extensions that count as a download rather than a page navigation.
  var DOWNLOAD_RE = /\.(pdf|zip|rar|7z|gz|tar|dmg|exe|msi|pkg|deb|csv|xlsx?|docx?|pptx?|mp3|mp4|mov|avi|wav|json|xml|txt|apk)($|\?)/i;

  // Classify a link: "download" for a file, "outbound" for another host, or
  // null for an ordinary in-site link. Falls back to null on a bad/relative URL.
  function linkKind(href) {
    if (!href) return null;
    try {
      var url = new URL(href, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (DOWNLOAD_RE.test(url.pathname)) return "download";
      if (url.host !== location.host) return "outbound";
    } catch (e) {}
    return null;
  }

  if (trackClicks) {
    document.addEventListener(
      "click",
      function (e) {
        var hit = trackable(e.target);
        if (!hit) return;

        var href = hit.el.getAttribute("href") || "";
        // Outbound links and downloads are the same click event, retagged so the
        // dashboard can report "where people go when they leave" separately.
        var kind = hit.tag === "a" ? linkKind(href) : null;

        var s = session();
        post({
          siteId: siteId,
          type: "click",
          path: location.pathname, // the page the CTA was clicked on
          sessionId: s.id,
          clickText: label(hit.el),
          clickTag: kind || hit.tag,
          clickId: hit.el.getAttribute("data-va-cta") || hit.el.id || "",
          clickHref: href,
          utm: utm(),
        });
      },
      true // capture, so a handler that stops propagation can't hide the click
    );
  }

  /* ------------------------------------------------------------------
   * Error tracking
   * Forward uncaught JS errors and unhandled promise rejections so broken
   * pages surface in the dashboard. Opt out with data-errors="off" on the
   * script tag. Messages are truncated and never carry stack contents.
   * ------------------------------------------------------------------ */
  var trackErrors = script.getAttribute("data-errors") !== "off";

  if (trackErrors) {
    // Don't drown a genuinely broken page in identical reports.
    var errorsSent = 0;
    var ERROR_CAP = 10;

    function reportError(message) {
      if (errorsSent >= ERROR_CAP) return;
      errorsSent++;
      var msg = String(message || "Error").replace(/\s+/g, " ").trim().slice(0, 200);
      var s = session();
      post({
        siteId: siteId,
        type: "error",
        name: msg,
        path: location.pathname,
        sessionId: s.id,
      });
    }

    window.addEventListener("error", function (e) {
      // Resource load failures (img/script 404) surface here with no message —
      // report those as a broken-resource error rather than a script error.
      if (e && e.message) reportError(e.message);
      else if (e && e.target && e.target.src) reportError("Failed to load " + e.target.src);
    }, true);

    window.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      reportError((r && (r.message || r)) || "Unhandled promise rejection");
    });
  }

  /* ------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------ */
  window.rta = {
    track: function (name, props) {
      var s = session();
      post({
        siteId: siteId,
        type: "custom",
        name: name,
        path: location.pathname,
        sessionId: s.id,
        props: props || undefined,
        utm: utm(),
      });
    },
  };
})();
