import { Effect } from "effect";
import { NotImplemented } from "../../Services/Backend.ts";

/**
 * Handler for bucket subresources that are recognized but not yet
 * implemented. Returns a proper S3 NotImplemented (501) error instead of
 * falling through to bucket create/delete handlers.
 */
export const notImplementedSubresource = (subresource: string) =>
  Effect.fail(
    new NotImplemented({
      message:
        `The requested bucket subresource (${subresource}) is not implemented.`,
    }),
  );
