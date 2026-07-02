const ODOO_URL = import.meta.env.ODOO_URL as string;
const ODOO_DB = import.meta.env.ODOO_DB as string;
const ODOO_LOGIN = import.meta.env.ODOO_LOGIN as string;
const ODOO_API_KEY = import.meta.env.ODOO_API_KEY as string;

let _session: { uid: number; cookie: string } | null = null;

async function getSession(): Promise<{ uid: number; cookie: string }> {
  if (_session) return _session;

  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      id: 1,
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_API_KEY },
    }),
  });

  const data = await res.json();
  if (!data.result?.uid) {
    throw new Error(`Odoo auth failed: ${JSON.stringify(data.error ?? data.result)}`);
  }

  const rawCookie = res.headers.get('set-cookie') ?? '';
  const sessionId = rawCookie.match(/session_id=([^;]+)/)?.[1];
  const cookie = sessionId ? `session_id=${sessionId}` : '';

  _session = { uid: data.result.uid, cookie };
  return _session;
}

async function rpc<T>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
  retry = true
): Promise<T> {
  const { cookie } = await getSession();

  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      id: Math.floor(Math.random() * 10000),
      params: {
        model,
        method,
        args,
        kwargs: { context: {}, ...kwargs },
      },
    }),
  });

  const data = await res.json();

  // Si la sesión ha expirado (código 100 = session expired / not logged in)
  if (data.error?.code === 100 && retry) {
    _session = null;
    return rpc<T>(model, method, args, kwargs, false);
  }

  if (data.error) {
    throw new Error(`Odoo RPC error on ${model}.${method}: ${JSON.stringify(data.error)}`);
  }
  return data.result as T;
}

export interface OdooProduct {
  id: number;
  name: string;
  list_price: number;
  description_sale: string | false;
  categ_id: [number, string] | false;
}

export interface CartItem {
  id: number;
  name: string;
  price: number;
  image: string;
  quantity: number;
}

export interface CustomerData {
  name: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  zip: string;
  state: string;
}

export async function getProducts(categoryName?: string): Promise<OdooProduct[]> {
  const domain: unknown[] = [
    ['active', '=', true],
    ['sale_ok', '=', true],
  ];

  if (categoryName) {
    domain.push(['categ_id.name', 'like', categoryName]);
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Odoo timeout')), 5000)
  );

  return Promise.race([
    rpc<OdooProduct[]>('product.template', 'search_read', [domain], {
      fields: ['id', 'name', 'list_price', 'description_sale', 'categ_id'],
      limit: 100,
      order: 'sequence asc, id asc',
    }),
    timeout,
  ]);
}

export async function getProductImage(id: number): Promise<Buffer | null> {
  const result = await rpc<{ id: number; image_1920: string | false }[]>(
    'product.template',
    'read',
    [[id]],
    { fields: ['image_1920'] }
  );
  const b64 = result?.[0]?.image_1920;
  if (!b64) return null;
  return Buffer.from(b64, 'base64');
}

export async function findOrCreatePartner(customer: CustomerData): Promise<number> {
  const existing = await rpc<{ id: number }[]>('res.partner', 'search_read', [
    [['email', '=', customer.email]],
  ], { fields: ['id'], limit: 1 });

  if (existing.length > 0) {
    return existing[0].id;
  }

  const spainId = await rpc<{ id: number }[]>('res.country', 'search_read', [
    [['code', '=', 'ES']],
  ], { fields: ['id'], limit: 1 });

  return rpc<number>('res.partner', 'create', [{
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    street: customer.street,
    city: customer.city,
    zip: customer.zip,
    country_id: spainId[0]?.id ?? false,
    customer_rank: 1,
  }]);
}

export async function createOrder(
  partnerId: number,
  items: CartItem[],
  customer: CustomerData,
  origin: string
): Promise<{ id: number; name: string }> {
  const orderId = await rpc<number>('sale.order', 'create', [{
    partner_id: partnerId,
    partner_shipping_id: partnerId,
    origin,
    note: `Envío: ${customer.street}, ${customer.city} ${customer.zip} (${customer.state})`,
    payment_term_id: false,
  }]);

  // Resolver product.template IDs → product.product IDs (Odoo requiere variante en sale.order.line)
  const templateIds = items.map((i) => i.id);
  const variants = await rpc<{ id: number; product_tmpl_id: [number, string] }[]>(
    'product.product',
    'search_read',
    [[['product_tmpl_id', 'in', templateIds], ['active', '=', true]]],
    { fields: ['id', 'product_tmpl_id'], limit: templateIds.length * 10 }
  );
  const tmplToVariant = new Map<number, number>();
  for (const v of variants) {
    const tmplId = v.product_tmpl_id[0];
    if (!tmplToVariant.has(tmplId)) tmplToVariant.set(tmplId, v.id);
  }

  const lines = items.map((item) => ({
    order_id: orderId,
    product_id: tmplToVariant.get(item.id) ?? item.id,
    name: item.name,
    product_uom_qty: item.quantity,
    price_unit: item.price,
  }));

  // Crear todas las líneas en una sola llamada RPC
  await rpc<number[]>('sale.order.line', 'create', [lines]);

  await rpc<boolean>('sale.order', 'action_confirm', [[orderId]]);

  const [order] = await rpc<{ id: number; name: string }[]>('sale.order', 'read', [
    [orderId],
  ], { fields: ['id', 'name'] });

  // Enviar email de confirmación al cliente y notificación a Maruchy
  const partnerData = await rpc<{ name: string; email: string; phone: string }[]>(
    'res.partner', 'read', [[partnerId]], { fields: ['name', 'email', 'phone'] }
  );
  if (partnerData[0]) {
    const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const note = `Envío: ${customer.street}, ${customer.city} ${customer.zip} (${customer.state})`;
    await sendOrderNotifications(orderId, order, partnerId, partnerData[0], total, note);
  }

  return order;
}

