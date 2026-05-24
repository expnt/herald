import { Effect } from "effect";
import {
  AccessDenied,
  type ListMultipartUploadsResult,
  type ListObjectsResult,
  NoSuchKey,
} from "./Backend.ts";

export const INTERNAL_STATE_PREFIX = ".hrld/";
export const LEGACY_INTERNAL_PREFIXES = [".mp_segments/", ".mp_meta/"] as const;
export const RESERVED_INTERNAL_PREFIXES = [
  INTERNAL_STATE_PREFIX,
  ...LEGACY_INTERNAL_PREFIXES,
] as const;

const hasReservedPrefix = (value: string): boolean =>
  RESERVED_INTERNAL_PREFIXES.some((prefix) => value.startsWith(prefix));

export const isReservedInternalKey = (key: string): boolean =>
  hasReservedPrefix(key);

export const isReservedInternalPrefix = (prefix: string): boolean =>
  hasReservedPrefix(prefix);

export const ensureClientReadableKey = (
  bucket: string,
  key: string,
): Effect.Effect<void, NoSuchKey> =>
  isReservedInternalKey(key)
    ? Effect.fail(
      new NoSuchKey({
        bucket,
        key,
        message: "The specified key does not exist.",
      }),
    )
    : Effect.void;

export const ensureClientWritableKey = (
  key: string,
): Effect.Effect<void, AccessDenied> =>
  isReservedInternalKey(key)
    ? Effect.fail(new AccessDenied({ message: "Access Denied" }))
    : Effect.void;

const isVisibleCommonPrefix = (prefix: string): boolean =>
  !isReservedInternalPrefix(prefix);

const sanitizeListPagination = (
  result: ListObjectsResult,
): {
  readonly isTruncated: boolean;
  readonly nextMarker?: string;
  readonly nextContinuationToken?: string;
} => {
  const nextMarker = result.nextMarker &&
      !isReservedInternalKey(result.nextMarker)
    ? result.nextMarker
    : undefined;
  const nextContinuationToken = result.nextContinuationToken &&
      !isReservedInternalKey(result.nextContinuationToken)
    ? result.nextContinuationToken
    : undefined;
  const isTruncated = result.isTruncated &&
    (nextMarker !== undefined || nextContinuationToken !== undefined);
  return { isTruncated, nextMarker, nextContinuationToken };
};

export const filterVisibleObjectList = (
  result: ListObjectsResult,
): ListObjectsResult => {
  const contents = result.contents.filter((obj) =>
    !isReservedInternalKey(obj.key)
  );
  const commonPrefixes = result.commonPrefixes.filter((cp) =>
    isVisibleCommonPrefix(cp.prefix)
  );
  const { isTruncated, nextMarker, nextContinuationToken } =
    sanitizeListPagination(result);

  return {
    ...result,
    isTruncated,
    nextMarker,
    nextContinuationToken,
    contents,
    commonPrefixes,
    keyCount: contents.length + commonPrefixes.length,
  };
};

export const filterVisibleMultipartUploads = (
  result: ListMultipartUploadsResult,
): ListMultipartUploadsResult => {
  const uploads = result.uploads.filter((upload) =>
    !isReservedInternalKey(upload.key)
  );
  const commonPrefixes = result.commonPrefixes.filter((cp) =>
    !isReservedInternalPrefix(cp.prefix)
  );
  const nextKeyMarker = result.nextKeyMarker &&
      !isReservedInternalKey(result.nextKeyMarker)
    ? result.nextKeyMarker
    : undefined;
  const isTruncated = result.isTruncated && nextKeyMarker !== undefined;

  return {
    ...result,
    uploads,
    commonPrefixes,
    nextKeyMarker,
    nextUploadIdMarker: isTruncated ? result.nextUploadIdMarker : undefined,
    isTruncated,
  };
};
