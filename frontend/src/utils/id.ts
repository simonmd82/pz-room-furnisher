// Unique IDs for client-side placement keys.
//
// crypto.randomUUID() only exists in secure contexts (https, localhost) and in
// newer browsers. Opening the app via a LAN IP/hostname or in an older browser
// leaves it undefined ("crypto.randomUUID is not a function"), so fall back to
// getRandomValues (available in insecure contexts too), then to Math.random.
// These IDs only need to be unique within the session, not unguessable.

let counter = 0;

export function newId(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  counter = (counter + 1) % 0x7fffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
