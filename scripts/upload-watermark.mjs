import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import axios from "axios";

config();

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME ?? "";
const API_KEY = process.env.CLOUDINARY_API_KEY ?? "";
const API_SECRET = process.env.CLOUDINARY_API_SECRET ?? "";

if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  console.error("Cloudinary env vars missing (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET).");
  process.exit(1);
}

function sign(params) {
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(base + API_SECRET).digest("hex");
}

const filePath = process.argv[2] ?? "../real-ana-fe/public/da-ai-light-mode.png";
const publicId = "orbit/watermark/orbit-ai-mark";

const bytes = readFileSync(new URL(filePath, `file://${process.cwd()}/`));
const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;

const signed = {
  public_id: publicId,
  timestamp: String(Math.floor(Date.now() / 1000)),
  overwrite: "true",
};

const form = new URLSearchParams({
  ...signed,
  signature: sign(signed),
  api_key: API_KEY,
  file: dataUrl,
});

const { data } = await axios.post(
  `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
  form,
  { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30_000 },
);

console.log("Uploaded. public_id =", data.public_id);
console.log("url =", data.secure_url);
console.log("\nSet in .env:\nORBIT_WATERMARK_PUBLIC_ID=" + data.public_id);
