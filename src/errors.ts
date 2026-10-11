/** Errors surfaced by the API clients and the vector store. */

export class ApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  /** 4xx responses other than rate limiting will not succeed on retry. */
  public get retryable(): boolean {
    return (
      this.status === 408 ||
      this.status === 409 ||
      this.status === 425 ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

export class DimensionMismatchError extends Error {
  public readonly expected: number;
  public readonly actual: number;

  constructor(expected: number, actual: number, message?: string) {
    super(
      message ??
        `Embedding dimension mismatch: the index was built with ${expected}-dimensional vectors, ` +
          `but the model returned ${actual}-dimensional vectors. Re-index the vault to switch models.`
    );
    this.name = "DimensionMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Raised when the user stops generation, so callers can stay silent about it. */
export class GenerationCancelledError extends Error {
  constructor() {
    super("Generation cancelled");
    this.name = "GenerationCancelledError";
  }
}

/** Streaming is optional: providers without SSE fall back to one-shot responses. */
export class StreamUnavailableError extends Error {
  constructor(message = "Streaming is not available for this endpoint") {
    super(message);
    this.name = "StreamUnavailableError";
  }
}

export function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return error instanceof Error && error.name === "AbortError";
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
