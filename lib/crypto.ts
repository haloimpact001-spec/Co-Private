// lib/crypto.ts
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function generateKey(): Promise<CryptoKey> {
  return window.crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  ) as Promise<CryptoKey>;
}

export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const exported = await window.crypto.subtle.exportKey('raw', key);
  return uint8ArrayToBase64(new Uint8Array(exported));
}

export async function importKeyFromBase64(base64Key: string): Promise<CryptoKey> {
  let cleaned = base64Key.trim();
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep cleaned as is if already decoded
  }
  // Remove accidental spaces or newlines
  cleaned = cleaned.replace(/\s+/g, '');

  const bytes = base64ToUint8Array(cleaned);
  return window.crypto.subtle.importKey(
    'raw',
    bytes as BufferSource,
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  ) as Promise<CryptoKey>;
}

export async function encryptText(plainText: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plainText);
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    data
  );

  const encryptedArray = new Uint8Array(encryptedBuffer);
  const combined = new Uint8Array(iv.length + encryptedArray.length);
  combined.set(iv, 0);
  combined.set(encryptedArray, iv.length);

  return uint8ArrayToBase64(combined);
}

export async function decryptText(base64Payload: string, key: CryptoKey): Promise<string> {
  let cleaned = base64Payload.trim();
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Already decoded
  }
  cleaned = cleaned.replace(/\s+/g, '');

  const combined = base64ToUint8Array(cleaned);
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}
