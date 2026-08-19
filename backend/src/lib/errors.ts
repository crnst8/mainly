/**
 * One error shape across the whole API, matching `ApiError` in the contract.
 *
 * `message` is shown to the user, so it must be true and useful — an IMAP
 * server's own error text is more helpful than anything we would write.
 * `detail` is for the client to branch on, never for prose.
 */

export class AppError extends Error {
  // Fields are declared and assigned explicitly rather than via constructor
  // parameter properties: Node runs these sources directly with type stripping,
  // which erases types but cannot synthesise the assignments a parameter
  // property implies.
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, detail: this.detail } };
  }
}

export const badRequest = (message: string, detail?: unknown) =>
  new AppError(400, 'bad_request', message, detail);

export const unauthorized = (message = 'Not signed in') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);

export const conflict = (message: string) => new AppError(409, 'conflict', message);

export const tooMany = (message = 'Too many requests') =>
  new AppError(429, 'rate_limited', message);

/** Upstream mail server said no. Carries the server's text verbatim. */
export const upstream = (message: string, detail?: unknown) =>
  new AppError(502, 'upstream_error', message, detail);
