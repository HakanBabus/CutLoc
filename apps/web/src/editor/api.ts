import { translate } from '../i18n';

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  const language = document.documentElement.lang === 'tr' ? 'tr' : 'en';
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', language);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError((body as { error?: string }).error || translate(language, 'common.requestFailed', { status: response.status }), response.status, body);
  }
  return response.json() as Promise<T>;
};
