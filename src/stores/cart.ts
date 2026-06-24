import { persistentAtom } from '@nanostores/persistent';

export interface CartItem {
  id: number;
  name: string;
  price: number;
  image: string;
  quantity: number;
}

export const cartItems = persistentAtom<CartItem[]>('maruchy-cart', [], {
  encode: JSON.stringify,
  decode: JSON.parse,
});

export function addItem(product: Omit<CartItem, 'quantity'>): void {
  const current = cartItems.get();
  const existing = current.find((i) => i.id === product.id);
  if (existing) {
    cartItems.set(current.map((i) =>
      i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
    ));
  } else {
    cartItems.set([...current, { ...product, quantity: 1 }]);
  }
}

export function removeItem(id: number): void {
  cartItems.set(cartItems.get().filter((i) => i.id !== id));
}

export function updateQty(id: number, qty: number): void {
  if (qty <= 0) {
    removeItem(id);
    return;
  }
  cartItems.set(cartItems.get().map((i) => (i.id === id ? { ...i, quantity: qty } : i)));
}

export function clearCart(): void {
  cartItems.set([]);
}

export function getTotal(): number {
  return cartItems.get().reduce((sum, i) => sum + i.price * i.quantity, 0);
}

export function getCount(): number {
  return cartItems.get().reduce((sum, i) => sum + i.quantity, 0);
}
