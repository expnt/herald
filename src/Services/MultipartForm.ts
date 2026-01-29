/**
 * Parse multipart/form-data body for S3 PostObject.
 * Extracts form fields and the file/content part.
 */

import { Effect } from "effect";
import { InvalidRequest } from "./Backend.ts";

export interface ParsedFilePart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly body: Uint8Array;
}

export interface ParsedMultipartForm {
  readonly fields: Record<string, string>;
  readonly filePart: ParsedFilePart | null;
}

function getBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
  return match ? match[1].trim() : null;
}

function parsePartHeaders(headerBlock: string): {
  name: string | null;
  filename: string | null;
  contentType: string | null;
} {
  let name: string | null = null;
  let filename: string | null = null;
  let contentType: string | null = null;
  // name= can be quoted (name="key") or unquoted (name=key); support both
  const dispositionMatch = headerBlock.match(
    /Content-Disposition\s*:\s*form-data\s*;\s*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\r\n\s]+))/i,
  );
  if (dispositionMatch) {
    name =
      (dispositionMatch[1] ?? dispositionMatch[2] ?? dispositionMatch[3] ?? "")
        .trim() || null;
    const filenameMatch = headerBlock.match(
      /filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\r\n\s]+))/i,
    );
    if (filenameMatch) {
      const f = filenameMatch[1] ?? filenameMatch[2] ?? filenameMatch[3];
      filename = (f ?? "").trim() || null;
    }
  }
  const contentTypeMatch = headerBlock.match(/Content-Type\s*:\s*([^\r\n]+)/i);
  if (contentTypeMatch) {
    contentType = contentTypeMatch[1].trim();
  }
  return { name, filename, contentType };
}

/**
 * Parse a multipart/form-data body string.
 * Requires Content-Type header to extract the boundary.
 */
export function parseMultipartFormData(
  body: string,
  contentType: string,
): Effect.Effect<ParsedMultipartForm, InvalidRequest> {
  return Effect.try({
    try: () => {
      const boundary = getBoundary(contentType);
      if (!boundary) {
        throw new InvalidRequest({
          message: "Missing or invalid multipart boundary in Content-Type",
        });
      }
      const fields: Record<string, string> = {};
      let filePart: ParsedFilePart | null = null;

      // Normalize line endings and split by boundary
      const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const boundaryLine = `--${boundary}`;
      const boundaryEnd = `--${boundary}--`;
      const parts = normalized.split(`\n${boundaryLine}`);

      for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        if (i === 0 && part.startsWith(boundaryLine)) {
          part = part.slice(boundaryLine.length);
        }
        if (
          part.endsWith("\n" + boundaryEnd) ||
          part.endsWith("\n" + boundaryEnd + "\n")
        ) {
          part = part.slice(0, part.indexOf("\n" + boundaryEnd));
        }
        // Strip leading CRLF so header block starts at first line (fixes first part)
        part = part.replace(/^[\r\n]+/, "");
        if (!part.trim()) continue;

        const headerEnd = part.indexOf("\n\n");
        if (headerEnd === -1) continue;
        let headerBlock = part.slice(0, headerEnd);
        const bodyPart = part.slice(headerEnd + 2).replace(/\n?$/, "");
        const bodyBytes = new TextEncoder().encode(bodyPart);

        // Normalize folded headers (RFC 2231) into one line so regex matches
        headerBlock = headerBlock.replace(/\r?\n\s+/g, " ");
        const { name, filename, contentType: partContentType } =
          parsePartHeaders(headerBlock);
        if (!name) continue;

        // Python requests sends form fields as name="key"; filename="key" (same value).
        // Treat as form field when filename equals name, except for the object body parts.
        const isObjectBodyPart = name === "file" || name === "content";
        const isFormFieldDisguisedAsFile = !isObjectBodyPart &&
          filename !== null && filename === name;
        const isFilePart = isObjectBodyPart ||
          (!isFormFieldDisguisedAsFile && filename !== null);
        if (isFilePart) {
          filePart = {
            name,
            filename: filename ?? undefined,
            contentType: partContentType ?? undefined,
            body: bodyBytes,
          };
        } else {
          fields[name] = bodyPart;
        }
      }

      return { fields, filePart };
    },
    catch: (e) => {
      if (e instanceof InvalidRequest) return e;
      return new InvalidRequest({
        message: e instanceof Error
          ? e.message
          : "Failed to parse multipart form",
      });
    },
  });
}
