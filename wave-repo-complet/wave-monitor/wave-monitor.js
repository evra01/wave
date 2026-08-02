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
      "en attente" via le numéro de téléphone de l'expéditeur, repéré dans
      la description automatique Wave (pas de champ note/motif libre sur
      cette interface).
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
// URL de la page listant les transactions reçues (validée : le robot y accède sans erreur).
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
    // Vrai DOM Wave Business (tableau Material UI) : chaque ligne de transaction
    // est un <tr> dans <tbody>, avec 4 colonnes utiles dans l'ordre :
    // Date | Description | Montant | Identifiant de transaction.
    const lignes = document.querySelectorAll("tbody.MuiTableBody-root tr");
    const resultats = [];

    lignes.forEach((ligne) => {
      const cells = ligne.querySelectorAll("td");
      if (cells.length < 4) return;

      const dateTexte = cells[0].textContent.trim(); // ex. "02/08/2026 10:42"
      const description = cells[1].textContent.trim(); // ex. "Reçu de Aka Jacques 07 07 00 5219 par Diomandé Kilian"
      const montantTexte = cells[2].textContent.trim(); // ex. "3.300F" (reçu) ou "-3.300F" (envoyé/payé)
      const id = cells[3].textContent.trim(); // ex. "T_BLAMABB4PNHRGBOB"

      // On ne garde que les paiements REÇUS : le montant ne commence pas par "-".
      if (!montantTexte || montantTexte.trim().startsWith("-")) return;
      if (!id) return;

      // "02/08/2026 10:42" → ISO (JJ/MM/AAAA HH:mm)
      let dateISO = dateTexte;
      const m = dateTexte.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
      if (m) dateISO = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`;

      // Le tableau n'affiche pas de champ "note/motif" libre — Wave ne génère
      // ici qu'une description automatique (nom/numéro de l'expéditeur), sans
      // texte saisi par le payeur. Le code MM-XXXXXX ne peut donc pas être lu
      // depuis cette liste ; on transmet quand même la description, au cas où
      // le serveur y retrouverait un code (peu probable), et pour affichage
      // en cas de rapprochement manuel.
      resultats.push({ id, montant: montantTexte, note: description, dateISO });
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
