import { Effect } from "effect";
import { InvalidArgument, UnresolvableGrantByEmailAddress } from "./Backend.ts";
import type {
  AccessControlPolicy,
  AclGrant,
  AclGrantee,
  CannedAcl,
  OwnerInfo,
} from "./Backend.ts";

export const GROUP_URI_ALL_USERS =
  "http://acs.amazonaws.com/groups/global/AllUsers";
export const GROUP_URI_AUTHENTICATED_USERS =
  "http://acs.amazonaws.com/groups/global/AuthenticatedUsers";

const CANNED_ACL_NAMES: readonly CannedAcl[] = [
  "private",
  "public-read",
  "public-read-write",
  "authenticated-read",
  "bucket-owner-read",
  "bucket-owner-full-control",
];

export const isCannedAcl = (value: string): value is CannedAcl =>
  (CANNED_ACL_NAMES as readonly string[]).includes(value);

/**
 * Expands a canned ACL name into the grant list S3 defines for it. The owner
 * always receives FULL_CONTROL; group grants are added per canned ACL.
 * Returns undefined for unknown canned ACL names.
 *
 * The bucket-owner-* canned ACLs are only meaningful on OBJECT ACLs: they
 * grant the bucket owner (a CanonicalUser distinct from the object owner)
 * READ / FULL_CONTROL. When applied to a bucket ACL they are invalid per S3;
 * Herald falls back to the object-owner-only expansion (bucketOwner defaults
 * to the owner) so the request still round-trips.
 */
export const cannedAclToGrants = (
  canned: CannedAcl,
  owner: OwnerInfo,
  bucketOwner: OwnerInfo = owner,
): readonly AclGrant[] => {
  const canonicalGrant = (
    o: OwnerInfo,
    permission: AclGrant["permission"],
  ): AclGrant => ({
    grantee: {
      type: "CanonicalUser",
      id: o.id,
      displayName: o.displayName,
    },
    permission,
  });
  const groupGrant = (
    uri: string,
    permission: AclGrant["permission"],
  ): AclGrant => ({
    grantee: { type: "Group", uri },
    permission,
  });

  switch (canned) {
    case "private":
      return [canonicalGrant(owner, "FULL_CONTROL")];
    case "public-read":
      return [
        groupGrant(GROUP_URI_ALL_USERS, "READ"),
        canonicalGrant(owner, "FULL_CONTROL"),
      ];
    case "public-read-write":
      return [
        groupGrant(GROUP_URI_ALL_USERS, "READ"),
        groupGrant(GROUP_URI_ALL_USERS, "WRITE"),
        canonicalGrant(owner, "FULL_CONTROL"),
      ];
    case "authenticated-read":
      return [
        groupGrant(GROUP_URI_AUTHENTICATED_USERS, "READ"),
        canonicalGrant(owner, "FULL_CONTROL"),
      ];
    case "bucket-owner-read":
      return [
        canonicalGrant(owner, "FULL_CONTROL"),
        canonicalGrant(bucketOwner, "READ"),
      ];
    case "bucket-owner-full-control":
      return [
        canonicalGrant(owner, "FULL_CONTROL"),
        canonicalGrant(bucketOwner, "FULL_CONTROL"),
      ];
  }
};

/**
 * The default ACL for a fresh bucket/object: the owner holds FULL_CONTROL.
 */
export const defaultPolicy = (owner: OwnerInfo): AccessControlPolicy => ({
  owner,
  grants: [
    {
      grantee: {
        type: "CanonicalUser",
        id: owner.id,
        displayName: owner.displayName,
      },
      permission: "FULL_CONTROL",
    },
  ],
});

/**
 * Resolves a canned ACL name (or a full policy) into a concrete policy using
 * the backend's canonical owner. Used by backends when persisting ACLs.
 */
