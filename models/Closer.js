const mongoose = require('mongoose');

const CloserSchema = new mongoose.Schema({
    // --- 1. IDENTITÉ & ACCÈS ---
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    nom: { type: String, required: true },
    prenom: { type: String, required: true },
    telephone: { type: String, required: true },
    photoUrl: String, // Photo obligatoire

    // --- 2. PROFILAGE ---
    profileType: { 
        type: String, 
        enum: ['Commercial', 'Closeur', 'Setter'], 
        default: 'Closeur' 
    },
    market: { 
        type: String, 
        enum: ['B2B', 'B2C', 'Les deux'],
        default: 'B2C'
    },
    availability: { 
        type: String, 
        enum: ['Full Time', 'Mi-temps'] 
    },
    totalClosed: { type: Number, default: 0 },
    
    // --- 3. COMPÉTENCES & EXPÉRIENCE ---
    yearsExperience: { type: Number, default: 0 },
    productTypes: [String], // Ex: ['Infoproduit', 'SaaS']
    videoUrl: String, // Lien Loom/YouTube
    pastClients: String, // Liste format texte
    
    // --- 4. ATTENTES ---
    contractType: [String], // Ex: ['100% Commission', 'Fixe + Commission']
    desiredIncome: Number, // Rémunération mensuelle souhaitée
    missionType: { 
        type: String, 
        enum: ['Mission (Webi/Challenge)', 'Long terme'] 
    },

    // --- 5. VISION ---
    closingPhilosophy: String, // "Un bon closeur pour vous c'est..."
    isPremium: { type: Boolean, default: false },
    stripeCustomerId: { type: String }, // L'ID du client chez Stripe (cus_xxx)
    stripeSubscriptionId: { type: String },

    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Closer', CloserSchema);