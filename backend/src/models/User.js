import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    // select:false keeps the hash out of every query unless explicitly requested.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

userSchema.methods.toPublic = function toPublic() {
  return { id: this._id.toString(), name: this.name, email: this.email, role: this.role };
};

export const User = mongoose.model('User', userSchema);
