(function () {
  "use strict";
  var script = document.currentScript;
  var siteId = script && script.getAttribute("data-site");
  if (!siteId) return;

  // Endpoint: same origin as the script src
  var src = script.src;
  var origin = src.slice(0, src.indexOf("/tracker.js"));
  var endpoint = origin + "/api/collect";

  function utm() {
    var q = new URLSearchParams(location.search);
    return {
      source: q.get("utm_source") || "",
      medium: q.get("utm_medium") || "",
      campaign: q.get("utm_campaign") || "",
    };
  }

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
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
    } else {
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
      });
    }
  }

  // Initial pageview
  send("pageview");

  // SPA route changes: patch history API
  var push = history.pushState;
  history.pushState = function () {
    push.apply(this, arguments);
    send("pageview");
  };
  window.addEventListener("popstate", function () {
    send("pageview");
  });

  // Expose custom event tracking
  window.rta = { track: function (name) { send("custom", name); } };
})();
