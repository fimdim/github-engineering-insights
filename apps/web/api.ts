let csrf = '';
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Local-CSRF': csrf },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'error' in result ? String(result.error) : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return result as T;
}
export async function session() {
  const result = await api<{ csrf: string; version: string; canvas: { available: boolean; reason: string } }>('session');
  csrf = result.csrf;
  return result;
}
