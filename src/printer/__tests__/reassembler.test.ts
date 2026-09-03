import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseReassembler } from '../reassembler.ts';
import { fromHex, toHex } from '../hex.ts';
import { DryRunTransport, chunkFrame } from '../transport.ts';
import { PrinterClient } from '../client.ts';
import { buildStatusFrame } from '../frames.ts';

test('single complete notification', () => {
  const r = new ResponseReassembler('new');
  const out = r.push(fromHex('66 06 00 11 00 83'));
  assert.equal(out && toHex(out), '66 06 00 11 00 83');
});

test('length-driven reassembly across several notifications', () => {
  const r = new ResponseReassembler('new');
  const full = new Uint8Array(44);
  full[0] = 0x66;
  full[1] = 44;
  full[3] = 0x10;
  for (let i = 4; i < 44; i++) full[i] = i;
  assert.equal(r.push(full.subarray(0, 20)), null);
  assert.equal(r.push(full.subarray(20, 40)), null);
  const out = r.push(full.subarray(40));
  assert.ok(out);
  assert.deepEqual(Array.from(out), Array.from(full));
  assert.equal(r.pendingBytes, 0);
});

test('"##" prefixed chunks lose their first 4 bytes', () => {
  const r = new ResponseReassembler('new');
  const out = r.push(fromHex('23 23 00 06 66 06 00 10 00 84'));
  assert.equal(out && toHex(out), '66 06 00 10 00 84');
});

test('"**" responses are returned whole', () => {
  const r = new ResponseReassembler('new');
  const out = r.push(fromHex('2A 2A 2A 2A 2A'));
  assert.equal(out && toHex(out), '2A 2A 2A 2A 2A');
});

test('extra trailing bytes are discarded, old-flavour uses byte 1 only', () => {
  const r = new ResponseReassembler('old');
  const out = r.push(fromHex('66 06 00 10 00 84 FF FF'));
  assert.equal(out && toHex(out), '66 06 00 10 00 84');
});

test('chunkFrame splits to the transport size', () => {
  const frame = new Uint8Array(45).map((_, i) => i);
  const chunks = chunkFrame(frame, 20);
  assert.deepEqual(chunks.map((c) => c.length), [20, 20, 5]);
});

test('dry-run client logs frames and never blocks', async () => {
  const t = new DryRunTransport();
  const client = new PrinterClient(t);
  const lines: string[] = [];
  client.on('log', (level, msg) => lines.push(`${level} ${msg}`));
  const st = await client.queryStatus();
  assert.equal(st, null);
  assert.equal(t.written.length, 1);
  assert.equal(toHex(t.written[0]), toHex(buildStatusFrame(0)));
  assert.ok(lines.some((l) => l.startsWith('tx ')));
});

test('live client resolves an exchange from injected notifications', async () => {
  const t = new DryRunTransport();
  // pretend to be a live transport for this test
  (t as unknown as { kind: string }).kind = 'ble';
  const client = new PrinterClient(t, { responseTimeoutMs: 500 });
  const reply = new Uint8Array(44);
  reply[0] = 0x66;
  reply[1] = 44;
  reply[3] = 0x10;
  reply[5] = 80;
  reply[36] = 1;
  reply[37] = 3;
  reply[39] = 12;
  reply[41] = 56;
  let sum = 0;
  for (let i = 0; i < 43; i++) sum += reply[i];
  reply[43] = (256 - (sum & 0xff)) & 0xff;
  const p = client.queryStatus();
  // notification arrives in two BLE-sized pieces
  setTimeout(() => t.injectNotification(reply.subarray(0, 20)), 5);
  setTimeout(() => t.injectNotification(reply.subarray(20)), 10);
  const st = await p;
  assert.ok(st);
  assert.equal(st.batteryPercent, 80);
  assert.equal(st.headWidthBytes, 12);
  assert.equal(st.checksumOk, true);
});
