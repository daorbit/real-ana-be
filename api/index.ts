import "dotenv/config";
import app from "../src/app.js";
import { connectDB } from "../src/infra/db/connection.js";

export default async function handler(req: any, res: any) {
  await connectDB();
  return app(req, res);
}
