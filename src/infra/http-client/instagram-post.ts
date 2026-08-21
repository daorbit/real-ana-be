import axios from "axios";

/**
 * Publishing an image to a connected Instagram professional account.
 *
 * Two calls, in order: create a media container pointing at a public image URL,
 * then publish that container. Instagram does the fetching, which is the one
 * structural difference from the LinkedIn publisher beside this file — LinkedIn
 * issues an upload target and wants the bytes, Instagram wants a URL it can
 * reach itself and will reject anything it cannot download.
 *
 * That inverts where the image comes from. The scheduler already stores every
 * post's image as a Cloudinary URL, so nothing has to be fetched into this
 * process at all; the URL is handed straight over. It also means an image behind
 * a signed or expiring URL will fail, which is why `assertPublicImageUrl` below
 * refuses anything that is not plain https.
 */

const GRAPH_BASE = "https://graph.instagram.com";

/**
 * The Graph API version this app pins to.
 *
 * Meta supports each version for about two years, then rejects calls to it.
 * Configurable so a sunset is fixed by setting `INSTAGRAM_API_VERSION` and
 * redeploying — the same escape hatch as `LINKEDIN_API_VERSION`.
 */
function apiVersion(): string {
  return process.env.INSTAGRAM_API_VERSION || "v23.0";
}

/**
 * A failure with a cause the caller can act on differently.
 *
 * Mirrors `LinkedInErrorKind` deliberately: the post runner branches on these
 * names, and having the two providers agree on the vocabulary is what keeps
 * that branch from growing a second shape. `container` is the one Instagram
 * needs and LinkedIn does not — a container that never becomes ready is a
 * problem with the image, not with the token or the permission.
 */
export type InstagramErrorKind =
  | "auth"
  | "permission"
  | "rate-limit"
  | "version"
  | "container"
  | "api"
  | "network";

export class InstagramApiError extends Error {
  readonly kind: InstagramErrorKind;
  /** Instagram's HTTP status, where there was a response at all. */
  readonly status: number;

  constructor(kind: InstagramErrorKind, status: number, message: string) {
    super(message);
    this.name = "InstagramApiError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Map a Graph API response onto the kinds above.
 *
 * The status alone is not enough: Graph answers 400 for a genuinely expired
 * token as readily as for a malformed caption, and distinguishes them only in
 * the error subcodes. 190 is the OAuth family — expired, revoked, or invalidated
 * by a password change — and all of those mean "reconnect", not "retry".
 */
function kindFor(status: number, code: unknown, subcode: unknown): InstagramErrorKind {
  if (status === 401 || code === 190) return "auth";
  // 10 and the 200-block are permission errors: the account did not grant
  // publishing, or is a personal account that cannot use the API at all.
  if (status === 403 || code === 10 || (typeof code === "number" && code >= 200 && code < 300)) {
    return "permission";
  }
  // 4 is the app-level rate limit, 17 the user-level one, 32 the page one, and
  // 613 the endpoint-specific throttle. Instagram also caps publishing at 50
  // posts per account per rolling 24 hours, which arrives as 9.
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 9) {
    return "rate-limit";
  }
  if (subcode === 2207003 || subcode === 2207020 || subcode === 2207052) return "container";
  if (status >= 500) return "network";
  return "api";
}

/** Turn a non-200 Graph response into a typed error, without leaking the body. */
function graphError(status: number, data: unknown): InstagramApiError {
  const error = (data as { error?: Record<string, unknown> } | undefined)?.error ?? {};
  const code = error.code;
  const subcode = error.error_subcode;
  // `error_user_msg` is Meta's own text written for an end user, and is the one
  // field here worth surfacing. The rest of the body is not: it echoes request
  // parameters, which on these calls include the access token.
  const message = [error.error_user_msg, error.message]
    .filter((v) => typeof v === "string" && v)
    .join(": ");

  return new InstagramApiError(
    kindFor(status, code, subcode),
    status,
    message || `instagram api error (status ${status})`,
  );
}

/**
 * Reject an image URL Instagram will not be able to fetch.
 *
 * Checked before the container is created so the failure names the real cause.
 * Instagram's own answer to an unreachable URL is a container that silently
 * finishes in `ERROR` state several seconds later, with a subcode that says only
 * "media download failed" — which is a much worse thing to put in front of a
 * user than "the image is not publicly reachable".
 */
function assertPublicImageUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InstagramApiError("container", 0, "The post image URL is not valid.");
  }

  // http is refused as well as the obvious localhost cases: Instagram fetches
  // over the public internet and will not follow a plaintext or private address.
  if (parsed.protocol !== "https:") {
    throw new InstagramApiError("container", 0, "The post image must be served over HTTPS.");
  }
  if (/^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname)) {
    throw new InstagramApiError(
      "container",
      0,
      "The post image is not reachable from the internet, so Instagram cannot fetch it.",
    );
  }
}

/**
 * Create a media container for a single image post.
 *
 * The container is a staging record, not a post: Instagram downloads the image
 * asynchronously and the container is only publishable once that finishes. See
 * `waitForContainer`.
 */
export async function createImageContainer(
  accessToken: string,
  igUserId: string,
  imageUrl: string,
  caption: string,
): Promise<string> {
  assertPublicImageUrl(imageUrl);

  const { status, data } = await axios.post(
    `${GRAPH_BASE}/${apiVersion()}/${igUserId}/media`,
    null,
    {
      params: { image_url: imageUrl, caption, access_token: accessToken },
      timeout: 30000,
      validateStatus: () => true,
    },
  );

  if (status !== 200 || !data?.id) throw graphError(status, data);
  return String(data.id);
}

