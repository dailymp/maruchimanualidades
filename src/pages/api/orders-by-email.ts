import type { APIRoute } from 'astro';
import { getOrdersByEmail } from '../../lib/odoo';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async ({ request }) => {
  let body: { email?: string };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();

  if (!email || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: 'Email no válido' }), { status: 400 });
  }

  try {
    const orders = await getOrdersByEmail(email);
    return new Response(JSON.stringify({ orders }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('orders-by-email error:', err);
    return new Response(JSON.stringify({ error: 'Error al buscar pedidos. Inténtalo de nuevo.' }), {
      status: 500,
    });
  }
};
