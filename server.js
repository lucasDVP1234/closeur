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
const Offer = require('./models/Offer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);



const app = express();

// --- 1. ROUTE WEBHOOK STRIPE (DOIT ÊTRE PLACÉE AVANT LES PARSEURS BODY) ---
// C'est ici que Stripe nous parle en secret pour confirmer les paiements ou annulations
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gestion des événements
    switch (event.type) {
        case 'checkout.session.completed':
            // LE PAIEMENT A RÉUSSI -> ON ACTIVE LE PREMIUM
            const session = event.data.object;
            const userId = session.metadata.userId;
            
            console.log(`💰 Paiement validé pour le user ${userId}`);
            
            await Closer.findByIdAndUpdate(userId, { 
                isPremium: true,
                stripeCustomerId: session.customer,
                stripeSubscriptionId: session.subscription
            });
            break;

        case 'customer.subscription.deleted':
            // L'ABONNEMENT EST ANNULÉ/EXPIRÉ -> ON COUPE L'ACCÈS
            const subscription = event.data.object;
            // On retrouve le user grâce à son ID client Stripe
            const closer = await Closer.findOne({ stripeCustomerId: subscription.customer });
            
            if (closer) {
                console.log(`❌ Abonnement terminé pour ${closer.prenom}. Accès coupé.`);
                closer.isPremium = false;
                closer.stripeSubscriptionId = null;
                await closer.save();
            }
            break;
            
        case 'invoice.payment_failed':
            // LE PAIEMENT MENSUEL A ÉCHOUÉ -> ON PEUT COUPER L'ACCÈS
            const invoice = event.data.object;
            const badPayer = await Closer.findOne({ stripeCustomerId: invoice.customer });
            if (badPayer) {
                console.log(`⚠️ Paiement échoué pour ${badPayer.prenom}.`);
                badPayer.isPremium = false;
                await badPayer.save();
            }
            break;
    }

    res.json({received: true});
});

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
    let sort = req.query.sort === 'best' 
    ? { isPremium: -1, totalClosed: -1 }  // D'abord Premium, ensuite le CA
    : { isPremium: -1, createdAt: -1 };

    const closers = await Closer.find(query).sort(sort);
    if (req.session.user && req.session.user.role === 'closer') {
        const currentUser = await Closer.findById(req.session.user.id);
        if (currentUser) req.session.user.isPremium = currentUser.isPremium;
    }

    res.render('index', { closers, filters: req.query });
});

// --- NOUVELLE ROUTE : CRÉER LE PAIEMENT (CHECKOUT) ---
app.post('/create-closer-checkout', isAuthenticated, async (req, res) => {
    try {
        const user = await Closer.findById(req.session.user.id);
        
        // On crée la session de paiement Stripe
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription', // Mode ABONNEMENT
            customer_email: user.email,
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_ID, // ID du prix (ex: price_1P5x...) à créer dans Stripe
                    quantity: 1,
                },
            ],
            metadata: {
                userId: user._id.toString() // Pour savoir QUI a payé dans le webhook
            },
            success_url: `${process.env.DOMAIN}/dashboard?success=true`,
            cancel_url: `${process.env.DOMAIN}/?canceled=true`,
        });

        res.redirect(303, session.url);
    } catch (e) {
        console.error(e);
        res.status(500).send("Erreur Stripe : " + e.message);
    }
});

// --- ROUTE ANNULATION ABONNEMENT ---
app.post('/create-portal-session', isAuthenticated, async (req, res) => {
    try {
        const user = await Closer.findById(req.session.user.id);

        if (!user.stripeCustomerId) {
            return res.redirect('/dashboard');
        }

        // On génère l'URL du portail Stripe
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: user.stripeCustomerId,
            return_url: `${process.env.DOMAIN}/dashboard`, // Où il revient après avoir géré son abo
        });

        // On redirige l'utilisateur vers Stripe
        res.redirect(portalSession.url);
    } catch (e) {
        console.error("Erreur portail:", e);
        res.status(500).send("Erreur accès portail : " + e.message);
    }
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

// ============================================================
// SYSTEME D'OFFRES D'EMPLOI (JOB BOARD)
// ============================================================

// 1. PAGE TOUTES LES OFFRES (Pour les Closers)
app.get('/offres', async (req, res) => {
    // On récupère toutes les offres, triées par date (récentes en premier)
    const offers = await Offer.find().sort({ createdAt: -1 });
    res.render('offres', { offers, user: req.session.user || null });
});

// 2. POSTULER A UNE OFFRE (Action Closer)
app.post('/offres/apply/:id', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'closer') return res.redirect('/offres');

    try {
        // On ajoute l'ID du closer dans la liste des candidats (si pas déjà dedans)
        await Offer.findByIdAndUpdate(req.params.id, {
            $addToSet: { applicants: req.session.user.id }
        });
        res.redirect('/offres?success=applied');
    } catch (e) {
        console.error(e);
        res.redirect('/offres?error=true');
    }
});

// 3. DASHBOARD ENTREPRISE (Poster & Gérer)
app.get('/company/dashboard', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'company') return res.redirect('/');
    
    // On récupère uniquement les offres de CETTE entreprise
    const myOffers = await Offer.find({ companyId: req.session.user.id }).sort({ createdAt: -1 });
    
    res.render('company-dashboard', { myOffers, user: req.session.user });
});

// 4. CREER UNE OFFRE (Action Entreprise)
app.post('/company/create-offer', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'company') return res.redirect('/');

    try {
        await Offer.create({
            companyId: req.session.user.id,
            companyName: req.session.user.name,
            ...req.body
        });
        res.redirect('/company/dashboard?success=created');
    } catch (e) {
        console.error(e);
        res.redirect('/company/dashboard?error=true');
    }
});

// 5. VOIR LES CANDIDATS D'UNE OFFRE (Action Entreprise)
app.get('/company/offer/:id/candidats', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'company') return res.redirect('/');

    try {
        // On cherche l'offre et on "populate" (remplit) les infos des candidats
        const offer = await Offer.findOne({ _id: req.params.id, companyId: req.session.user.id })
            .populate('applicants'); // Magie Mongoose : récupère les objets Closer entiers

        if (!offer) return res.redirect('/company/dashboard');

        res.render('company-candidats', { offer, candidats: offer.applicants });
    } catch (e) {
        console.error(e);
        res.redirect('/company/dashboard');
    }
});

// 6. SUPPRIMER UNE OFFRE
app.post('/company/delete-offer/:id', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'company') return res.redirect('/');
    await Offer.findOneAndDelete({ _id: req.params.id, companyId: req.session.user.id });
    res.redirect('/company/dashboard');
});

// 5. LOGIN
app.get('/login', (req, res) => {
    // On affiche la page avec aucune erreur par défaut
    res.render('auth/login', { error: null });
});
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        // On cherche d'abord dans les entreprises
        let user = await Company.findOne({ email });
        let role = 'company';

        // Si pas trouvé, on cherche dans les closeurs
        if (!user) {
            user = await Closer.findOne({ email });
            role = 'closer';
        }

        // Vérification du mot de passe
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.user = { 
                id: user._id, 
                role: role, 
                name: user.prenom || user.companyName, 
                isPremium: user.isPremium 
            };
            
            if(role === 'closer') return res.redirect('/dashboard');
            return res.redirect('/');
        }

        // SI ECHEC : On recharge la page avec le message d'erreur
        return res.render('auth/login', { error: 'Email ou mot de passe incorrect.' });

    } catch (e) {
        console.error(e);
        res.render('auth/login', { error: 'Une erreur technique est survenue.' });
    }
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