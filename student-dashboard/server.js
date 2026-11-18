require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // single HTML file uses inline CSS/JS
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves public/index.html at "/"

// ---------- Model ----------
const studentSchema = new mongoose.Schema(
  {
    name:   { type: String, required: [true, 'name is required'], trim: true, minlength: [2, 'name must be at least 2 characters'], maxlength: [100, 'name is too long'] },
    email:  { type: String, required: [true, 'email is required'], trim: true, lowercase: true, unique: true, match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email must be valid'] },
    course: { type: String, required: [true, 'course is required'], trim: true, minlength: [2, 'course must be at least 2 characters'], maxlength: [100, 'course is too long'] },
    age:    { type: Number, required: [true, 'age is required'], min: [5, 'age must be 5 or more'], max: [120, 'age must be 120 or less'], validate: { validator: Number.isInteger, message: 'age must be a whole number' } },
  },
  {
    timestamps: true,
    toJSON: { versionKey: false, transform: (doc, ret) => { ret.id = ret._id; delete ret._id; return ret; } },
  }
);
const Student = mongoose.model('Student', studentSchema);

// ---------- Helpers ----------
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validId = (req, res, next) =>
  mongoose.isValidObjectId(req.params.id) ? next() : res.status(400).json({ success: false, error: 'Invalid student id' });
const pick = (b = {}) => Object.fromEntries(['name', 'email', 'course', 'age'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));

// ---------- Routes ----------
app.get('/health', (req, res) => res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));

// Dashboard numbers
app.get('/api/stats', async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [total, avg, courses, newThisWeek, recent] = await Promise.all([
    Student.countDocuments(),
    Student.aggregate([{ $group: { _id: null, avgAge: { $avg: '$age' } } }]),
    Student.aggregate([{ $group: { _id: '$course', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }]),
    Student.countDocuments({ createdAt: { $gte: weekAgo } }),
    Student.find().sort({ createdAt: -1 }).limit(5),
  ]);
  res.json({
    success: true,
    total,
    avgAge: avg[0] ? Math.round(avg[0].avgAge * 10) / 10 : 0,
    courseCount: courses.length,
    newThisWeek,
    courses: courses.slice(0, 5).map((c) => ({ name: c._id, count: c.count })),
    recent,
  });
});

// CREATE
app.post('/api/students', async (req, res) => {
  const student = await Student.create(pick(req.body));
  res.status(201).json({ success: true, data: student });
});

// READ all (search + pagination)
app.get('/api/students', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const q = String(req.query.q || '').trim();
  const rx = q && new RegExp(escapeRegex(q), 'i');
  const filter = q ? { $or: [{ name: rx }, { email: rx }, { course: rx }] } : {};
  const [total, data] = await Promise.all([
    Student.countDocuments(filter),
    Student.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
  ]);
  res.json({ success: true, page, limit, total, totalPages: Math.ceil(total / limit), data });
});

// READ one
app.get('/api/students/:id', validId, async (req, res) => {
  const s = await Student.findById(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: 'Student not found' });
  res.json({ success: true, data: s });
});

// UPDATE (PUT and PATCH both update the fields you send)
const update = async (req, res) => {
  const body = pick(req.body);
  if (!Object.keys(body).length) return res.status(400).json({ success: false, error: 'Send at least one field to update' });
  const s = await Student.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true });
  if (!s) return res.status(404).json({ success: false, error: 'Student not found' });
  res.json({ success: true, data: s });
};
app.put('/api/students/:id', validId, update);
app.patch('/api/students/:id', validId, update);

// DELETE
app.delete('/api/students/:id', validId, async (req, res) => {
  const s = await Student.findByIdAndDelete(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: 'Student not found' });
  res.json({ success: true, message: 'Student deleted' });
});

app.use('/api', (req, res) => res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` }));

// ---------- Errors ----------
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => (e.name === 'CastError' ? `${e.path} is invalid` : e.message));
    return res.status(400).json({ success: false, errors });
  }
  if (err.code === 11000) return res.status(409).json({ success: false, error: 'A student with this email already exists' });
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ---------- Start ----------
const { MONGODB_URI, PORT = 3000 } = process.env;
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Copy .env.example to .env and add your MongoDB connection string.');
  process.exit(1);
}
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => { console.error('MongoDB connection failed:', err.message); process.exit(1); });
