import type { ApiErrorBody, CustomForecastRequest, CustomForecastResponse, HealthResponse, HomeResponse, StoresResponse } from '../types/api';
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
export class ApiError extends Error { constructor(message: string, public status?: number) { super(message); this.name = 'ApiError'; } }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${BASE_URL}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } }); }
  catch { throw new ApiError(`Could not reach the API at ${BASE_URL}. Check that FastAPI is running and the URL is correct.`); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as ApiErrorBody | null;
    const detail = error?.detail;
    let message = typeof detail === 'string' ? detail : detail && !Array.isArray(detail) ? [detail.message, detail.missing_columns?.length ? `Missing columns: ${detail.missing_columns.join(', ')}` : undefined].filter(Boolean).join(' ') : Array.isArray(detail) ? detail.map(item => `${item.loc?.join('.') ?? 'request'}: ${item.msg ?? 'invalid value'}`).join('; ') : `Request failed with HTTP ${response.status}.`;
    throw new ApiError(message || `Request failed with HTTP ${response.status}.`, response.status);
  }
  if (body === null || body === undefined) throw new ApiError('The API returned an empty response.', response.status);
  return body as T;
}
export const api = {
  health: () => request<HealthResponse>('/health'),
  home: () => request<HomeResponse>('/'),
  stores: () => request<StoresResponse>('/stores'),
  customForecast: (payload: CustomForecastRequest) => request<CustomForecastResponse>('/forecast/custom', { method: 'POST', body: JSON.stringify(payload) }),
  baseUrl: BASE_URL,
};
