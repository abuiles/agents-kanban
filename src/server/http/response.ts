import { HttpError } from './errors';

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export function noContent() {
  return new Response(null, { status: 204 });
}

export function handleError(error: unknown) {
  if (error instanceof HttpError) {
    return json(error.body, { status: error.status });
  }

  console.error('Unhandled API error', error);
  return json(
    {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Internal server error.',
      retryable: true
    },
    { status: 500 }
  );
}
