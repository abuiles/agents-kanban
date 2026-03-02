export type ApiError = {
  code: string;
  message: string;
  retryable: boolean;
  taskId?: string;
  runId?: string;
};

export class HttpError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

export function notFound(message: string, extras?: Partial<ApiError>) {
  return new HttpError(404, { code: 'NOT_FOUND', message, retryable: false, ...extras });
}

export function badRequest(message: string, extras?: Partial<ApiError>) {
  return new HttpError(400, { code: 'BAD_REQUEST', message, retryable: false, ...extras });
}

export function conflict(message: string, extras?: Partial<ApiError>) {
  return new HttpError(409, { code: 'CONFLICT', message, retryable: false, ...extras });
}
