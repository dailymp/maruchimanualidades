import type { APIRoute } from 'astro';
import { getProductImage } from '../../../lib/odoo';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  if (!id || isNaN(id)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const buffer = await getProductImage(id);
    if (!buffer) {
      return new Response('Not found', { status: 404 });
    }

    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const contentType = isJpeg ? 'image/jpeg' : 'image/png';

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch {
    return new Response('Error', { status: 500 });
  }
};
