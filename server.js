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

const sessionStore = MongoStore.create({
  client: mongoose.connection.getClient(),
  dbName: 'test', // Nom de ta base de données
  collectionName: 'sessions' // Optionnel : nom de la collection
});

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
    store: sessionStore, // Utilisation du store configuré plus haut
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 * 30, // 30 jours
        secure: process.env.NODE_ENV === 'production', // True sur Render
        httpOnly: true,
    },
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

    // --- MISE À JOUR DES FILTRES ---

    // 1. Recherche Textuelle (Barre de recherche "product")
    // On cherche si le mot tapé correspond à un type de produit ou une compétence
    if (req.query.product) {
        query.productTypes = { $regex: req.query.product, $options: 'i' };
    }

    // 2. Profil (Closeur, Setter...)
    if (req.query.profileType) {
        query.profileType = req.query.profileType;
    }

    // 3. Marché (B2B, B2C)
    if (req.query.market) {
        query.market = req.query.market;
    }

    // 4. Expertise Produit (Les tags cliquables)
    // Gère le cas où on coche plusieurs cases (Array) ou une seule (String)
    if (req.query.productTypes) {
        const types = [].concat(req.query.productTypes); 
        query.productTypes = { $in: types }; // Cherche si le closeur a au moins un des tags
    }

    // 5. Expérience (Années Minimum)
    // Note: Assure-toi que ton modèle Closer.js a bien le champ 'yearsExperience'
    if (req.query.yearsExperience) {
        query.yearsExperience = { $gte: parseInt(req.query.yearsExperience) };
    }

    // 6. Total Closé (Montant Minimum)
    if (req.query.totalClosed) {
        query.totalClosed = { $gte: parseInt(req.query.totalClosed) };
    }

    // 7. Type de Mission
    // Le formulaire envoie "missionType", mais dans ta DB c'est surement "contractType"
    // 7. Type de Mission
    if (req.query.missionType) {
        // AVANT (FAUX) : query.contractType = req.query.missionType; 
        // MAINTENANT (JUSTE) :
        query.missionType = req.query.missionType;
    }
    let sort = req.query.sort === 'best' ? { totalClosed: -1 } : { createdAt: -1 };

    const closers = await Closer.find(query).sort(sort);
    res.render('index', { closers, filters: req.query });
});

// 2. AUTHENTIFICATION (CHOIX)
app.get('/register-choice', (req, res) => res.render('auth/choice'));

// 3. INSCRIPTION ENTREPRISE
app.get('/register/company', (req, res) => res.render('auth/register-company'));
app.post('/register/company', async (req, res) => {
    try {
        const hashedPassword = await bcrypt.hash(req.body.password, 10);
        
        // 1. On stocke la nouvelle entreprise dans une variable
        const newCompany = await Company.create({
            companyName: req.body.companyName,
            email: req.body.email,
            password: hashedPassword
        });

        // 2. AUTO-LOGIN : On remplit la session
        req.session.user = { 
            id: newCompany._id, 
            role: 'company', 
            name: newCompany.companyName 
        };

        // 3. Sauvegarde session et redirection vers l'annuaire
        req.session.save((err) => {
            if (err) {
                console.error("Erreur session company", err);
                return res.redirect('/login');
            }
            // Les entreprises sont redirigées vers l'accueil pour voir les profils
            res.redirect('/'); 
        });

    } catch (e) {
        console.log(e);
        res.send("Erreur inscription Company : " + e.message);
    }
});

// 4. INSCRIPTION CLOSEUR
app.get('/register/closer', (req, res) => res.render('auth/register-closer'));
// Dans server.js
app.post('/register/closer', upload.single('photo'), async (req, res) => {
    try {
        const { email, password } = req.body;

        // --- FIX : On vérifie d'abord si l'email existe ---
        const existingUser = await Closer.findOne({ email }) || await Company.findOne({ email });
        if (existingUser) {
            return res.send("<h1>Erreur</h1><p>Cet email est déjà utilisé.</p><a href='/register/closer'>Réessayer</a>");
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = await Closer.create({
            ...req.body, 
            password: hashedPassword,
            // Sécurité pour les checkbox multiples
            productTypes: [].concat(req.body.productTypes || []),
            contractType: [].concat(req.body.contractType || []),
            photoUrl: req.file ? req.file.location : 'https://via.placeholder.com/150'
        });

        req.session.user = { id: newUser._id, role: 'closer', name: newUser.prenom };
        req.session.save(() => res.redirect('/dashboard'));

    } catch (e) { 
        console.error(e);
        res.send("Erreur technique : " + e.message); 
    }
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
    
    if (req.file) updates.photoUrl = req.file.location;
    
    // Forcer les tableaux pour éviter les bugs
    updates.productTypes = [].concat(req.body.productTypes || []);
    updates.contractType = [].concat(req.body.contractType || []);
    
    await Closer.findByIdAndUpdate(req.session.user.id, updates);
    res.redirect('/dashboard');
});

// 8. LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));