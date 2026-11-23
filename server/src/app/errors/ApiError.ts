class ApiError extends Error {
  code: number;
  /** Optional machine-readable code (e.g. 'NO_ACTIVE_RIDE') sent to socket clients. */
  errorCode?: string;
  constructor(code: number, message: string | undefined, stack = '') {
    super(message);
    this.code = code;
    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export default ApiError;
