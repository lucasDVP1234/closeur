const mongoose = require('mongoose');

const OfferSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    companyName: String, // On le stocke pour éviter trop de requêtes
    title: { type: String, required: true },
    description: { type: String, required: true },
    
    // Détails de l'offre
    remuneration: String, // Ex: "20% sur CA"
    niche: String, // Ex: "Make Money / B2B"
    missionType: { type: String, enum: ['Mission', 'Long terme'], default: 'Long terme' },
    
    // Les candidats (Tableau d'IDs de closeurs)
    applicants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Closer' }],
    
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Offer', OfferSchema);