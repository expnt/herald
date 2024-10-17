import { OPENSTACK_AUTH_TOKEN_HEADER } from "./../../constants/headers.ts";
import { SwiftConfig } from "../../config/types.ts";
import { HTTPException } from "../../types/http-exception.ts";
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

export async function getAuthTokenWithTimeouts(config: SwiftConfig): Promise<{
  storageUrl: string;
  token: string;
}> {
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
            name: projectName, // Replace with your actual project name
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
      logger.warn("Multiple choices available for the requested resource.");
      const choices = response.headers.get("location");
      logger.info(`Available choices: ${choices}`);
      // Optionally, implement logic to handle multiple choices
      throw new HTTPException(response.status, { res: response });
    }

    if (!response.ok) {
      logger.warn(
        `Failed to authenticate with the auth service: ${response.statusText}`,
      );
      throw new HTTPException(response.status, { res: response });
    }
    logger.info("Authorization Token and Storage URL retrieved Successfully");

    const responseBody = await response.json();
    const token = response.headers.get(OPENSTACK_AUTH_TOKEN_HEADER);

    const serviceCatalog = responseBody.token.catalog as ServiceCatalog[];

    const storageService = serviceCatalog.find((service) =>
      service.type === "object-store" // 'object-store' is the type for the Swift service
    );

    if (storageService === undefined) {
      throw new HTTPException(404, {
        message: "Object Store Service not found in OpenStack Server",
      });
    }

    // Typically you'll retrieve the publicURL of the storage service
    const storageUrl = storageService.endpoints.find((endpoint) =>
      endpoint.region === region && endpoint.interface === "public"
    )?.url;

    if (token == null) {
      throw new HTTPException(400, {
        message:
          "Error Authenticating to Open Stack Server: x-subject-token header is null",
      });
    }

    if (storageUrl === undefined) {
      throw new HTTPException(404, {
        message: "Storage URL not found in OpenStack Server",
      });
    }

    logger.info("Authorization Token and Storage URL retrieved Successfully");
    logger.debug(
      `Retrieved token ${token} and storage url ${storageUrl}`,
    );

    return { storageUrl, token };
  };

  return await retryWithExponentialBackoff(
    getAuthToken,
    5,
    100,
    1000,
    config.container,
  );
}

export function getSwiftRequestHeaders(authToken: string): Headers {
  return new Headers({
    "X-Auth-Token": authToken,
    "Accept": "application/xml",
  });
}
