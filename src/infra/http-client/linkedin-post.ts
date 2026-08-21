import axios from "axios";

/**
 * Publishing to a member's personal LinkedIn feed.
 *
 * Two calls, in order: the Images API takes the bytes and hands back an image
 * URN, then the Posts API publishes a post referencing that URN. Both live on
 * the versioned `/rest` surface, which is a different host prefix and a
 * different header set from the `/v2` userinfo call in `linkedin-auth` — hence
 * a separate module rather than more functions there.
 *
 * Author is always `urn:li:person:<sub>`. Organisation posting is deliberately
 * not implemented: the app connects a member's own profile, and the company
 * page exists only as the developer app's owner.
 */

const REST_BASE = "https://api.linkedin.com/rest";

/**
 * The dated API version LinkedIn pins requests to, as `YYYYMM`.
 *
 * LinkedIn supports each version for about two years and then sunsets it,
 * answering `426 Upgrade Required` to anything still asking for it. There is no
 * "latest" to point at — the header is mandatory and unversioned requests are
 * rejected — so this value has to be maintained.
 *
 * Configurable so a sunset is fixed by setting `LINKEDIN_API_VERSION` and
 * redeploying, without waiting on a code change. Bump the default whenever the
 * request schema is re-checked against LinkedIn's docs.
 */
function apiVersion(): string {
  return process.env.LINKEDIN_API_VERSION || "202608";
}

/** The headers every versioned REST call needs. */
function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": apiVersion(),
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

/**
 * A failure with a cause the caller can act on differently.
 *
 * `auth` is the one that matters: a 401 means the stored token is dead, and the
 * route responds by marking the connection invalid and telling the user to
 * reconnect rather than retrying with a credential that cannot work.
 */
export type LinkedInErrorKind =
  | "auth"
  | "permission"
  | "rate-limit"
  | "version"
  | "api"
  | "network";

export class LinkedInApiError extends Error {
  readonly kind: LinkedInErrorKind;
  /** LinkedIn's HTTP status, where there was a response at all. */
  readonly status: number;

