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
 */
export const cannedAclToGrants = (
  canned: CannedAcl,
  owner: OwnerInfo,
): readonly AclGrant[] => {
  const ownerGrant: AclGrant = {
    grantee: {
      type: "CanonicalUser",
      id: owner.id,
      displayName: owner.displayName,
    },
    permission: "FULL_CONTROL",
  };
  const groupGrant = (
    uri: string,
    permission: AclGrant["permission"],
  ): AclGrant => ({
    grantee: { type: "Group", uri },
    permission,
  });

  switch (canned) {
    case "private":
      return [ownerGrant];
    case "public-read":
      return [
        groupGrant(GROUP_URI_ALL_USERS, "READ"),
        ownerGrant,
      ];
    case "public-read-write":
      return [
        groupGrant(GROUP_URI_ALL_USERS, "READ"),
        groupGrant(GROUP_URI_ALL_USERS, "WRITE"),
        ownerGrant,
      ];
    case "authenticated-read":
      return [
        groupGrant(GROUP_URI_AUTHENTICATED_USERS, "READ"),
        ownerGrant,
      ];
    case "bucket-owner-read":
      return [
        groupGrant(GROUP_URI_ALL_USERS, "READ"),
        ownerGrant,
      ];
    case "bucket-owner-full-control":
      return [ownerGrant];
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
): AccessControlPolicy => {
  if (typeof acl === "string") {
    const grants = cannedAclToGrants(acl, owner);
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
