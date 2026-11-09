import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { performance } from 'node:perf_hooks';

const root = process.argv[2];
if (!root) throw new Error('Usage: node study.mjs <build-directory> [output-json]');
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
}
const paths = (await walk(root)).sort();
const files = await Promise.all(paths.map(async path => ({ path: relative(root, path), bytes: await readFile(path) })));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function archive(input) {
  const index = [];
  let offset = 0;
  for (const file of input) {
    index.push({ path: file.path, offset, size: file.bytes.length, sha256: hash(file.bytes) });
    offset += file.bytes.length;
  }
  const header = Buffer.from(JSON.stringify(index));
  const prefix = Buffer.alloc(8);
  prefix.write('TCP1');
  prefix.writeUInt32BE(header.length, 4);
  return Buffer.concat([prefix, header, ...input.map(file => file.bytes)]);
}
function grouped(input) {
  const groups = new Map();
  for (const file of input) {
    const key = ['.html', '.css'].includes(extname(file.path)) ? 'shell' : extname(file.path) === '.js' ? 'scripts' : 'media';
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return [...groups].sort().map(([name, entries]) => ({ name, bytes: archive(entries) }));
}
function compress(bytes, codec) {
  return codec === 'gzip' ? gzipSync(bytes, { level: 9 }) : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
}
function scenario(input, name, codec, layout) {
  const started = performance.now();
  const units = layout === 'whole' ? [{ name: 'whole', bytes: archive(input) }] : layout === 'grouped' ? grouped(input) : input.map(file => ({ name: file.path, bytes: file.bytes }));
  const encoded = units.map(unit => ({ name: unit.name, bytes: compress(unit.bytes, codec) }));
  const elapsedMs = performance.now() - started;
  encoded.forEach((unit, i) => {
    const decoded = codec === 'gzip' ? gunzipSync(unit.bytes) : brotliDecompressSync(unit.bytes);
    if (!decoded.equals(units[i].bytes)) throw new Error('Roundtrip mismatch');
    if (!compress(units[i].bytes, codec).equals(unit.bytes)) throw new Error('Nonreproducible compression');
  });
  const totalBytes = encoded.reduce((sum, unit) => sum + unit.bytes.length, 0);
  return { name, codec, layout, totalBytes, chunks: encoded.reduce((sum, unit) => sum + Math.ceil(unit.bytes.length / 24000), 0), objects: encoded.length, elapsedMs: Math.round(elapsedMs), units: encoded.map(unit => ({ name: unit.name, bytes: unit.bytes.length, hash: hash(unit.bytes) })) };
}
const configurations = [['gzip individual','gzip','individual'], ['gzip whole','gzip','whole'], ['gzip grouped','gzip','grouped'], ['brotli whole','brotli','whole'], ['brotli grouped','brotli','grouped']];
const baseline = { totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), objects: files.length, chunks: files.reduce((sum, file) => sum + Math.ceil(file.bytes.length / 24000), 0), files: files.map(file => ({ path:file.path, bytes:file.bytes.length, sha256:hash(file.bytes) })) };
const results = configurations.map(config => scenario(files, ...config)).map(result => ({ ...result, reductionPct: Number((100*(1-result.totalBytes/baseline.totalBytes)).toFixed(2)) }));
const changed = files.map(file => extname(file.path) === '.css' ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from('\n/* synthetic incremental test */\n.study-demo{color:#719a64}\n')]) } : file);
const incremental = configurations.map(config => {
  const after = scenario(changed, ...config);
  const before = results.find(result => result.name === after.name);
  const changedUnits = after.units.filter(unit => before.units.find(old => old.name === unit.name)?.hash !== unit.hash);
  return { name: after.name, changedPayloadBytes: changedUnits.reduce((sum, unit) => sum + unit.bytes, 0), changedObjects: changedUnits.length };
});
const report = { createdAt: new Date().toISOString(), node: process.version, root, method: 'Experimental deterministic index+binary payload; no production loader, chain simulation, base64 embedding or fees included. CSS-only change is synthetic, not a rebuild. Codec-level independent/group comparisons only.', baseline, results, incremental, roundtripVerified: true, repeatOutputVerified: true };
await writeFile(process.argv[3] ?? '/tmp/tapeci-compression-study-results.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ method: report.method, baseline, results: results.map(({ units, ...result }) => result), incremental, roundtripVerified: true, repeatOutputVerified: true }, null, 2));
