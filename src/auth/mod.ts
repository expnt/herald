import { decode, verify } from "djwt";
import { envVarsConfig, globalConfig } from "../config/mod.ts";
import { getLogger } from "../utils/log.ts";
import { retryFetchWithTimeout } from "../utils/url.ts";
import { HTTPException } from "../types/http-exception.ts";
import { HTTP_STATUS_CODES } from "../constants/http_status_codes.ts";
import { Sha256 } from "@aws-crypto/sha256";
import { SignatureV4a } from "aws-sdk/signature-v4a";

interface DecodedToken {
  sub: string;
  "kubernetes.io"?: {
    serviceaccount: {
      name: string;
      uid: string;
    };
  };
}

/**
 * Interface representing a JSON Web Key (JWK) structure for "kube" JWT.
 *
 * @property {string} kid - Key ID
 * @property {string} use - Public Key Use
 * @property {string} kty - Key Type
 * @property {string} alg - Algorithm
 * @property {string} n - Modulus
 * @property {string} e - Exponent
 */
interface KubeJWK {
  kid: string;
  use: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

const logger = getLogger(import.meta);

export async function verifyServiceAccountToken(
  token: string | null,
): Promise<string> {
  logger.info("Verifying service account token...");
  if (!token) {
    const errMessage = "No token provided";
    throw new HTTPException(401, {
      message: errMessage,
    });
  }
  const extractedToken = token.split(" ")[1];
  const payload = await verifyToken(extractedToken);

  const name = payload.sub;
  if (
    !name
  ) {
    const message = "Payload does not contain service account name field";
    logger.error(message);
    throw new HTTPException(HTTP_STATUS_CODES.UNAUTHORIZED, {
      message,
    });
  }

  return name;
}

const jwkExpiration = 24 * 60 * 60 * 1000; // 24 hours
let expirationTime = Date.now() + jwkExpiration;

const cryptoKeys: Map<string, CryptoKey> = new Map();

async function updateKeyCache() {
  logger.info("Updating KubeJWK Cache...");
  const jwks = await getKeys();

  for (const key of jwks) {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["verify"],
    );
    cryptoKeys.set(key.kid, cryptoKey);
  }
}

async function verifyToken(token: string): Promise<DecodedToken> {
  if (cryptoKeys.size === 0 || Date.now() > expirationTime) {
    await updateKeyCache();
  }

  let header: { kid?: string };
  try {
    header = decode(token)[0] as { kid?: string };
  } catch (e) {
    const message = `Error decoding token: ${(e as Error).message}`;
    logger.error(message);
    throw new HTTPException(401, { message });
  }
  const kid = header.kid;
  if (!kid) {
    const message = "Missing kid in token header";
    logger.error(message);
    throw new HTTPException(401, { message });
  }

  const cryptoKey = cryptoKeys.get(kid);
  if (!cryptoKey) {
    const message = `Key with kid ${kid} not found`;
    logger.error(message);
    throw new HTTPException(401, { message });
  }

  logger.info("Verifying token...");
  const verified = await verify(token, cryptoKey);
  return verified as DecodedToken;
}

async function getKeys(): Promise<KubeJWK[]> {
  logger.info("Fetching JWK Keys from k8s API...");
  const currentToken = await getServiceAccountToken();
  const certPath = envVarsConfig.cert_path;
  const caCert = await Deno.readTextFile(certPath);
  const client = Deno.createHttpClient({
    caCerts: [caCert], // Path to your certificate file
  });
  const jwks_uri = await getJWKURI(currentToken, client);
  const jwkUrl = new URL(jwks_uri);
  const headers = new Headers();
  if (envVarsConfig.env === "DEV") {
    // This should be the proxy server created by kubectl for dev purposes inside a local machine
    const k8sUrl = new URL(envVarsConfig.k8s_api);
    jwkUrl.hostname = k8sUrl.hostname;
    jwkUrl.port = k8sUrl.port;
    jwkUrl.protocol = k8sUrl.protocol;
  } else {
    // we need to set the auth headers with the serviceToken when herald is running in a k8s cluster
    headers.set(
      "Authorization",
      `Bearer ${currentToken}`,
    );
  }

  const fetchFunc = async () =>
    await fetch(jwkUrl.toString(), { headers, client });
  const fetchJWK = await retryFetchWithTimeout(
    fetchFunc,
    5,
    1000,
  );

  if (fetchJWK instanceof Error) {
    logger.error(fetchJWK.message);
    throw new HTTPException(500, { message: fetchJWK.message });
  }

  const data = await fetchJWK.json();
  const keys = data.keys;
  if (!keys) {
    const message = "Keys not found in the JWK response";
    logger.error(message);
    throw new HTTPException(HTTP_STATUS_CODES.SERVICE_UNAVAILABLE, {
      message,
    });
  }
  expirationTime = Date.now() + jwkExpiration;

  return keys as KubeJWK[];
}

