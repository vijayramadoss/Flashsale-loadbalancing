import mongoose from 'mongoose';

// Saved delivery address. Embedded in the user (a user has a handful at most,
// and they are always read together with the user).
const addressSchema = new mongoose.Schema({
  label: { type: String, enum: ['Home', 'Work', 'Other'], default: 'Home' },
  fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  phone: { type: String, required: true, match: /^[6-9]\d{9}$/ }, // Indian mobile number
  line1: { type: String, required: true, trim: true, maxlength: 120 },
  line2: { type: String, trim: true, maxlength: 120, default: '' },
  city: { type: String, required: true, trim: true, maxlength: 60 },
  state: { type: String, required: true, trim: true, maxlength: 60 },
  pincode: { type: String, required: true, match: /^\d{6}$/ },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    // select:false keeps the hash out of every query unless explicitly requested.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    addresses: { type: [addressSchema], default: [] },
    wishlist: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], default: [] },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

userSchema.methods.toPublic = function toPublic() {
  return { id: this._id.toString(), name: this.name, email: this.email, role: this.role };
};

export const User = mongoose.model('User', userSchema);
