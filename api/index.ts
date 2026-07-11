import app from "../src/app.js";
import { connectDB } from "../src/db.js";

// Vercel serverless entrypoint. Ensure DB connected per cold start.
export default async function handler(req: any, res: any) {
  await connectDB();
  return app(req, res);
}
