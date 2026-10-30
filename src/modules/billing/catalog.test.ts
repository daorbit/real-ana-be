import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CURRENCIES, DEFAULT_CURRENCY, isCurrency, resolveCurrency } from "./currency.js";
import { PLAN_CATALOG, getPlanCatalogEntry } from "./plans.catalog.js";
import {
  DEFAULT_APP_PRICE_INR,
  PAID_APPS,
  PAID_APP_NAMES,
  PAYMENT_ONLY_APPS,
  isPaidApp,
  paidAppUnlocked,
} from "./paid-apps.catalog.js";
import { WORKSPACE_APPS } from "../workspace/apps.service.js";
import { fakeDoc } from "../../test-support/mongoose-fakes.js";

const NUMERIC_LIMITS = [
  "monthlyAuditQuota",
  "monthlyCrawlQuota",
  "monthlyEventQuota",
  "maxReportSchedules",
  "maxReportRecipients",
  "maxScheduledPosts",
  "maxForms",
  "monthlySubmissionQuota",
  "maxMediaAssets",
  "searchMaxDays",
  "monthlyInspectionQuota",
  "maxDashboards",
  "maxEmbeds",
  "maxGoalTargets",
  "maxPopups",
  "maxBioPages",
  "maxOpenTasks",
  "insightWeeks",
  "alertCheckHours",
  "auditLogDays",
] as const;

const BOOLEAN_FEATURES = [
  "whatsappReports",
  "repeatingPosts",
  "formNotificationEmails",
  "formFileUploads",
  "formBranding",
  "searchPageViews",
  "insightRefresh",
] as const;

describe("currency", () => {
  test("knows the supported currencies", () => {
    assert.deepEqual([...CURRENCIES], ["INR", "USD"]);
    assert.equal(isCurrency("USD"), true);
    assert.equal(isCurrency("usd"), false);
    assert.equal(isCurrency("EUR"), false);
    assert.equal(isCurrency(undefined), false);
  });

  test("falls back to INR for anything unknown", () => {
    assert.equal(resolveCurrency("USD"), "USD");
    assert.equal(resolveCurrency("GBP"), DEFAULT_CURRENCY);
    assert.equal(resolveCurrency(null), "INR");
  });
});

describe("PLAN_CATALOG", () => {
  test("has free, starter and pro in price order", () => {
    assert.deepEqual(
      PLAN_CATALOG.map((p) => p.slug),
      ["free", "starter", "pro"],
    );
    const orders = PLAN_CATALOG.map((p) => p.sortOrder);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    assert.equal(new Set(orders).size, orders.length);
  });

  test("gives every plan every numeric limit as a non-negative number", () => {
    for (const plan of PLAN_CATALOG) {
      for (const field of NUMERIC_LIMITS) {
        const value = plan[field];
        assert.equal(typeof value, "number", `${plan.slug}.${field}`);
        assert.ok(Number.isFinite(value) && value >= 0, `${plan.slug}.${field} = ${value}`);
      }
    }
  });

  test("never gives a higher plan a lower limit than the plan below it", () => {
    const capacityLimits = NUMERIC_LIMITS.filter((f) => f !== "alertCheckHours");
    for (let i = 1; i < PLAN_CATALOG.length; i++) {
      const lower = PLAN_CATALOG[i - 1];
      const higher = PLAN_CATALOG[i];
      for (const field of capacityLimits) {
        assert.ok(higher[field] >= lower[field], `${higher.slug}.${field} < ${lower.slug}.${field}`);
      }
      assert.ok(higher.alertCheckHours <= lower.alertCheckHours, `${higher.slug} checks alerts less often`);
      for (const range of lower.allowedRanges) assert.ok(higher.allowedRanges.includes(range));
      for (const mode of lower.compareModes) assert.ok(higher.compareModes.includes(mode));
      for (const frequency of lower.allowedReportFrequencies) assert.ok(higher.allowedReportFrequencies.includes(frequency));
      for (const flag of BOOLEAN_FEATURES) {
        assert.ok(!lower[flag] || higher[flag], `${higher.slug} loses ${flag}`);
      }
    }
  });

  test("lists features without duplicates", () => {
    for (const plan of PLAN_CATALOG) {
      assert.ok(plan.features.length > 0, plan.slug);
      assert.equal(new Set(plan.features).size, plan.features.length, plan.slug);
    }
  });

  test("finds plans by slug", () => {
    assert.equal(getPlanCatalogEntry("pro")?.name, "Pro");
    assert.equal(getPlanCatalogEntry("enterprise"), undefined);
    assert.equal(getPlanCatalogEntry(""), undefined);
  });
});

describe("paid apps catalog", () => {
  test("only lists real workspace apps, each with a name", () => {
    for (const app of PAID_APPS) {
      assert.ok((WORKSPACE_APPS as readonly string[]).includes(app), app);
      assert.ok(PAID_APP_NAMES[app].startsWith("Quantalog "), app);
    }
    for (const app of PAYMENT_ONLY_APPS) assert.ok(PAID_APPS.includes(app));
  });

  test("defaults to ₹599", () => {
    assert.equal(DEFAULT_APP_PRICE_INR, 59900);
  });

  test("recognises paid apps", () => {
    assert.equal(isPaidApp("reviews"), true);
    assert.equal(isPaidApp("compare"), false);
    assert.equal(isPaidApp(null), false);
  });

  test("always unlocks free apps", () => {
    assert.equal(paidAppUnlocked(fakeDoc({ apps: {} }), "compare"), true);
  });

  test("unlocks a paid app once paid for", () => {
    assert.equal(paidAppUnlocked(fakeDoc({ apps: { reviews: { paidAt: new Date() } } }), "reviews"), true);
    assert.equal(paidAppUnlocked(fakeDoc({ apps: { notes: { paidAt: new Date() } } }), "notes"), true);
  });

  test("keeps apps free for workspaces that used them before they were paid, except payment-only apps", () => {
    assert.equal(paidAppUnlocked(fakeDoc({ apps: { alerts: { enabledAt: new Date() } } }), "alerts"), true);
    assert.equal(paidAppUnlocked(fakeDoc({ apps: { notes: { enabledAt: new Date() } } }), "notes"), false);
    assert.equal(paidAppUnlocked(fakeDoc({ apps: { popups: { enabledAt: new Date() } } }), "popups"), false);
  });

  test("locks a paid app nobody has paid for or used", () => {
    assert.equal(paidAppUnlocked(fakeDoc({ apps: {} }), "links"), false);
  });
});
