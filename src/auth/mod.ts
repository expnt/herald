import { verify } from "@djwt";
import { envVarsConfig } from "../config/mod.ts";
import { getLogger } from "../utils/log.ts";
import { retryFetchWithExponentialBackoff } from "../utils/url.ts";
import { HTTPException } from "../types/http-exception.ts";

interface DecodedToken {
  sub: string;
  "kubernetes.io"?: {
    serviceaccount: {
      name: string;
      uid: string;
    };
  };
}

const logger = getLogger(import.meta);

export async function authenicateRequestAndReturnPodServiceAccount(
  token: string,
): Promise<string> {
  const payload = await verifyToken(token);

  if (!payload["kubernetes.io"]) {
    logger.error("Payload does not contain kubernetes.io field");
    throw new Error("Payload does not contain kubernetes.io field");
  }

  return payload["kubernetes.io"].serviceaccount.name;
}

async function verifyToken(token: string): Promise<DecodedToken> {
  const key = await getPublicKey();

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
  const verified = await verify(token, cryptoKey);
  return verified as DecodedToken;
}

async function getPublicKey(): Promise<string> {
  const jwks_uri = await getJWKURI();
  const jwkUrl = new URL(jwks_uri);
  const headers = new Headers();
  if (envVarsConfig.env === "DEV") {
    // This should be the proxy server created by kubectl for dev purposes inside a local machine
    jwkUrl.hostname = envVarsConfig.k8s_api;
  } else {
    // we need to set the auth headers with the serviceToken when herald is running in a k8s cluster
    headers.set(
      "Authorization",
      `Bearer ${await getServiceAccountToken()}`,
    );
  }
  const fetchFunc = async () => await fetch(jwkUrl.toString(), { headers });
  const fetchJWK = await retryFetchWithExponentialBackoff(fetchFunc, 5, 1000);

  if (fetchJWK instanceof Error) {
    logger.error(fetchJWK.message);
    throw new HTTPException(500, { message: fetchJWK.message });
  }

  const data = await fetchJWK.json();
  const key = data.keys[0].kid;
  if (!key) {
    throw new Error("Key not found in response");
  }

  return key;
}

async function getJWKURI(): Promise<string> {
  const env = envVarsConfig.env;
  if (env === "DEV") {
    const uri = envVarsConfig.jwk_uri;
    if (!uri) {
      logger.error("JWKS_URI not found in environment");
      throw new Error("JWKS_URI not found in environment");
    }
    return uri;
  }
  const k8s_url = envVarsConfig.k8s_api;
  const fetchFunc = async () =>
    await fetch(
      `${k8s_url}/.well-known/openid-configuration`,
      {
        headers: {
          Authorization: `Bearer ${await getServiceAccountToken()}`,
        },
      },
    );
  const fetchJWKURI = await retryFetchWithExponentialBackoff(
    fetchFunc,
    5,
    1000,
  );

  if (fetchJWKURI instanceof Error) {
    logger.error(fetchJWKURI.message);
    throw new HTTPException(500, { message: fetchJWKURI.message });
  }

  const data = await fetchJWKURI.json();
  const jwks_uri = data.jwks_uri;

  if (!jwks_uri) {
    logger.error("JWKS URI not found in response");
    throw new Error("JWKS URI not found in response");
  }

  return jwks_uri;
}

async function getServiceAccountToken(): Promise<string> {
  const env = envVarsConfig.env;
  if (env === "DEV") {
    const podName = envVarsConfig.pod_name;
    if (!podName) {
      logger.error("POD_NAME not found in environment");
      throw new Error(
        "POD_NAME not found in environment. Set the ENV variable to PROD if running in a Kubernetes cluster",
      );
    }
    const namespace = envVarsConfig.namespace;
    if (!namespace) {
      logger.error("NAMESPACE not found in environment");
      throw new Error(
        "NAMESPACE not found in environment. Set the ENV variable to PROD if running in a Kubernetes cluster",
      );
    }
    const getTokenCommand = new Deno.Command("kubectl", {
      args: [
        "exec",
        "-it",
        podName,
        "-n",
        namespace,
        "--",
        "cat",
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const { stdout, stderr, code } = await getTokenCommand.output();

    if (code !== 0) {
      logger.error(new TextDecoder().decode(stderr));
      throw new Error(new TextDecoder().decode(stderr));
    }

    return new TextDecoder().decode(stdout);
  }

  const token = await Deno.readFile(
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
  );
  return new TextDecoder().decode(token);
}
