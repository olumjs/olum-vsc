import { store } from "olum";

export const cart = store({ items: [] });
export const cartCount = () => cart.items.length;
export function addItem(item) { cart.items.push(item); }
