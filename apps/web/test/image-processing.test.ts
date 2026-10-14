import assert from 'node:assert/strict';
import sharp from 'sharp';
import { test } from 'node:test';

test('Next optional sharp/libvips runtime rasterizes a local SVG image', async () => {
  // A tiny in-memory SVG exercises the SVG image-processing path without
  // opening a URL, reading user files, or contacting an external service.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1">' +
      '<rect width="2" height="1" fill="#1e90ff" /></svg>',
  );
  const png = await sharp(svg).png().toBuffer();
  const metadata = await sharp(png).metadata();

  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 1);
  assert.ok(png.length > 0);
});
