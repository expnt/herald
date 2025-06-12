import { OPENSTACK_AUTH_TOKEN_HEADER } from "./../../constants/headers.ts";
import { SwiftConfig } from "../../config/types.ts";
import { HeraldError } from "../../types/http-exception.ts";
import { getLogger } from "../../utils/log.ts";
import { retryWithExponentialBackoff } from "../../utils/url.ts";

const logger = getLogger(import.meta);

export interface ServiceCatalog {
  endpoints: OpenStackEndpoint[];
  type: string;
  id: string;
  name: string;
}

export interface OpenStackEndpoint {
  id: string;
  interface: "public" | "admin" | "internal";
  region: string;
  region_id: string;
  url: string;
}

export async function getAuthTokenWithTimeouts(config: SwiftConfig): Promise<
  {
    storageUrl: string;
    token: string;
  } | Error
> {
  const getAuthToken = async () => {
    const { auth_url, credentials, region } = config;
    const {
      username,
      password,
      project_name: projectName,
      user_domain_name: userDomainName,
      project_domain_name: projectDomainName,
    } = credentials;

    logger.info("Fetching Authorization Token From Swift Server");
    logger.info("Fetching Storage URL From Swift Server");

    const requestBody = JSON.stringify({
      auth: {
        identity: {
          methods: ["password"],
          password: {
            user: {
              name: username,
              domain: { name: userDomainName },
              password: password,
            },
          },
        },
        scope: {
          project: {
            domain: { name: projectDomainName },
            name: projectName,
          },
        },
      },
    });

    const response = await fetch(`${auth_url}/auth/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: requestBody,
    });

    if (response.status === 300) {
      const msg = await response.text();
      logger.warn("Multiple choices available for the requested resource.");
      const choices = response.headers.get("location");
      logger.info(`Available choices: ${choices}`);
      // Optionally, implement logic to handle multiple choices
      return new HeraldError(response.status, { message: msg });
    }

    if (!response.ok) {
      const msg = await response.text();
      const errMessage = `Failed to authenticate with the auth service: ${msg}`;
      logger.warn(errMessage);
      return new HeraldError(response.status, { message: msg });
    }
    logger.info("Authorization Token and Storage URL retrieved Successfully");

    const responseBody = await response.json();
    const token = response.headers.get(OPENSTACK_AUTH_TOKEN_HEADER);

    const serviceCatalog = responseBody.token.catalog as ServiceCatalog[];

    const storageService = serviceCatalog.find((service) =>
      service.type === "object-store" // 'object-store' is the type for the Swift service
    );

    if (storageService === undefined) {
      return new HeraldError(404, {
        message: "Object Store Service not found in OpenStack Server",
      });
    }

    // Typically you'll retrieve the publicURL of the storage service
    const storageUrl = storageService.endpoints.find((endpoint) =>
      endpoint.region === region && endpoint.interface === "public"
    )?.url;

    if (token == null) {
      return new HeraldError(400, {
        message:
          "Error Authenticating to Open Stack Server: x-subject-token header is null",
      });
    }

    if (storageUrl === undefined) {
      return new HeraldError(404, {
        message:
          `Storage URL not found in OpenStack Server for region ${region}`,
      });
    }

    logger.info("Authorization Token and Storage URL retrieved Successfully");

    return { storageUrl, token };
  };

  const res = await retryWithExponentialBackoff(
    getAuthToken,
  );

  if (res instanceof Error) {
    return res;
  }

  return res;
}

export function getSwiftRequestHeaders(authToken: string): Headers {
  return new Headers({
    "X-Auth-Token": authToken,
    "Accept": "application/xml",
  });
}
