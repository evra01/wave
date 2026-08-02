/*
  wave-monitor.js — Robot de surveillance des paiements Wave Business
  =====================================================================
  Version "cron" : ce script fait UN SEUL passage de vérification puis
  s'arrête. Il est fait pour être relancé périodiquement par un
  planificateur externe et gratuit (GitHub Actions, Render Cron Job…),
  sans avoir besoin de disque persistant ni de rester allumé en
  permanence.

  La session Wave connectée n'est PAS gardée sur le disque de la machine
  qui exécute le script (qui repart de zéro à chaque passage sur un
  cron) : elle est stockée côté serveur Maître de Maison, dans la base
  PostgreSQL, et récupérée/renvoyée à chaque exécution.

  Ce que fait chaque passage :
   1. Récupère la session Wave sauvegardée (GET /api/monitor/session).
   2. Ouvre Wave Business avec Playwright, en utilisant cette session.
   3. Lit les transactions reçues (montant, note/motif, date).
   4. Envoie ces transactions au serveur (POST /api/monitor/transactions-wave),
      qui rapproche automatiquement chaque transaction avec un paiement
      "en attente" via le code MM-XXXXXX indiqué en note par le parent.
   5. Renvoie la session (éventuellement renouvelée par Wave) au serveur
      (POST /api/monitor/session), pour le prochain passage.

  Prérequis :
    npm install
    npx playwright install chromium --with-deps

  Variables d'environnement (fichier .env à côté de ce script, ou
  secrets du planificateur choisi) :
    SERVER_URL       URL du serveur Maître de Maison (ex. https://maitre-de-maison.up.railway.app)
    MONITOR_TOKEN     Doit être identique à la variable MONITOR_TOKEN du serveur
    HEADLESS          "false" uniquement pour le mode --login (def. true)

  Première connexion à Wave (à faire une seule fois, EN LOCAL, sur votre
  ordinateur — jamais sur le cron) :
    HEADLESS=false node wave-monitor.js --login
    → Une fenêtre Chrome s'ouvre sur business.wave.com. Connectez-vous
      normalement (numéro + code reçu par SMS). Une fois sur le tableau
      de bord Wave Business, revenez au terminal et appuyez sur Entrée :
      la session est envoyée et enregistrée sur le serveur.

  Passage manuel de test (comme le fera le cron) :
    node wave-monitor.js

  ⚠️ IMPORTANT — sélecteurs à adapter :
  L'interface web de Wave Business peut changer sans préavis, et je n'ai
  pas pu l'inspecter en direct pour écrire ce script (accès réseau
  restreint depuis l'environnement où il a été généré). Les sélecteurs
  CSS ci-dessous (marqués "À ADAPTER") sont des exemples plausibles à
  vérifier et corriger via l'inspecteur du navigateur (clic droit →
  Inspecter) sur la vraie page des transactions, la première fois.
*/

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile();

const SERVER_URL = (process.env.SERVER_URL || "").replace(/\/+$/, "");
const MONITOR_TOKEN = process.env.MONITOR_TOKEN || "";
const HEADLESS = process.env.HEADLESS !== "false";
const WAVE_LOGIN_URL = "https://business.wave.com/login";
// À ADAPTER : URL réelle de la page listant les transactions reçues.
const WAVE_TRANSACTIONS_URL = "https://business.wave.com/transactions";

if (!SERVER_URL || !MONITOR_TOKEN) {
  console.error("Erreur : SERVER_URL et MONITOR_TOKEN doivent être définis (voir .env.example).");
  process.exit(1);
}

function headers() {
  return { "Content-Type": "application/json", "X-Monitor-Token": MONITOR_TOKEN };
}

