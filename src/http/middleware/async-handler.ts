import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wrap an async route handler so a rejected promise reaches Express.
 *
 * Express 4 only catches errors thrown synchronously. An `async` handler that
 * rejects returns a promise nobody awaits: the rejection becomes an unhandled
 * one, no response is ever written, and the request hangs until the client or
 * the platform times it out. Forwarding to `next` is what turns that silent
 * hang into a 500 the error middleware can log.
 *
 * The generic keeps the caller's request type — handlers written against
 * `AuthedRequest` stay typed after wrapping, which the built-in
 * `RequestHandler` signature would otherwise flatten to `Request`.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as unknown as Req, res, next)).catch(next);
  };
}