export const resolveAclInput = (
  acl: AccessControlPolicy | CannedAcl,
  owner: OwnerInfo,
  bucketOwner: OwnerInfo = owner,
): AccessControlPolicy => {
  if (typeof acl === "string") {
    const grants = cannedAclToGrants(acl, owner, bucketOwner);
    if (grants === undefined) {
      // Unknown canned ACL: fall back to the default private policy.
      return defaultPolicy(owner);
    }
    return { owner, grants };
  }
  return acl;
};

interface CompactGrant {
  t: "C" | "G" | "E";
  i?: string;
  d?: string;
  u?: string;
  e?: string;
  p: string;
}

interface CompactPolicy {
  readonly o: { readonly i: string; readonly d: string };
  readonly g: readonly CompactGrant[];
}

const GRANTEE_TYPE_CODE: Record<AclGrantee["type"], CompactGrant["t"]> = {
  CanonicalUser: "C",
  Group: "G",
  AmazonCustomerByEmail: "E",
};

const GRANTEE_TYPE_FROM_CODE: Record<CompactGrant["t"], AclGrantee["type"]> = {
  C: "CanonicalUser",
  G: "Group",
  E: "AmazonCustomerByEmail",
};

/**
 * Encodes a policy as a compact JSON string for storage in Swift metadata,
 * which limits metadata values to 256 bytes. The full AccessControlPolicy XML
 * JSON exceeds that limit once URL-encoded, so keys are abbreviated.
 */
export const encodeCompactPolicy = (policy: AccessControlPolicy): string =>
  JSON.stringify(
    {
      o: { i: policy.owner.id, d: policy.owner.displayName },
      g: policy.grants.map((grant) => {
        const compact: CompactGrant = {
          t: GRANTEE_TYPE_CODE[grant.grantee.type],
          p: grant.permission,
        };
        if (grant.grantee.id !== undefined) compact.i = grant.grantee.id;
        if (grant.grantee.displayName !== undefined) {
          compact.d = grant.grantee.displayName;
        }
        if (grant.grantee.uri !== undefined) compact.u = grant.grantee.uri;
        if (grant.grantee.emailAddress !== undefined) {
          compact.e = grant.grantee.emailAddress;
        }
        return compact;
      }),
    } satisfies CompactPolicy,
  );

/**
 * Decodes a compact policy string produced by encodeCompactPolicy. Returns
 * undefined when the value is not a valid compact policy (e.g. legacy or
 * foreign metadata).
 */
export const decodeCompactPolicy = (
  value: string,
): AccessControlPolicy | undefined => {
  try {
    const parsed = JSON.parse(value) as CompactPolicy;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.o === undefined ||
      typeof parsed.o.i !== "string" ||
      !Array.isArray(parsed.g)
    ) {
      return undefined;
    }
    return {
      owner: {
        id: parsed.o.i,
        displayName: parsed.o.d ?? parsed.o.i,
      },
      grants: (parsed.g as readonly CompactGrant[]).map((grant) => ({
        grantee: {
          type: GRANTEE_TYPE_FROM_CODE[grant.t] ?? "CanonicalUser",
          id: grant.i,
          displayName: grant.d,
          uri: grant.u,
          emailAddress: grant.e,
        },
        permission: grant.p as AclGrant["permission"],
      })),
    } satisfies AccessControlPolicy;
  } catch {
    return undefined;
  }
};

const GRANT_HEADER_PERMISSION: Record<string, AclGrant["permission"]> = {
  "x-amz-grant-read": "READ",
  "x-amz-grant-write": "WRITE",
  "x-amz-grant-read-acp": "READ_ACP",
  "x-amz-grant-write-acp": "WRITE_ACP",
  "x-amz-grant-full-control": "FULL_CONTROL",
};

const getHeaderValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (!entry) return undefined;
  const value = entry[1];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Parses the x-amz-grant-* headers (x-amz-grant-read, -write, -read-acp,
 * -write-acp, -full-control) into grants. Each header value is a comma-
 * separated list of grantee specifiers of the form id=<canonical-id>,
 * emailAddress=<email>, or uri=<group-uri>. Returns undefined when no grant
 * headers are present.
 */
