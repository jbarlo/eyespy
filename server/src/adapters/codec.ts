/** ImageCodec over sharp (libvips). It handles JPEG and PNG, and draws labels as SVG text (any Unicode). */
import sharp from "sharp";
import type { Gray, RGB } from "eyespy-core/pixels";
import type { ImageCodec, TextItem } from "eyespy-core/ports";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

export class SharpCodec implements ImageCodec {
  async decode(bytes: Uint8Array): Promise<RGB> {
    const { data, info } = await sharp(bytes)
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`expected RGB, got ${info.channels} channels`);
    return { w: info.width, h: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  }
  async decodeGray(bytes: Uint8Array): Promise<Gray> {
    const { data, info } = await sharp(bytes).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    return { w: info.width, h: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  }
  async encodeJpeg(img: RGB, quality: number) {
    return new Uint8Array(
      await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 3 } })
        .jpeg({ quality })
        .toBuffer(),
    );
  }
  async encodePng(img: Gray) {
    return new Uint8Array(
      await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 1 } })
        .png()
        .toBuffer(),
    );
  }
  async drawText(img: RGB, items: readonly TextItem[]): Promise<RGB> {
    if (!items.length) return img;
    const texts = items
      .map(
        (t) =>
          `<text x="${t.x}" y="${t.y}" font-size="${t.size}" fill="${rgb(t.fill)}" stroke="${rgb(t.stroke)}" ` +
          `stroke-width="${t.strokeWidth}" paint-order="stroke" stroke-linejoin="round">${esc(t.text)}</text>`,
      )
      .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.w}" height="${img.h}"><g font-family="DejaVu Sans, sans-serif" font-weight="bold">${texts}</g></svg>`;
    const { data } = await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 3 } })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { w: img.w, h: img.h, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  }
}