async function recupererSession() {
  const res = await fetch(SERVER_URL + "/api/monitor/session", { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Impossible de récupérer la session Wave (HTTP " + res.status + ")");
  return res.json();
}

async function enregistrerSession(storageState) {
  const res = await fetch(SERVER_URL + "/api/monitor/session", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(storageState),
  });
  if (!res.ok) throw new Error("Impossible d'enregistrer la session Wave (HTTP " + res.status + ")");
}

function attendreEntree(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/* Mode --login : à lancer UNE FOIS, en local, avec une fenêtre visible. */
async function modeConnexion() {
  console.log("Ouverture de Wave Business — connectez-vous manuellement dans la fenêtre…");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(WAVE_LOGIN_URL);
  await attendreEntree("Une fois connecté(e) et sur le tableau de bord Wave Business, appuyez sur Entrée ici… ");
  const storageState = await context.storageState();
  await browser.close();
  await enregistrerSession(storageState);
  console.log("Session enregistrée sur le serveur. Le robot peut maintenant tourner via le cron.");
}

/* Lit les transactions visibles sur la page Wave Business.
   À ADAPTER selon le vrai DOM — voir le README pour la marche à suivre. */
async function extraireTransactions(page) {
  return page.evaluate(() => {
    // À ADAPTER : sélecteur des lignes de transactions reçues (crédits).
    const lignes = document.querySelectorAll('[data-testid="transaction-row"], .transaction-row, tr[data-transaction-id]');
    const resultats = [];
    lignes.forEach((ligne) => {
      // À ADAPTER : ne garder que les paiements REÇUS (pas les envois/retraits/recharges).
      const type = (ligne.getAttribute("data-type") || ligne.textContent || "").toLowerCase();
      if (type.includes("envoyé") || type.includes("retrait") || type.includes("recharge")) return;

      const id =
        ligne.getAttribute("data-transaction-id") ||
        ligne.getAttribute("data-id") ||
        ligne.id ||
        null;
      const montantEl = ligne.querySelector('[data-testid="amount"], .amount, .transaction-amount');
      const noteEl = ligne.querySelector('[data-testid="note"], .note, .transaction-note, .description');
      const dateEl = ligne.querySelector('[data-testid="date"], .date, time');

      const montant = montantEl ? montantEl.textContent.trim() : "";
      const note = noteEl ? noteEl.textContent.trim() : "";
      const dateAttr = dateEl ? dateEl.getAttribute("datetime") : null;
      const dateISO = dateAttr || (dateEl ? dateEl.textContent.trim() : "");

      if (!id || !montant) return;
      resultats.push({ id, montant, note, dateISO });
    });
    return resultats;
  });
}

async function envoyerTransactions(transactions) {
  if (!transactions.length) return { valides: 0, nonApparieesAjoutees: 0 };
  const res = await fetch(SERVER_URL + "/api/monitor/transactions-wave", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ transactions }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("Réponse serveur " + res.status + " : " + txt);
  }
  return res.json();
}

/* Un seul passage : session → vérification → envoi → sauvegarde session. */
async function unPassage() {
  const storageState = await recupererSession();
  if (!storageState) {
    console.error("Aucune session Wave enregistrée. Lancez d'abord, en local : HEADLESS=false node wave-monitor.js --login");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  try {
    await page.goto(WAVE_TRANSACTIONS_URL, { waitUntil: "networkidle" });

    if (page.url().includes("/login")) {
      throw new Error("Session Wave expirée — relancez, en local : HEADLESS=false node wave-monitor.js --login");
    }

    const transactions = await extraireTransactions(page);
    const resultat = await envoyerTransactions(transactions);

    // On sauvegarde la session à chaque passage, au cas où Wave l'aurait renouvelée.
    const nouvelEtat = await context.storageState();
    await enregistrerSession(nouvelEtat);

    const horodatage = new Date().toLocaleString("fr-FR");
    console.log(
      "[" + horodatage + "] " + transactions.length + " transaction(s) lue(s) — " +
      (resultat.valides || 0) + " validée(s) automatiquement, " +
      (resultat.nonApparieesAjoutees || 0) + " non rapprochée(s)."
    );
  } finally {
    await browser.close();
  }
}

(async () => {
  try {
    if (process.argv.includes("--login")) {
      await modeConnexion();
    } else {
      await unPassage();
    }
  } catch (e) {
    console.error("Erreur :", e.message);
    process.exit(1);
  }
})();