/**
 * Wait until Instagram has finished fetching the image.
 *
 * Publishing a container still in `IN_PROGRESS` fails, and the fetch routinely
 * takes a few seconds for a large image. Polled rather than retried blindly so
 * the common case — ready on the first check — costs one call.
 *
 * The ceiling is deliberately well inside the platform's function timeout: this
 * runs on the cron path, which publishes up to twenty posts in one invocation,
 * so a single slow image must not be allowed to consume the whole budget.
 */
async function waitForContainer(accessToken: string, containerId: string): Promise<void> {
  /** Roughly 30 seconds of waiting, back off included. */
  const MAX_ATTEMPTS = 10;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { status, data } = await axios.get(`${GRAPH_BASE}/${apiVersion()}/${containerId}`, {
      params: { fields: "status_code,status", access_token: accessToken },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (status !== 200) throw graphError(status, data);

    const state = String(data?.status_code ?? "");
    if (state === "FINISHED") return;
    if (state === "ERROR" || state === "EXPIRED") {
      // `status` carries Meta's own explanation of which check failed — an
      // aspect ratio outside 4:5 to 1.91:1, a file over 8MB, an unreachable URL.
      // It is Meta's text about the media, with no token or request echo in it.
      const detail = String(data?.status ?? "").trim();
      throw new InstagramApiError(
        "container",
        200,
        detail || "Instagram could not process the post image.",
      );
    }

    // Linear back-off: 1s, 2s, 3s… Enough to clear a normal fetch quickly
    // without hammering the endpoint while a large image downloads.
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }

  throw new InstagramApiError(
    "container",
    200,
    "Instagram is still processing the post image. This run was skipped.",
  );
}

/**
 * Publish a prepared container, returning the created media's id and permalink.
 *
 * The permalink is fetched separately and best-effort: the post is already live
 * by then, and failing the publish because the link could not be read would
 * report a success as a failure — and, on the cron path, cause a retry that
 * posts the same image twice.
 */
export async function publishContainer(
  accessToken: string,
  igUserId: string,
  containerId: string,
): Promise<{ mediaId: string; permalink: string | null }> {
  await waitForContainer(accessToken, containerId);

  const { status, data } = await axios.post(
    `${GRAPH_BASE}/${apiVersion()}/${igUserId}/media_publish`,
    null,
    {
      params: { creation_id: containerId, access_token: accessToken },
      timeout: 30000,
      validateStatus: () => true,
    },
  );

  if (status !== 200 || !data?.id) throw graphError(status, data);

  const mediaId = String(data.id);
  return { mediaId, permalink: await fetchPermalink(accessToken, mediaId) };
}

/** The public URL of a published media, or null if it could not be read. */
async function fetchPermalink(accessToken: string, mediaId: string): Promise<string | null> {
  try {
    const { status, data } = await axios.get(`${GRAPH_BASE}/${apiVersion()}/${mediaId}`, {
      params: { fields: "permalink", access_token: accessToken },
      timeout: 10000,
      validateStatus: () => true,
    });
    return status === 200 && data?.permalink ? String(data.permalink) : null;
  } catch {
    return null;
  }
}

/**
 * Create and publish an image post in one call.
 *
 * One image or several: a single URL takes the plain container path, and more
 * than one becomes a carousel. Reels and stories use the same mechanism with
 * further parameters, and can be added here without the routes or the runner
 * changing shape.
 */
export async function createImagePost(
  accessToken: string,
  igUserId: string,
  imageUrl: string | string[],
  caption: string,
): Promise<{ mediaId: string; permalink: string | null }> {
  const urls = Array.isArray(imageUrl) ? imageUrl.filter(Boolean) : [imageUrl];
  if (urls.length === 0) {
    throw new InstagramApiError("container", 0, "An Instagram post needs an image.");
  }
  if (urls.length > MAX_CAROUSEL_ITEMS) {
    throw new InstagramApiError(
      "container",
      0,
      `A carousel can hold at most ${MAX_CAROUSEL_ITEMS} images.`,
    );
  }

  if (urls.length === 1) {
    const containerId = await createImageContainer(accessToken, igUserId, urls[0], caption);
    return publishContainer(accessToken, igUserId, containerId);
  }

  const containerId = await createCarouselContainer(accessToken, igUserId, urls, caption);
  return publishContainer(accessToken, igUserId, containerId);
}

/** Instagram's own ceiling on a carousel, which LinkedIn's multi-image shares. */
export const MAX_CAROUSEL_ITEMS = 10;

 
export async function createCarouselContainer(
  accessToken: string,
  igUserId: string,
  imageUrls: string[],
  caption: string,
): Promise<string> {
  imageUrls.forEach(assertPublicImageUrl);

  const childIds: string[] = [];
  for (const url of imageUrls) {
    const { status, data } = await axios.post(
      `${GRAPH_BASE}/${apiVersion()}/${igUserId}/media`,
      null,
      {
        params: {
          image_url: url,
          is_carousel_item: true,
          access_token: accessToken,
        },
        timeout: 30000,
        validateStatus: () => true,
      },
    );

    if (status !== 200 || !data?.id) throw graphError(status, data);
    childIds.push(String(data.id));
  }

  const { status, data } = await axios.post(
    `${GRAPH_BASE}/${apiVersion()}/${igUserId}/media`,
    null,
    {
      params: {
        media_type: "CAROUSEL",
        // Graph takes the children as one comma-separated parameter, in the
        // order the slides should appear.
        children: childIds.join(","),
        caption,
        access_token: accessToken,
      },
      timeout: 30000,
      validateStatus: () => true,
    },
  );

  if (status !== 200 || !data?.id) throw graphError(status, data);
  return String(data.id);
}
