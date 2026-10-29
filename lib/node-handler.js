/* The Node runtime calls a function with (req, res). The handlers speak the
   Web Request API, which is what the Edge runtime passes through. */

export function toWebRequest(req) {
  if (typeof Request !== 'undefined' && req instanceof Request) return req;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req?.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else if (value != null) {
      headers.set(key, String(value));
    }
  }
  const proto = headers.get('x-forwarded-proto') || 'https';
  const host = headers.get('x-forwarded-host') || headers.get('host') || 'localhost';
  const path = String(req?.url || '/');
  const url = path.startsWith('http') ? path : `${proto}://${host}${path}`;
  return new Request(url, { method: req?.method || 'GET', headers });
}

export function serve(handle) {
  return async function handler(req, res) {
    const response = await handle(toWebRequest(req));
    if (!res || typeof res.writeHead !== 'function') return response;
    const headers = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') headers[key] = value;
    });
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    res.end(await response.text());
  };
}
