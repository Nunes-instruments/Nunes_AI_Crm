export function normalizeSource(source={}) {
  const url = String(source.url || source.source_url || '').trim();
  const name = String(source.name || source.title || source.source || '').trim();
  const type = String(source.type || source.source_type || 'Online Source').trim();
  return { type, name: name || type, url };
}

export function uniqueSources(sources=[]) {
  const seen = new Set(); const out=[];
  for (const raw of sources) {
    const s=normalizeSource(raw); const key=(s.url || `${s.type}|${s.name}`).toLowerCase();
    if (!key || seen.has(key)) continue; seen.add(key); out.push(s);
  }
  return out;
}
