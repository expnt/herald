import { normalizeHeaders } from "../../Services/S3HeaderService.ts";

/**
 * RFC 7232 conditional request support.
 *
 * S3 semantics (as exercised by s3-tests):
 * - If-Match: fail 412 when no current representation matches (lists and `*`
 *   supported; weak validators are ignored).
 * - If-None-Match: on GET/HEAD a match yields 304 Not Modified; on write
 *   methods a match yields 412.
 * - If-Modified-Since: GET/HEAD only; not modified since the date yields 304.
 * - If-Unmodified-Since: modified since the date yields 412.
 * - Precedence (RFC 7232 section 6): If-Match over If-Unmodified-Since;
 *   If-None-Match over If-Modified-Since.
 */

export type PreconditionOutcome =
  | { readonly kind: "proceed" }
  | { readonly kind: "notModified" }
  | { readonly kind: "preconditionFailed" };

export interface ConditionalHeaders {
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: Date;
  readonly ifUnmodifiedSince?: Date;
}

export type PreconditionMethod = "GET" | "HEAD" | "PUT" | "DELETE" | "POST";

const parseHttpDate = (raw: string | undefined): Date | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const parseConditionalHeaders = (
  raw: Record<string, string | string[] | undefined> | unknown,
): ConditionalHeaders => {
  const normalized = normalizeHeaders(raw);
  const ifMatch = normalized["if-match"];
  const ifNoneMatch = normalized["if-none-match"];
  return {
    ifMatch: ifMatch !== undefined && ifMatch.trim() !== ""
      ? ifMatch
      : undefined,
    ifNoneMatch: ifNoneMatch !== undefined && ifNoneMatch.trim() !== ""
      ? ifNoneMatch
      : undefined,
    ifModifiedSince: parseHttpDate(normalized["if-modified-since"]),
    ifUnmodifiedSince: parseHttpDate(normalized["if-unmodified-since"]),
  };
};

export const hasConditionalHeaders = (
  conditions: ConditionalHeaders,
): boolean =>
  conditions.ifMatch !== undefined || conditions.ifNoneMatch !== undefined ||
  conditions.ifModifiedSince !== undefined ||
  conditions.ifUnmodifiedSince !== undefined;

const CONDITIONAL_HEADER_KEYS = [
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
];

/**
 * Removes conditional headers so the backend never re-evaluates them (the
 * frontend has already decided whether to proceed). Backends either lack
 * native support (Swift) or would surface 304/412 as unmapped errors (S3 SDK).
 */
export const stripConditionalHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> => {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CONDITIONAL_HEADER_KEYS.includes(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
};

/**
 * Normalizes an entity-tag for comparison: strips a weak `W/` prefix and
 * surrounding quotes so quoted and unquoted client values compare equal.
 */
const normalizeEtag = (tag: string): string => {
  let t = tag.trim();
  if (t.startsWith("W/")) t = t.slice(2).trim();
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
};

/**
 * True when the header value (a comma-separated list of entity-tags, or `*`)
 * matches the current representation's ETag. `*` matches any existing
 * representation; weak validators are ignored for comparison.
 */
const etagMatches = (
  headerValue: string,
  currentEtag: string | undefined,
): boolean => {
  if (currentEtag === undefined) return false;
  const current = normalizeEtag(currentEtag);
  const tags = headerValue.split(",").map((t) => t.trim()).filter((t) =>
    t !== ""
  );
  for (const tag of tags) {
    if (tag === "*") return true;
    if (normalizeEtag(tag) === current) return true;
  }
  return false;
};

export const evaluatePreconditions = (input: {
  readonly conditions: ConditionalHeaders;
  readonly etag?: string;
  readonly lastModified?: Date;
  readonly method: PreconditionMethod;
}): PreconditionOutcome => {
  const { conditions, etag, lastModified, method } = input;
  const isRead = method === "GET" || method === "HEAD";

  // 1. If-Match: false -> 412 (all methods).
  if (conditions.ifMatch !== undefined) {
    if (!etagMatches(conditions.ifMatch, etag)) {
      return { kind: "preconditionFailed" };
    }
  }

  // 2. If-Unmodified-Since: only evaluated when If-Match is absent. RFC 7232
  //    section 6 gives If-Match precedence: when If-Match is present and true,
  //    If-Unmodified-Since is ignored. (S3 additionally evaluates
  //    If-Unmodified-Since on GET when If-Match is absent.)
  if (
    conditions.ifMatch === undefined &&
    conditions.ifUnmodifiedSince !== undefined
  ) {
    if (
      lastModified !== undefined &&
      lastModified.getTime() > conditions.ifUnmodifiedSince.getTime()
    ) {
      return { kind: "preconditionFailed" };
    }
  }

  // 3. If-None-Match: match -> 304 (GET/HEAD) or 412 (write methods).
  if (conditions.ifNoneMatch !== undefined) {
    if (etagMatches(conditions.ifNoneMatch, etag)) {
      return isRead ? { kind: "notModified" } : { kind: "preconditionFailed" };
    }
  }

  // 4. If-Modified-Since: GET/HEAD only, and only when If-None-Match is absent.
  if (isRead && conditions.ifModifiedSince !== undefined) {
    if (
      lastModified !== undefined &&
      lastModified.getTime() <= conditions.ifModifiedSince.getTime()
    ) {
      return { kind: "notModified" };
    }
  }

  return { kind: "proceed" };
};
