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

  return rpc<OdooProduct[]>('product.template', 'search_read', [domain], {
    fields: ['id', 'name', 'list_price', 'description_sale', 'categ_id'],
    limit: 100,
    order: 'sequence asc, id asc',
  });
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

  return order;
}
