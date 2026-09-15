export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}
