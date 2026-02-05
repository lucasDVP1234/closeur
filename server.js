require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs'); // Pour crypter les mdp
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const Closer = require('./models/Closer');
const Company = require('./models/Company');

const app = express();

// --- CONFIGURATION ---
mongoose.connect(process.env.MONGO_URI).then(() => console.log('🔥 DB Connectée'));

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
});

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.AWS_BUCKET_NAME,
        metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
        key: (req, file, cb) => cb(null, Date.now().toString() + "-" + file.originalname)
    })
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('trust proxy', 1);

// SYSTEME DE SESSION (Cookies)
app.use(session({
    secret: 'supersecretkey', // Change ça en prod
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI // On utilise la même DB que pour les users
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 60, // La session dure 60 jour (en millisecondes)
        secure: process.env.NODE_ENV === 'production' // true sur Render (https), false en local
    }
}));

// Middleware pour passer l'info utilisateur à toutes les vues
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// Middleware de protection (Si pas connecté, on vire)
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

// --- ROUTES ---

// 1. ACCUEIL
app.get('/', async (req, res) => {
    let query = {};
    if (req.query.experience) query.experienceLevel = req.query.experience;
    if (req.query.skill) query.skills = { $in: [req.query.skill] };
    let sort = req.query.sort === 'best' ? { totalClosed: -1 } : { createdAt: -1 };

    const closers = await Closer.find(query).sort(sort);
    res.render('index', { closers, filters: req.query });
});

// 2. AUTHENTIFICATION (CHOIX)
app.get('/register-choice', (req, res) => res.render('auth/choice'));

// 3. INSCRIPTION ENTREPRISE
app.get('/register/company', (req, res) => res.render('auth/register-company'));
app.post('/register/company', async (req, res) => {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    await Company.create({
        companyName: req.body.companyName,
        email: req.body.email,
        password: hashedPassword
    });
    res.redirect('/login');
});

// 4. INSCRIPTION CLOSEUR
app.get('/register/closer', (req, res) => res.render('auth/register-closer'));
app.post('/register/closer', upload.single('photo'), async (req, res) => {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    await Closer.create({
        ...req.body,
        password: hashedPassword,
        skills: req.body.skills ? req.body.skills.split(',').map(s => s.trim()) : [],
        photoUrl: req.file ? req.file.location : 'https://via.placeholder.com/150'
    });
    res.redirect('/login');
});

// 5. LOGIN
app.get('/login', (req, res) => res.render('auth/login'));
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    // On cherche d'abord dans les entreprises
    let user = await Company.findOne({ email });
    let role = 'company';

    // Si pas trouvé, on cherche dans les closeurs
    if (!user) {
        user = await Closer.findOne({ email });
        role = 'closer';
    }

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { id: user._id, role: role, name: user.prenom || user.companyName };
        if(role === 'closer') return res.redirect('/dashboard');
        return res.redirect('/');
    }
    res.send("Email ou mot de passe incorrect");
});

// 6. DASHBOARD (Seulement pour les closeurs)
app.get('/dashboard', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'closer') return res.redirect('/');
    const closer = await Closer.findById(req.session.user.id);
    res.render('dashboard', { closer });
});

// 7. MISE A JOUR PROFIL (Dashboard)
app.post('/dashboard/update', isAuthenticated, upload.single('photo'), async (req, res) => {
    const updates = { ...req.body };
    if (req.file) updates.photoUrl = req.file.location; // Si nouvelle photo
    updates.skills = req.body.skills ? req.body.skills.split(',').map(s => s.trim()) : [];
    
    await Closer.findByIdAndUpdate(req.session.user.id, updates);
    res.redirect('/dashboard');
});

// 8. LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));