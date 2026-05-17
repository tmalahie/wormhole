export class WormError extends Error {
  readonly hint?: string;

  constructor(message: string, options?: { hint?: string; cause?: unknown }) {
    super(message);
    this.name = "WormError";
    this.hint = options?.hint;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isWormError(err: unknown): err is WormError {
  return err instanceof WormError;
}