async function getJWKURI(
  currentToken: string,
  client: Deno.HttpClient,
): Promise<string> {
  logger.info("Fetching JWKS URI from k8s API...");
  const k8s_url = envVarsConfig.k8s_api;
  const headers = envVarsConfig.env === "DEV"
    ? {}
    : { Authorization: `Bearer ${currentToken}` };

  const fetchFunc = async () =>
    await fetch(
      `${k8s_url}/.well-known/openid-configuration`,
      {
        headers,
        client,
      },
    );
  const fetchJWKURI = await retryFetchWithTimeout(
    fetchFunc,
    5,
    1000,
  );

  if (fetchJWKURI instanceof Error) {
    logger.error(fetchJWKURI.message);
    throw new HTTPException(500, { message: fetchJWKURI.message });
  }

  if (fetchJWKURI.status !== 200) {
    logger.error(`Failed to fetch JWKS URI: ${fetchJWKURI.statusText}`);
    throw new HTTPException(500, { message: fetchJWKURI.statusText });
  }

  const data = await fetchJWKURI.json();
  const jwks_uri = data.jwks_uri;

  if (!jwks_uri) {
    const message = "JWKS URI not found in response";
    logger.error(message);
    throw new HTTPException(HTTP_STATUS_CODES.SERVICE_UNAVAILABLE, { message });
  }

  return jwks_uri;
}

async function getServiceAccountToken(): Promise<string> {
  logger.info("Fetching current app service account token...");
  const token = await Deno.readTextFile(
    envVarsConfig.service_account_token_path,
  );
  return token;
}

export function hasBucketAccess(
  serviceAccount: string,
  bucket: string,
): boolean {
  logger.info("Checking if service account has access to bucket...");
  const sa = globalConfig.service_accounts.find((sa) =>
    sa.name === serviceAccount
  );
  if (!sa) {
    throw new HTTPException(401, { message: "Service Account not found" });
  }

  return sa.buckets.includes(bucket);
}

export function getAuthType() {
  return envVarsConfig.auth_type;
}

function parseAuthorizationHeader(
  authHeader: string,
) {
  const sigV4Regex =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=(.+)$/;
  const match = authHeader.match(sigV4Regex);

  if (!match) {
    return null;
  }

  const [
    ,
    accessKeyId,
    dateStamp,
    region,
    service,
    signedHeadersStr,
    signature,
  ] = match;

  const signedHeaders = signedHeadersStr.split(";").map((h) =>
    h.trim().toLowerCase()
  ).sort(); // Keep sorted

  return {
    accessKeyId,
    dateStamp,
    region,
    service,
    signedHeaders,
    signature,
    credentialScope: `${dateStamp}/${region}/${service}/aws4_request`,
  };
}

// --- Verification Function ---

interface VerificationOptions {
  /** Maximum allowed time difference in milliseconds (e.g., 15 minutes) */
  clockSkew?: number;
}

/**
 * Verifies an incoming Request's AWS Signature Version 4.
 *
 * @param req The incoming Deno Request object.
 * @param options Optional verification parameters.
 * @returns {Promise<boolean>} True if the signature is valid, false otherwise.
 * @throws {Error} If required headers are missing, format is invalid, or lookup fails.
 */