  constructor(kind: LinkedInErrorKind, status: number, message: string) {
    super(message);
    this.name = "LinkedInApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** Map a LinkedIn HTTP status onto the kinds above. */
function kindForStatus(status: number): LinkedInErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate-limit";
  // LinkedIn retires each dated version roughly two years after release and
  // answers 426 once ours is past its sunset. Called out separately because the
  // fix is a deployment setting — `LINKEDIN_API_VERSION` — not anything the user
  // can do, and a generic "could not publish" would send them hunting in the
  // wrong place. See the version note above.
  if (status === 426) return "version";
  return "api";
}

export type UploadedImage = {
  /** `urn:li:image:...`, the handle the Posts API references. */
  urn: string;
};

/**
 * Upload image bytes and return the resulting image URN.
 *
 * Two steps, as the Images API requires: `initializeUpload` reserves a URN and
 * returns a single-use upload URL, then the raw bytes go to that URL with a
 * PUT. The upload URL is pre-signed, so the second request carries no bearer
 * token of ours.
 */
export async function uploadImage(
  accessToken: string,
  memberId: string,
  bytes: Buffer,
  mime: string,
): Promise<UploadedImage> {
  let init;
  try {
    init = await axios.post(
      `${REST_BASE}/images?action=initializeUpload`,
      { initializeUploadRequest: { owner: `urn:li:person:${memberId}` } },
      {
        headers: { ...restHeaders(accessToken), "Content-Type": "application/json" },
        timeout: 15000,
        validateStatus: () => true,
      },
    );
  } catch {
    throw new LinkedInApiError("network", 0, "could not reach LinkedIn to start the image upload");
  }

  if (init.status !== 200 || !init.data?.value?.uploadUrl || !init.data?.value?.image) {
    throw new LinkedInApiError(
      kindForStatus(init.status),
      init.status,
      `image upload could not be initialized (status ${init.status})`,
    );
  }

  const { uploadUrl, image } = init.data.value as { uploadUrl: string; image: string };

  let put;
  try {
    put = await axios.put(uploadUrl, bytes, {
      headers: {
        "Content-Type": mime,
        // Set explicitly: the upload is rejected without an accurate length,
        // and axios does not always infer it for a raw Buffer body.
        "Content-Length": String(bytes.length),
      },
      timeout: 30000,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
  } catch {
    throw new LinkedInApiError("network", 0, "could not reach LinkedIn to upload the image");
  }

  // The byte upload answers 200 or 201 depending on the storage backend.
  if (put.status !== 200 && put.status !== 201) {
    throw new LinkedInApiError(
      kindForStatus(put.status),
      put.status,
      `image bytes were rejected (status ${put.status})`,
    );
  }

  return { urn: image };
}

export type CreatedPost = {
  /** `urn:li:share:...` or `urn:li:ugcPost:...`, from the response header. */
  postUrn: string;
  /** A viewable permalink, only when the URN is one we can address reliably. */
  postUrl: string | null;
};

/**
 * Publish a post carrying a caption and one uploaded image.
 *
 * The created post's URN comes back in the `x-restli-id` header rather than the
 * body, which is empty on success.
 */
export async function createImagePost(
  accessToken: string,
  memberId: string,
  commentary: string,
  imageUrn: string,
): Promise<CreatedPost> {
  return createPost(accessToken, memberId, commentary, { media: { id: imageUrn } });
}

export const MAX_MULTI_IMAGE = 10;

 
export async function createMultiImagePost(
  accessToken: string,
  memberId: string,
  commentary: string,
  imageUrns: string[],
): Promise<CreatedPost> {
  if (imageUrns.length < 2) {
    throw new LinkedInApiError("api", 0, "a multi-image post needs at least two images");
  }
  if (imageUrns.length > MAX_MULTI_IMAGE) {
    throw new LinkedInApiError(
      "api",
      0,
      `a post can carry at most ${MAX_MULTI_IMAGE} images`,
    );
  }

  return createPost(accessToken, memberId, commentary, {
    multiImage: { images: imageUrns.map((id) => ({ id, altText: "" })) },
  });
}

/**
 * Publish a post carrying only a caption.
 *
 * Same call without a `content` block, which the Posts API treats as a text
 * post. LinkedIn builds its own preview from any link in the commentary, so a
 * scheduled post with no image still arrives with something to look at.
 */
export async function createTextPost(
  accessToken: string,
  memberId: string,
  commentary: string,
): Promise<CreatedPost> {
  return createPost(accessToken, memberId, commentary, undefined);
}

/**
 * The shared body of both post types.
 *
 * `content` is omitted entirely rather than sent empty: the API rejects a
 * `content` object with no media inside it.
 */
async function createPost(
  accessToken: string,
  memberId: string,
  commentary: string,
  content:
    | { media: { id: string } }
    | { multiImage: { images: { id: string; altText: string }[] } }
    | undefined,
): Promise<CreatedPost> {
  const payload = {
    author: `urn:li:person:${memberId}`,
    commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    ...(content ? { content } : {}),
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  let res;
  try {
    res = await axios.post(`${REST_BASE}/posts`, payload, {
      headers: { ...restHeaders(accessToken), "Content-Type": "application/json" },
      timeout: 20000,
      validateStatus: () => true,
    });
  } catch {
    throw new LinkedInApiError("network", 0, "could not reach LinkedIn to publish the post");
  }

  if (res.status !== 201 && res.status !== 200) {
    throw new LinkedInApiError(
      kindForStatus(res.status),
      res.status,
      `post was not created (status ${res.status})`,
    );
  }

  const postUrn = String(res.headers["x-restli-id"] ?? res.data?.id ?? "");

  return { postUrn, postUrl: permalink(postUrn) };
}

/**
 * Build a viewable link for a created post.
 *
 * Only `urn:li:share:<id>` and `urn:li:ugcPost:<id>` map onto a stable public
 * URL. Anything else returns null and the UI simply omits the link — inventing
 * a URL that 404s is worse than not offering one.
 */
function permalink(postUrn: string): string | null {
  const match = /^urn:li:(share|ugcPost):(\d+)$/.exec(postUrn);
  if (!match) return null;
  return `https://www.linkedin.com/feed/update/${postUrn}/`;
}
