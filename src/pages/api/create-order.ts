import type { APIRoute } from 'astro';
import { findOrCreatePartner, createOrder } from '../../lib/odoo';
import type { CartItem, CustomerData } from '../../lib/odoo';

export const POST: APIRoute = async ({ request }) => {
  let body: { customer: CustomerData; items: CartItem[] };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { customer, items } = body;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const ZIP_RE = /^\d{4,10}$/;

  const missing =
    !customer?.name?.trim() ||
    !customer?.email?.trim() ||
    !customer?.phone?.trim() ||
    !customer?.street?.trim() ||
    !customer?.city?.trim() ||
    !customer?.zip?.trim() ||
    !customer?.state?.trim() ||
    !items?.length;

  if (missing) {
    return new Response(JSON.stringify({ error: 'Faltan datos del pedido' }), { status: 400 });
  }

  if (!EMAIL_RE.test(customer.email)) {
    return new Response(JSON.stringify({ error: 'El email no es válido' }), { status: 400 });
  }

  if (!ZIP_RE.test(customer.zip)) {
    return new Response(JSON.stringify({ error: 'El código postal no es válido' }), { status: 400 });
  }

  if (!Array.isArray(items) || items.some((i) => !i.id || !i.name || i.quantity < 1 || i.price < 0)) {
    return new Response(JSON.stringify({ error: 'Los productos del carrito no son válidos' }), { status: 400 });
  }

  try {
    const partnerId = await findOrCreatePartner(customer);
    const origin = `maruchy-web-${Date.now()}`;
    const order = await createOrder(partnerId, items, customer, origin);

    return new Response(JSON.stringify({ success: true, orderRef: order.name, orderId: order.id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('create-order error:', err);
    return new Response(JSON.stringify({ error: 'Error al crear el pedido. Inténtalo de nuevo.' }), {
      status: 500,
    });
  }
};