export const parseGrantHeaders = (
  headers: Record<string, string | string[] | undefined>,
): readonly AclGrant[] | undefined => {
  const grants: AclGrant[] = [];
  for (const [header, permission] of Object.entries(GRANT_HEADER_PERMISSION)) {
    const value = getHeaderValue(headers, header);
    if (value === undefined || value === "") continue;
    for (const spec of value.split(",")) {
      const trimmed = spec.trim();
      if (trimmed === "") continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const kind = trimmed.slice(0, eq).trim();
      const granteeValue = trimmed.slice(eq + 1).trim();
      let grantee: AclGrantee;
      if (kind === "id") {
        grantee = { type: "CanonicalUser", id: granteeValue };
      } else if (kind === "emailAddress") {
        grantee = { type: "AmazonCustomerByEmail", emailAddress: granteeValue };
      } else if (kind === "uri") {
        grantee = { type: "Group", uri: granteeValue };
      } else {
        continue;
      }
      grants.push({ grantee, permission });
    }
  }
  return grants.length > 0 ? grants : undefined;
};

/**
 * Validates a policy's grants against the set of known canonical user IDs
 * (the configured access keys). Returns an error message when a grant is
 * invalid, or undefined when the policy is acceptable.
 *
 * - CanonicalUser grantees must reference a known user id (S3 rejects grants
 *   to nonexistent canonical IDs with InvalidArgument).
 * - AmazonCustomerByEmail grantees cannot be resolved without a user
 *   directory, so they are rejected with UnresolvableGrantByEmailAddress
 *   (matching s3-tests test_bucket_acl_grant_email_not_exist).
 */
export const validatePolicyGrants = (
  policy: AccessControlPolicy,
  knownIds: ReadonlySet<string>,
): string | undefined => {
  for (const grant of policy.grants) {
    if (grant.grantee.type === "CanonicalUser") {
      const id = grant.grantee.id;
      // The policy owner is by definition a valid canonical user (clients
      // round-trip the GET response's owner back in the owner grant).
      if (
        id !== undefined && id !== "" && !knownIds.has(id) &&
        id !== policy.owner.id
      ) {
        return `Invalid id: ${id}`;
      }
    } else if (grant.grantee.type === "AmazonCustomerByEmail") {
      return `Unresolvable grant by email address: ${
        grant.grantee.emailAddress ?? ""
      }`;
    }
  }
  return undefined;
};

/**
 * Resolves AmazonCustomerByEmail grantees against the known user emails
 * (email -> canonical user id, derived from the configured auth
 * credentials). Emails with no matching user are left untouched so
 * validatePolicyGrants rejects them with UnresolvableGrantByEmailAddress.
 */
export const resolveEmailGrants = (
  policy: AccessControlPolicy,
  knownEmails: ReadonlyMap<string, string>,
): AccessControlPolicy => ({
  ...policy,
  grants: policy.grants.map((grant): AclGrant => {
    if (grant.grantee.type !== "AmazonCustomerByEmail") return grant;
    const id = knownEmails.get(grant.grantee.emailAddress ?? "");
    if (id === undefined) return grant;
    return {
      ...grant,
      grantee: { type: "CanonicalUser", id, displayName: id },
    };
  }),
});

/**
 * Builds the email -> canonical user id map used to resolve
 * AmazonCustomerByEmail grantees from the configured auth credentials.
 */
export const knownEmailsFromCredentials = (
  creds: readonly { readonly email?: string; readonly accessKeyId: string }[],
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const cred of creds) {
    if (cred.email !== undefined) map.set(cred.email, cred.accessKeyId);
  }
  return map;
};

/**
 * Maps a validatePolicyGrants error message to the S3 error the ACL PUT
 * handlers must fail with.
 */
export const aclValidationError = (validationError: string) =>
  validationError.startsWith("Unresolvable grant by email")
    ? Effect.fail(
      new UnresolvableGrantByEmailAddress({ message: validationError }),
    )
    : Effect.fail(new InvalidArgument({ message: validationError }));
