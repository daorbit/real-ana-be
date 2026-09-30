import { Schema } from "mongoose";

export const placedSchema = new Schema(
  {
    id: { type: String, required: true },
    span: { type: Number, required: true, enum: [1, 2, 3, 4] },
  },
  { _id: false }
);
