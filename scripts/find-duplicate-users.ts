import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { User } from "../src/modules/identity/models/User.js";

async function main() {
  await connectDB();

  const indexes = await User.collection.indexes();
  const unique = indexes.some((i) => i.unique && Object.keys(i.key).join() === "email");
  console.log(`Unique index on users.email: ${unique ? "present" : "MISSING"}`);

  const groups = await User.aggregate<{ _id: string; users: { id: string; hasPassword: boolean; google: boolean; createdAt: Date }[] }>([
    { $group: {
      _id: { $toLower: "$email" },
      count: { $sum: 1 },
      users: { $push: {
        id: { $toString: "$_id" },
        hasPassword: { $gt: [{ $strLenCP: { $ifNull: ["$passwordHash", ""] } }, 0] },
        google: { $gt: [{ $strLenCP: { $ifNull: ["$googleId", ""] } }, 0] },
        createdAt: "$createdAt",
      } },
    } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 200 },
  ]);

  console.log(`${groups.length} email(s) shared by more than one user.`);
  for (const g of groups) console.log(g._id, JSON.stringify(g.users));
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
