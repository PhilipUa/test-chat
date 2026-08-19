/**
 * The application's HTTP error type.
 *
 * Lives at the root rather than under middleware/ because services throw it — `assertParticipant`
 * raising a 403 is a domain decision, and making the service layer import from a middleware folder
 * would point the dependency arrow the wrong way.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  static badRequest(message: string, details?: unknown) {
    return new HttpError(400, message, details);
  }
  static forbidden(message: string) {
    return new HttpError(403, message);
  }
  static notFound(message: string) {
    return new HttpError(404, message);
  }
  static tooManyRequests(message: string, details?: unknown) {
    return new HttpError(429, message, details);
  }
  static unavailable(message: string) {
    return new HttpError(503, message);
  }
}
