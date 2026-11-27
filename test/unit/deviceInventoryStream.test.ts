import { readDeviceInventoryEntries } from '../../lib/device/transport/deviceInventoryStream';

async function readChunks(...chunks: Buffer[]): Promise<unknown[]> {
  const rows: unknown[] = [];
  async function* bytes(): AsyncGenerator<Buffer> { yield* chunks; }
  for await (const row of readDeviceInventoryEntries(bytes())) rows.push(row);
  return rows;
}

describe('device inventory JSON stream', () => {
  it.each([
    JSON.stringify({ relay: { name: '💡 ø', nested: [{ ']': '{,} " \\' }] }, meter: { watts: -250 } }),
    '[{"relay":{"name":"💡","escaped":"\\u00e9"}},null,false,2,["é",{},[]]]',
  ])('matches JSON.parse at every possible byte boundary', async (json) => {
    const bytes = Buffer.from(json);
    const expected = Object.values(JSON.parse(json));
    for (let split = 1; split < bytes.length; split += 1) {
      const result = await readChunks(bytes.subarray(0, split), bytes.subarray(split));
      expect(result).toEqual(expected);
    }
  });

  it.each(['{}', '[] \t\r\n'])('accepts an empty collection %s', async (json) => {
    expect(await readChunks(Buffer.from(json))).toEqual([]);
  });

  it('decodes invalid UTF-8 with the same replacement as the buffered path', async () => {
    const bytes = Buffer.concat([
      Buffer.from('{"relay":{"name":"'),
      Buffer.from([0xe2, 0x28, 0xa1, 0xf0, 0x9f, 0xc3, 0xa9]),
      Buffer.from('"}}'),
    ]);
    const expected = Object.values(JSON.parse(bytes.toString('utf8')));
    expect(await readChunks(...Array.from(bytes, (byte) => Buffer.from([byte])))).toEqual(expected);
  });

  it.each(['{"relay":{},}', '[{},]', '{"relay":{}}x', '[{}]{}', '{"relay":{}', '{}\u00a0'])(
    'rejects invalid or incomplete inventory %s',
    async (json) => {
      await expect(readChunks(Buffer.from(json))).rejects.toThrow(SyntaxError);
    },
  );
});
