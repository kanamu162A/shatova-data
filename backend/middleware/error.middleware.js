import { env } from '../env/env.js';
import { error as errorResponse } from '../utils/response.js';

export function notFound(req, res) {
  return errorResponse(res, `Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND');
}

export function errorHandler(err, req, res, next) {
  console.error('Error:', err.message);
  if (env.isDev) console.error(err.stack);

  if (err.code === '23505') {
    return errorResponse(res, 'This record already exists', 409, 'DUPLICATE');
  }
  if (err.code === '23503') {
    return errorResponse(res, 'Related record not found', 400, 'FK_ERROR');
  }
  if (err.code === '23514') {
    return errorResponse(res, 'Invalid value for this field', 400, 'CHECK_FAILED');
  }

  return errorResponse(res, 'Something went wrong. Please try again.', 500, 'SERVER_ERROR');
}