export async function sendOrderNotifications(
  orderId: number,
  order: { name: string },
  partnerId: number,
  partner: { name: string; email: string; phone: string },
  total: number,
  note: string | false
): Promise<void> {
  const address = note ? note.replace('Envío: ', '') : 'No especificada';

  const clientBody = `
    <p>Hola ${partner.name},</p>
    <p>Hemos recibido tu pedido en <strong>Maruchy Manualidades</strong>. ¡Gracias por tu confianza!</p>
    <p><strong>Referencia:</strong> ${order.name}<br>
    <strong>Total:</strong> ${total.toFixed(2)} €<br>
    <strong>Dirección de entrega:</strong> ${address}</p>
    <p>Maruchy preparará tu pedido y te avisará cuando sea enviado. El pago se realiza al recibir el paquete.</p>
    <p>¿Tienes dudas? Escríbenos por <a href="https://wa.me/34676053518">WhatsApp</a>.</p>
    <p>Un abrazo,<br><strong>Maruchy Manualidades</strong></p>
  `.trim();

  const maruchyBody = `
    <p>🛍 <strong>Nuevo pedido web: ${order.name}</strong></p>
    <ul>
      <li><strong>Cliente:</strong> ${partner.name}</li>
      <li><strong>Email:</strong> ${partner.email}</li>
      <li><strong>Teléfono:</strong> ${partner.phone}</li>
      <li><strong>Total:</strong> ${total.toFixed(2)} €</li>
      <li><strong>Dirección:</strong> ${address}</li>
    </ul>
  `.trim();

  // Buscar partner de Maruchy sin usuario Odoo vinculado (el usuario API es el autor
  // del mensaje y Odoo lo excluye automáticamente de los destinatarios de email)
  const maruchyPartners = await rpc<{ id: number }[]>('res.partner', 'search_read', [
    [['email', '=', 'pedidos@maruchy.es'], ['user_ids', '=', false]],
  ], { fields: ['id'], limit: 1 });
  const maruchyPartnerId = maruchyPartners[0]?.id;

  // mail.compose.message renderiza HTML correctamente (message_post lo escapa)
  async function sendCompose(subject: string, body: string, recipientIds: number[]) {
    const composerId = await rpc<number>('mail.compose.message', 'create', [{
      subject,
      body,
      partner_ids: recipientIds,
      model: 'sale.order',
      res_ids: [orderId],
      composition_mode: 'comment',
    }]);
    return rpc<unknown>('mail.compose.message', 'action_send_mail', [[composerId]], {
      context: { active_ids: [orderId], active_model: 'sale.order' },
    });
  }

  const tasks: Promise<unknown>[] = [
    sendCompose(
      `Maruchy Manualidades — Pedido ${order.name} recibido`,
      clientBody,
      [partnerId],
    ),
  ];

  if (maruchyPartnerId) {
    tasks.push(sendCompose(
      `🛍 Nuevo pedido web: ${order.name}`,
      maruchyBody,
      [maruchyPartnerId],
    ));
  }

  await Promise.allSettled(tasks);
}

export type OrderState = 'draft' | 'sent' | 'sale' | 'done' | 'cancel';

export interface OrderLine {
  name: string;
  quantity: number;
  price_unit: number;
  price_subtotal: number;
}

export interface CustomerOrder {
  id: number;
  name: string;
  date: string;
  state: OrderState;
  total: number;
  note: string | false;
  lines: OrderLine[];
}

export async function getOrdersByEmail(email: string): Promise<CustomerOrder[]> {
  const partners = await rpc<{ id: number }[]>('res.partner', 'search_read', [
    [['email', '=', email.toLowerCase()]],
  ], { fields: ['id'], limit: 1 });

  if (!partners.length) return [];

  const orders = await rpc<{
    id: number; name: string; date_order: string;
    state: string; amount_total: number; note: string | false;
  }[]>('sale.order', 'search_read', [
    [['partner_id', '=', partners[0].id], ['origin', 'like', 'maruchy-web']],
  ], {
    fields: ['id', 'name', 'date_order', 'state', 'amount_total', 'note'],
    order: 'id desc',
    limit: 20,
  });

  if (!orders.length) return [];

  const orderIds = orders.map((o) => o.id);
  const lines = await rpc<{
    order_id: [number, string]; name: string;
    product_uom_qty: number; price_unit: number; price_subtotal: number;
  }[]>('sale.order.line', 'search_read', [
    [['order_id', 'in', orderIds]],
  ], {
    fields: ['order_id', 'name', 'product_uom_qty', 'price_unit', 'price_subtotal'],
  });

  return orders.map((order) => ({
    id: order.id,
    name: order.name,
    date: order.date_order,
    state: order.state as OrderState,
    total: order.amount_total,
    note: order.note,
    lines: lines
      .filter((l) => l.order_id[0] === order.id)
      .map((l) => ({
        name: l.name,
        quantity: l.product_uom_qty,
        price_unit: l.price_unit,
        price_subtotal: l.price_subtotal,
      })),
  }));
}
