// Git object hashing on the device. A file's version is its git blob SHA, so comparing a remote
// tree with the local replica needs no downloads (docs/plans/real-app.md §3, "Git objects").

const encoder = new TextEncoder();

/** Text → the UTF-8 bytes git stores. Strings are encoded; byte arrays pass through. */
export const toBytes = (data) => (typeof data === "string" ? encoder.encode(data) : data);

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The SHA-1 git gives a blob with these contents: sha1("blob <length>\0" + bytes). */
export async function blobSha(data) {
  const bytes = toBytes(data);
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(header.byteLength + bytes.byteLength);
  all.set(header, 0);
  all.set(bytes, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

/** Base64 (as the GitHub blob API sends it, with line breaks) → bytes. */
export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes → base64, for uploading blobs. */
export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** UTF-8 bytes → text. `fatal` so a file that is not valid UTF-8 is noticed, not silently mangled. */
export const bytesToText = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
