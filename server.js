
const path = require('path');
const fs = require('fs').promises;
const { randomUUID } = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Storage ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'students.json');

async function initializeStore() {
    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
        await fs.access(DATA_FILE);
    } catch {
        await fs.writeFile(DATA_FILE, '[]', 'utf8');
    }
}

async function readStudents() {
    const content = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(content);
}

async function writeStudents(students) {
    const tempFile = DATA_FILE + '.tmp';
    await fs.writeFile(tempFile, JSON.stringify(students, null, 2), 'utf8');
    await fs.rename(tempFile, DATA_FILE);
}

// Serialize operations to prevent simultaneous requests
// from overwriting each other's changes.
let storeQueue = Promise.resolve();

function runStore(task, persist = false) {
    const operation = storeQueue.then(async () => {
        const students = await readStudents();
        const result = await task(students);

        if (persist) {
            await writeStudents(students);
        }

        return result;
    });

    storeQueue = operation.then(() => undefined, () => undefined);
    return operation;
}

// ---------- Helpers ----------
const pick = (body = {}) =>
    Object.fromEntries(
        ['name', 'email', 'course', 'age']
            .filter(key => body[key] !== undefined)
            .map(key => [key, body[key]])
    );

function validateStudent(body, existingStudents, currentId = null) {
    const errors = [];
    const { name, email, course, age } = body;

    if (name !== undefined &&
        (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100)) {
        errors.push('Name must be between 2 and 100 characters');
    }

    if (email !== undefined &&
        (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) {
        errors.push('Email must be valid');
    }

    if (course !== undefined &&
        (typeof course !== 'string' || course.trim().length < 2 || course.trim().length > 100)) {
        errors.push('Course must be between 2 and 100 characters');
    }

    if (age !== undefined &&
        (!Number.isInteger(age) || age < 5 || age > 120)) {
        errors.push('Age must be a whole number between 5 and 120');
    }

    if (email !== undefined && typeof email === 'string') {
        const normalizedEmail = email.trim().toLowerCase();

        const duplicate = existingStudents.some(student =>
            student.email === normalizedEmail && student.id !== currentId
        );

        if (duplicate) {
            errors.push('A student with this email already exists');
        }
    }

    return errors;
}

function normalizeStudent(body) {
    return {
        ...body,
        name: body.name.trim(),
        email: body.email.trim().toLowerCase(),
        course: body.course.trim()
    };
}

function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ---------- Health ----------
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        storage: 'JSON file',
        database: 'not required'
    });
});

// ---------- Dashboard Statistics ----------
app.get('/api/stats', asyncHandler(async (req, res) => {
    const stats = await runStore(students => {
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        const courses = {};

        students.forEach(student => {
            courses[student.course] = (courses[student.course] || 0) + 1;
        });

        const avgAge = students.length
            ? students.reduce((sum, student) => sum + student.age, 0) / students.length
            : 0;

        const recent = [...students]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 5);

        return {
            success: true,
            total: students.length,
            avgAge: Math.round(avgAge * 10) / 10,
            courseCount: Object.keys(courses).length,
            newThisWeek: students.filter(
                student => new Date(student.createdAt).getTime() >= weekAgo
            ).length,
            courses: Object.entries(courses)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
                .slice(0, 5),
            recent
        };
    });

    res.json(stats);
}));

// ---------- CREATE ----------
app.post('/api/students', asyncHandler(async (req, res) => {
    const student = await runStore(students => {
        const body = pick(req.body);

        const required = ['name', 'email', 'course', 'age'];
        const missing = required.filter(key => body[key] === undefined);

        if (missing.length) {
            const error = new Error(`Missing required fields: ${missing.join(', ')}`);
            error.status = 400;
            throw error;
        }

        const errors = validateStudent(body, students);

        if (errors.length) {
            const error = new Error(errors.join(', '));
            error.status = 400;
            error.errors = errors;
            throw error;
        }

        const newStudent = {
            id: randomUUID(),
            ...normalizeStudent(body),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        students.push(newStudent);
        return newStudent;
    }, true);

    res.status(201).json({ success: true, data: student });
}));

// ---------- READ ALL ----------
app.get('/api/students', asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const q = String(req.query.q || '').trim().toLowerCase();

    const result = await runStore(students => {
        const filtered = students.filter(student =>
            !q ||
            student.name.toLowerCase().includes(q) ||
            student.email.toLowerCase().includes(q) ||
            student.course.toLowerCase().includes(q)
        );

        const sorted = [...filtered].sort(
            (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );

        const start = (page - 1) * limit;

        return {
            success: true,
            page,
            limit,
            total: sorted.length,
            totalPages: Math.ceil(sorted.length / limit),
            data: sorted.slice(start, start + limit)
        };
    });

    res.json(result);
}));

// ---------- READ ONE ----------
app.get('/api/students/:id', asyncHandler(async (req, res) => {
    const student = await runStore(students =>
        students.find(s => s.id === req.params.id)
    );

    if (!student) {
        return res.status(404).json({
            success: false,
            error: 'Student not found'
        });
    }

    res.json({ success: true, data: student });
}));

// ---------- UPDATE ----------
const updateStudent = asyncHandler(async (req, res) => {
    const student = await runStore(students => {
        const index = students.findIndex(s => s.id === req.params.id);

        if (index === -1) return null;

        const body = pick(req.body);

        if (!Object.keys(body).length) {
            const error = new Error('Send at least one field to update');
            error.status = 400;
            throw error;
        }

        const errors = validateStudent(body, students, req.params.id);

        if (errors.length) {
            const error = new Error(errors.join(', '));
            error.status = 400;
            error.errors = errors;
            throw error;
        }

        const updatedFields = { ...body };

        if (updatedFields.name !== undefined) updatedFields.name = updatedFields.name.trim();
        if (updatedFields.email !== undefined) updatedFields.email = updatedFields.email.trim().toLowerCase();
        if (updatedFields.course !== undefined) updatedFields.course = updatedFields.course.trim();

        students[index] = {
            ...students[index],
            ...updatedFields,
            updatedAt: new Date().toISOString()
        };

        return students[index];
    }, true);

    if (!student) {
        return res.status(404).json({
            success: false,
            error: 'Student not found'
        });
    }

    res.json({ success: true, data: student });
});

app.put('/api/students/:id', updateStudent);
app.patch('/api/students/:id', updateStudent);

// ---------- DELETE ----------
app.delete('/api/students/:id', asyncHandler(async (req, res) => {
    const deleted = await runStore(students => {
        const index = students.findIndex(s => s.id === req.params.id);

        if (index === -1) return false;

        students.splice(index, 1);
        return true;
    }, true);

    if (!deleted) {
        return res.status(404).json({
            success: false,
            error: 'Student not found'
        });
    }

    res.json({
        success: true,
        message: 'Student deleted'
    });
}));

// ---------- Unknown API Routes ----------
app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        error: `Route not found: ${req.method} ${req.originalUrl}`
    });
});

// ---------- Error Handling ----------
app.use((err, req, res, next) => {
    console.error(err);

    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({
            success: false,
            error: 'Invalid JSON body'
        });
    }

    res.status(err.status || 500).json({
        success: false,
        error: err.status ? err.message : 'Internal server error',
        ...(err.errors ? { errors: err.errors } : {})
    });
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;

initializeStore()
    .then(() => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log('JSON storage initialized:', DATA_FILE);
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to initialize JSON storage:', err);
        process.exit(1);
    });
