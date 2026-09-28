export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'データ') => new HttpError(404, `${what}が見つかりません`, 'not_found');
export const badRequest = (msg: string, code = 'bad_request') => new HttpError(400, msg, code);
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, msg, code);
export const unprocessable = (msg: string, code = 'unprocessable') => new HttpError(422, msg, code);
