export class Sandbox {}

export type ExecEvent = {
  type: string;
  [key: string]: unknown;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
};

export type StreamOptions = {
  onEvent?: (event: ExecEvent) => void | Promise<void>;
};

export function parseSSEStream() {
  return new ReadableStream<ExecEvent>();
}

export function getSandbox() {
  throw new Error('Sandbox operations are not available in worker integration tests.');
}
