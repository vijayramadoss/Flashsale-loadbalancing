import mongoose from 'mongoose';

// Named sequence (e.g. invoice numbers). nextSequence() uses one atomic
// findOneAndUpdate+$inc, so concurrent callers always get distinct, gap-free numbers.
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

export const Counter = mongoose.model('Counter', counterSchema);

export async function nextSequence(name, session) {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true, session });
  return doc.seq;
}
