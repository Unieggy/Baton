/**
 * Relay server — HTTP error model
 * -------------------------------
 * One error type the request handler understands. Routes throw `HttpError`
 * (or any helper below) and the centralized handler in `app.ts` turns it into
 * a consistent JSON envelope. Anything that is NOT an `HttpError` is treated as
 * an unexpected 500 (and logged) so we never leak internal messages to clients.
 */

export interface ErrorBody {
  error: { code: string; message: string };
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string = "error"
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (message = "Not found"): HttpError =>
  new HttpError(404, message, "not_found");

export const methodNotAllowed = (message = "Method not allowed"): HttpError =>
  new HttpError(405, message, "method_not_allowed");

/** Normalize any thrown value into the JSON envelope + status to send. */
export function toErrorResponse(err: unknown): {
  statusCode: number;
  body: ErrorBody;
  unexpected: boolean;
} {
  if (err instanceof HttpError) {
    return {
      statusCode: err.statusCode,
      body: { error: { code: err.code, message: err.message } },
      unexpected: false,
    };
  }
  return {
    statusCode: 500,
    body: { error: { code: "internal_error", message: "Internal server error" } },
    unexpected: true,
  };
}
