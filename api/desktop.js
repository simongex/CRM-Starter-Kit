/* The desktop app is not part of this starter kit. */
export default function handler() {
  return new Response(JSON.stringify({ error: 'Not available' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
}
