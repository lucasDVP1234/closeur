// models/Closer.js
const mongoose = require('mongoose');

const CloserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // NOUVEAU
    nom: String,
    prenom: String,
    email: String,
    telephone: String,
    photoUrl: String, // Lien S3
    age: Number,
    experienceLevel: { type: String, enum: ['Junior', 'Confirmé', 'Expert', 'Killer'] },
    totalClosed: Number, // Montant total closé (€)
    skills: [String], // Ex: B2B, High-Ticket, Immo...
    lastChallenge: String, // Dernier challenge remporté
    awards: String, // "Prix organisés", coupes, etc.
    webinarsHosted: Number, // Nbr de webinaires
    misc: String, // "Vaisselle" ou autre fun fact/hobby
    bio: String,
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Closer', CloserSchema);