(function () {
  "use strict";

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

  // Endpoint: same origin as the script src
  var src = script.src || "";
  var i = src.indexOf("/tracker.js");
  var origin = i > -1 ? src.slice(0, i) : "";
  var endpoint = origin + "/api/collect";

  function utm() {
    var q = new URLSearchParams(location.search);
    return {
      source: q.get("utm_source") || "",
      medium: q.get("utm_medium") || "",
      campaign: q.get("utm_campaign") || "",
    };
  }

  var lastPath = null;

  function send(type, name) {
    var payload = {
      siteId: siteId,
      type: type || "pageview",
      name: name,
      path: location.pathname,
      referrer: document.referrer,
      utm: utm(),
    };
    var body = JSON.stringify(payload);

    // sendBeacon with an application/json Blob triggers a CORS preflight, which
    // beacons cannot perform — the request is silently dropped cross-origin.
    // text/plain is a CORS-safelisted content type, so no preflight is needed.
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

  function pageview() {
    // SPA frameworks can fire several route events for one navigation.
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    send("pageview");
  }

  // Initial pageview
  pageview();

  // SPA route changes: patch the history API (Next.js router uses pushState)
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

  // Expose custom event tracking
  window.rta = {
    track: function (name) {
      send("custom", name);
    },
  };
})();
