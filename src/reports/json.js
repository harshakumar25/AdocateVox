// Salvage a complete JSON object from fences or a prose wrapper. Never repair evidence strings.
export const parseJson = (text) => {
  if (text && typeof text === 'object') return text;
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch { /* Find a balanced object below. */ }
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
};

export const validSchema = (value, schema) => {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value));
  if (schema.type === 'array') return Array.isArray(value) && value.every((item) => validSchema(item, schema.items));
  if (schema.type === 'object') return value && typeof value === 'object' && !Array.isArray(value)
    && (schema.required || []).every((key) => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, item]) => schema.properties[key] ? validSchema(item, schema.properties[key]) : schema.additionalProperties !== false);
  return false;
};
export const objectSchema = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const stringSchema = { type: 'string' };
export const arraySchema = (items) => ({ type: 'array', items });