export async function verifyS3SigV4(
  req: Request,
  options: VerificationOptions = {},
  knownSecretKeys: Record<string, string | undefined>,
): Promise<{ isValid: boolean; error?: string }> {
  const signer = new SignatureV4a({
    // FIXME: properly fill these
    service: "TODO",
    region: "*",
    sha256: Sha256,
    credentials: {
      accessKeyId: "TODO",
      secretAccessKey: "TODO",
    },
  });

  const { clockSkew = 15 * 60 * 1000 } = options; // Default 15 minutes skew

  // 1. Extract Required Headers
  const authHeader = req.headers.get("Authorization");
  const amzDateHeader = req.headers.get("x-amz-date");
  const payloadHashHeader = req.headers.get("x-amz-content-sha256");
  const hostHeader = req.headers.get("host"); // Host is almost always signed
  if (!authHeader) {
    return { isValid: false, error: "Missing Authorization header" };
  }
  if (!amzDateHeader) {
    return { isValid: false, error: "Missing x-amz-date header" };
  }
  if (!payloadHashHeader) {
    return { isValid: false, error: "Missing x-amz-content-sha256 header" };
  }
  if (!hostHeader) {
    // Technically optional in SigV4 spec, but highly recommended and usually present/signed
    logger.warn("Warning: Missing Host header in incoming request.");
    // Verification might still succeed if 'host' wasn't in SignedHeaders, but it's unusual.
  }

  // TODO: support for parsing pre-signed URLS
  // 2. Parse Authorization Header
  const parsedAuth = parseAuthorizationHeader(authHeader);
  if (!parsedAuth) {
    return { isValid: false, error: "Invalid Authorization header format" };
  }

  // 3. Check Timestamp (Clock Skew)
  let requestDate: Date;
  try {
    requestDate = new Date(
      amzDateHeader.replace(
        /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
        "$1-$2-$3T$4:$5:$6Z",
      ),
    );
    if (isNaN(requestDate.getTime())) {
      return { isValid: false, error: "Invalid x-amz-date header format" };
    }
    const now = Date.now();
    if (Math.abs(now - requestDate.getTime()) > clockSkew) {
      return {
        isValid: false,
        error:
          `Clock skew detected. Request time (${amzDateHeader}) is too far from server time.`,
      };
    }
    // Check if date part matches credential scope date
    if (amzDateStamp(requestDate) !== parsedAuth.dateStamp) {
      return {
        isValid: false,
        error: "x-amz-date does not match credential scope date",
      };
    }
  } catch (err) {
    return {
      isValid: false,
      error: `Error parsing x-amz-date: ${
        err instanceof Error ? err.message : err
      }`,
    };
  }

  // 4. Look up Secret Key
  const secretAccessKey = knownSecretKeys[parsedAuth.accessKeyId];
  if (!secretAccessKey) {
    // Security best practice: Don't reveal *why* it failed (invalid key vs. other errors)
    // Log the specific reason server-side if needed.
    logger.warn(
      `Attempted verification with unknown access key: ${parsedAuth.accessKeyId}`,
    );
    return { isValid: false, error: "Invalid signature (key lookup failed)" };
  }

  // 5. Reconstruct the Canonical Request using data FROM THE REQUEST
  // See: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html

  const url = new URL(req.url);

  // 5.1. Method
  const canonicalMethod = req.method.toUpperCase();

  // 5.2. Canonical URI
  // Ensure pathname starts with '/' and handle potential double slashes
  const canonicalUri = ("/" + url.pathname).replace(/\/+/g, "/");

  // 5.3. Canonical Query String (Sort parameters from the *incoming* request URL)
  // Sort parameters by key, encode key/value, handle empty values
  const canonicalQuery = Object.fromEntries(
    Array.from(url.searchParams.entries())
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map((
        [key, value],
      ) => [encodeURIComponent(key), encodeURIComponent(value)]),
  );

  // 5.4. Canonical Headers
  // MUST use only the headers listed in `signedHeaders` from the Authorization header.
  const canonicalHeadersEntries: { key: string; value: string }[] = [];
  for (const headerKey of parsedAuth.signedHeaders) { // signedHeaders is already lowercased & sorted
    const headerValue = req.headers.get(headerKey);
    if (headerValue === null) {
      // This should ideally not happen if the client signed it correctly.
      return {
        isValid: false,
        error: `Signed header '${headerKey}' missing in request`,
      };
    }
    // Normalize whitespace as per SigV4 rules
    canonicalHeadersEntries.push({
      key: headerKey,
      value: headerValue.trim().replace(/\s+/g, " "),
    });
  }

  if (!hostHeader) {
    // const host = req.headers.get("Host") || ${service}.${region}.amazonaws.com`; // Default guess
    throw new Error("unable to determine host for request");
  }
  const sig = await signer.sign({
    method: canonicalMethod,
    hostname: hostHeader,
    path: canonicalUri,
    headers: Object.fromEntries(
      canonicalHeadersEntries.map(({ key, value }) => [key, value]),
    ),
    protocol: url.protocol.toUpperCase(),
    query: canonicalQuery,
  }, {
    signingDate: requestDate,
  });

  logger.debug("signiture", { sig });
  // return {
  //   headers: sig.headers as Record<string, string>,
  // };
  const recalculateSig = sig.headers["x-amz-signature"];
  if (recalculateSig === parsedAuth?.signature) {
    return { isValid: true };
  } else {
    // Log details server-side for debugging, but return a generic error.
    logger.error("Signature mismatch during verification.", {
      provided: parsedAuth.signature,
      recalculated: recalculateSig,
      accessKeyId: parsedAuth.accessKeyId,
      date: amzDateHeader,
      // Avoid logging sensitive parts like canonical request/string-to-sign in production unless needed for debugging
    });
    return { isValid: false, error: "Invalid signature" };
  }
}

/**
 * Formats a date into YYYYMMDD format.
 */
function amzDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}
// function amzDateTimeStamp(date: Date): string { // Not strictly needed for verify, but useful helper
//   return date.toISOString().replace(/-/g, "").replace(/:/g, "").split(
//     ".",
//   )[0] + "Z";
// }
