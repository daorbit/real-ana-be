import { Request, Response, NextFunction, RequestHandler } from "express";


export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as unknown as Req, res, next)).catch(next);
  };
}
