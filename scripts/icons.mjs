// Renders the app icons from one SVG mark (blue ring, like the dashboard logo).
import sharp from "sharp";
import { mkdirSync } from "node:fs";

mkdirSync("public/icons", { recursive: true });

const mark = (pad, bg = "#ffffff") => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="${bg}"/>
  <g transform="translate(256 256) scale(${pad ? 0.62 : 0.8})">
    <circle r="150" fill="#2f5bea"/>
    <circle r="78" fill="${bg}"/>
    <path d="M 0 -150 A 150 150 0 0 1 150 0 L 78 0 A 78 78 0 0 0 0 -78 Z" fill="#9db4ff"/>
  </g>
</svg>`;

const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="34" fill="none" stroke="#000" stroke-width="18"/></svg>`;

await sharp(Buffer.from(mark(false))).resize(192, 192).png().toFile("public/icons/icon-192.png");
await sharp(Buffer.from(mark(false))).resize(512, 512).png().toFile("public/icons/icon-512.png");
await sharp(Buffer.from(mark(true))).resize(512, 512).png().toFile("public/icons/maskable-512.png");
await sharp(Buffer.from(mark(true))).resize(180, 180).png().toFile("public/icons/apple-touch-icon.png");
await sharp(Buffer.from(mark(false))).resize(48, 48).png().toFile("public/icons/favicon-48.png");
await sharp(Buffer.from(badge)).resize(96, 96).png().toFile("public/icons/badge-96.png");
console.log("icons written");
