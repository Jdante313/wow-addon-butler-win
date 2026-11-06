'use strict';

class AppError extends Error {
  constructor(message, code = 'APP_ERROR', status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function asError(error, fallback = '操作失败') {
  if (error instanceof AppError) return error;
  const message = error && error.message ? error.message : fallback;
  const wrapped = new AppError(message, (error && error.code) || 'APP_ERROR', 500);
  if (error && error.stack) wrapped.stack = error.stack;
  return wrapped;
}

module.exports = { AppError, asError };
