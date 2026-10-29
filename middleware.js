import { next } from '@vercel/functions';
import { isManager, readSession } from './lib/internal-auth.js';

export const config = {
  matcher: [
    '/internal',
    '/internal.html',
    '/internal/',
    '/internal/index.html',
    '/internal.js',
    '/internal-data.js',
    '/internal/scripts/:path*',
    '/internal/timeline',
    '/internal/timeline/',
    '/internal/contacts',
    '/internal/contacts/',
    '/internal/contacts/:path*'
  ]
};

const LOGIN_PATH = '/internal/login';

export default async function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path.endsWith('/login.js') || path.endsWith('/reset.js') || path.endsWith('/passkey.js')) return next();

  const identity = await readSession(request);
  if (identity) {
    const programmeFile = path === '/internal-data.js' || path.endsWith('/scripts/data.js');
    if (programmeFile && !isManager(identity.user)) {
      return new Response('', {
        status: 200,
        headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }
      });
    }
    return next();
  }

  if (path.endsWith('.js')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  const login = new URL(LOGIN_PATH, url.origin);
  login.searchParams.set('to', url.pathname);
  return new Response(null, {
    status: 302,
    headers: { Location: login.toString(), 'Cache-Control': 'no-store' }
  });
}
