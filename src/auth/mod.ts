import { decode } from "@djwt";
import { HTTPException } from "../types/http-exception.ts";
import { getLogger } from "../utils/log.ts";

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

export function decodeToken(token: string): DecodedToken | null {
  if (token.startsWith("Bearer ")) {
    token = token.slice(7);
  }
  const [_headers, payload, _signature] = decode(token);

  const data = payload as DecodedToken;
  if (!data || typeof data !== "object" || !data.sub) {
    logger.warn("Invalid token");
    throw new HTTPException(401, {
      message: "Invalid token",
    });
  }

  // if (!isSubInPodsConfig(data)) {
  //   logger.warn("Unauthorized");
  //   throw new HTTPException(403, {
  //     message: "Unauthorized",
  //   });
  // }

  return payload as DecodedToken;
}
