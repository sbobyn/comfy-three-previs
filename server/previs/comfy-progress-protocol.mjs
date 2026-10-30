// Untrusted ComfyUI wire input. Nothing here decodes pixels or retains provider text.
export const PROGRESS_LIMITS = Object.freeze({ frameBytes: 2 * 1024 * 1024, metadataBytes: 4096, previewBytes: 256 * 1024, pixels: 4096 ** 2, previewSide: 768 });
const utf8 = new TextDecoder('utf-8', { fatal: true });
export const promptId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : null;
// Node labels come from our UI, never arbitrary provider text or workflow metadata.
export const nodeId = value => typeof value === 'string' && /^[0-9][0-9:._-]{0,63}$/.test(value) ? value : null;
function bytesOf(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return null;
}
function dimensions(bytes, mime) {
  if (mime === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}
export function parseBinaryFrame(input) {
  try {
    const frame = bytesOf(input);
    if (!frame || frame.length < 8 || frame.length > PROGRESS_LIMITS.frameBytes) return null;
    const type = frame.readUInt32BE(0), size = frame.readUInt32BE(4);
    let mime, id = null, node = null, bytes;
    if (type === 3) {
      if (size > PROGRESS_LIMITS.metadataBytes || size > frame.length - 8) return null;
      // Validate UTF-8, but never expose arbitrary text (it may contain credentials).
      utf8.decode(frame.subarray(8, 8 + size)); utf8.decode(frame.subarray(8 + size));
      return { kind: 'text' };
    }
    if (type === 1) {
      mime = size === 1 ? 'image/jpeg' : size === 2 ? 'image/png' : null;
      bytes = frame.subarray(8);
    } else if (type === 4) {
      if (size > PROGRESS_LIMITS.metadataBytes || size > frame.length - 8) return null;
      const meta = JSON.parse(utf8.decode(frame.subarray(8, 8 + size)));
      id = promptId(meta?.prompt_id); node = nodeId(meta?.node_id);
      if (!id) return null;
      mime = meta.image_type; bytes = frame.subarray(8 + size);
    } else return null;
    if (!['image/jpeg', 'image/png'].includes(mime) || bytes.length > PROGRESS_LIMITS.previewBytes) return null;
    const shape = dimensions(bytes, mime);
    if (!shape || !shape.width || !shape.height || shape.width * shape.height > PROGRESS_LIMITS.pixels || Math.max(shape.width, shape.height) > PROGRESS_LIMITS.previewSide) return null;
    return { kind: 'preview', legacy: type === 1, promptId: id, nodeId: node, mime, ...shape, bytes: Buffer.from(bytes) };
  } catch { return null; }
}
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function work(data) {
  const max = number(data.max), value = number(data.value);
  return { value: max > 0 && value !== null ? Math.min(value, max) : null, max: max > 0 ? max : null };
}
export function parseProgressMessage(input) {
  try {
    const bytes = typeof input === 'string' ? Buffer.from(input) : bytesOf(input);
    if (!bytes || bytes.length > PROGRESS_LIMITS.frameBytes) return null;
    const { type, data } = JSON.parse(utf8.decode(bytes));
    if (!data || !['execution_start', 'executing', 'progress', 'progress_state', 'execution_cached', 'executed', 'execution_success', 'execution_error', 'execution_interrupted'].includes(type)) return null;
    const id = promptId(data.prompt_id);
    if (!id) return null; // Reconnect `executing` without prompt identity is ambiguous.
    const result = { type, promptId: id, nodeId: nodeId(data.node), ...work(data) };
    if (type === 'executing') result.ended = data.node === null;
    if (type === 'progress_state') {
      result.nodes = Object.entries(data.nodes || {}).slice(0, 256).flatMap(([key, node]) => {
        const id = nodeId(key);
        return id && node && (!node.prompt_id || node.prompt_id === result.promptId) && ['running', 'finished', 'error'].includes(node.state) ? [{ id, state: node.state, ...work(node) }] : [];
      });
    }
    return result;
  } catch { return null; }
}
