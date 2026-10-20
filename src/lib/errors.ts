import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * An error that is safe to show to the client. Anything else that is thrown
 * becomes a generic 500 so database and library messages never leak.
 */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const unauthorized = (message = 'Sign in to continue.') =>
  new AppError(401, 'unauthorized', message)

export const forbidden = (message = "You don't have permission to do this.") =>
  new AppError(403, 'forbidden', message)

export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message)

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details)
