export const AUDIT_CATEGORIES = [
  "account",
  "members",
  "workspace",
  "sites",
  "analytics",
  "seo",
  "developers",
  "forms",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_ACTIONS = {
  "account.login": "account",
  "account.login_locked": "account",
  "account.2fa_enabled": "account",
  "account.2fa_disabled": "account",
  "account.password_changed": "account",
  "account.password_reset": "account",
  "account.session_revoked": "account",
  "account.sessions_revoked": "account",
  "account.screen_lock_enabled": "account",
  "account.screen_lock_disabled": "account",
  "account.impersonated": "account",

  "member.invited": "members",
  "member.invite_withdrawn": "members",
  "member.joined": "members",
  "member.role_changed": "members",
  "member.removed": "members",
  "member.left": "members",

  "workspace.created": "workspace",
  "workspace.renamed": "workspace",
  "workspace.share_updated": "workspace",
  "workspace.changed": "workspace",
  "branding.updated": "workspace",
  "sidebar.updated": "workspace",
  "media.uploaded": "workspace",
  "media.renamed": "workspace",
  "media.deleted": "workspace",
  "media.bulk_deleted": "workspace",

  "site.added": "sites",
  "site.removed": "sites",

  "goal.created": "analytics",
  "goal.updated": "analytics",
  "goal.deleted": "analytics",
  "dashboard.created": "analytics",
  "dashboard.updated": "analytics",
  "dashboard.duplicated": "analytics",
  "dashboard.deleted": "analytics",
  "embed.created": "analytics",
  "embed.updated": "analytics",
  "embed.deleted": "analytics",
  "report.created": "analytics",
  "report.updated": "analytics",
  "report.deleted": "analytics",
  "report.test_sent": "analytics",
  "segment.created": "analytics",
  "segment.updated": "analytics",
  "segment.deleted": "analytics",
  "marker.created": "analytics",
  "marker.updated": "analytics",
  "marker.deleted": "analytics",
  "funnel.created": "analytics",
  "funnel.updated": "analytics",
  "funnel.deleted": "analytics",

  "seo.audit_run": "seo",
  "seo.crawl_run": "seo",
  "seo.report_deleted": "seo",
  "seo.report_shared": "seo",
  "competitor.added": "seo",
  "competitor.removed": "seo",
  "backlink.removed": "seo",
  "search_console.disconnected": "seo",
  "search_console.linked": "seo",
  "search_console.unlinked": "seo",
  "sitemap.submitted": "seo",
  "sitemap.removed": "seo",

  "api_key.created": "developers",
  "api_key.updated": "developers",
  "api_key.revoked": "developers",

  "form.created": "forms",
  "form.duplicated": "forms",
  "form.imported": "forms",
  "form.published": "forms",
  "form.unpublished": "forms",
  "form.deleted": "forms",
  "form.submission_deleted": "forms",
  "form.submissions_deleted": "forms",
  "form.payments_updated": "forms",
  "form.payments_disconnected": "forms",
  "form.app_connected": "forms",
  "form.app_disconnected": "forms",
  "form.webhook_updated": "forms",
} as const satisfies Record<string, AuditCategory>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[];

export const FORMS_ACTIONS = ACTION_NAMES.filter((a) => AUDIT_ACTIONS[a] === "forms");

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && value in AUDIT_ACTIONS;
}

export function isAuditCategory(value: unknown): value is AuditCategory {
  return typeof value === "string" && (AUDIT_CATEGORIES as readonly string[]).includes(value);
}

export function actionsIn(category: AuditCategory): AuditAction[] {
  return ACTION_NAMES.filter((a) => AUDIT_ACTIONS[a] === category);
}
