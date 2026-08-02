# Vérification automatique des paiements Wave — 100% gratuit, sans serveur dédié

Wave n'offre pas d'API publique pour vos gérants/structures classiques. Ce
robot contourne ce manque : il se connecte au tableau de bord Wave Business
avec un vrai navigateur (Playwright), lit les paiements reçus, et les
signale au serveur Maître de Maison, qui valide automatiquement ceux qui
correspondent à un paiement déclaré par un parent.

Cette version est faite pour tourner via un **cron gratuit** (GitHub
Actions ou Render Cron Job) : chaque exécution repart de zéro, sans disque
persistant — la session Wave connectée est donc gardée **côté serveur**
(en base PostgreSQL), pas sur la machine qui exécute le script.

## Comment le rapprochement automatique fonctionne

1. Dans son espace, chaque famille voit un **code de paiement unique**
   (ex. `MM-4F9A2C`), affiché sur la page "Paiement".
2. Le parent est invité à **indiquer ce code dans le champ note/motif**
   au moment d'envoyer son paiement Wave.
3. À chaque passage, le robot lit les transactions Wave Business et
   transmet au serveur le montant + la note de chacune.
4. Le serveur retrouve le code dans la note, vérifie que le montant
   correspond à un paiement "en attente" de cette famille, et le passe
   automatiquement à "Validé".
5. Si le code est absent ou que le montant ne correspond à rien, la
   transaction reste visible dans **Admin → Paiements → Paiements des
   parents → "Transactions Wave non rapprochées"**, pour un
   rapprochement manuel (comme avant).

Ce mécanisme reste un complément : la déclaration manuelle et la
validation manuelle par l'administration continuent de fonctionner
exactement comme avant.

## Mise en place

### 1. Côté serveur Maître de Maison
Ajoutez une variable d'environnement `MONITOR_TOKEN` (une longue chaîne
aléatoire secrète) sur votre service Railway. C'est le mot de passe
que le robot utilise pour parler au serveur, et pour lire/écrire sa
session Wave en base — personne d'autre ne doit le connaître.
Redéployez le serveur avec les fichiers mis à jour.

### 2. Première connexion à Wave (une seule fois, EN LOCAL)
Sur votre ordinateur (jamais sur le cron, il faut voir la fenêtre) :
```bash
cd wave-monitor
npm install
npx playwright install chromium --with-deps
cp .env.example .env
# → remplissez SERVER_URL et MONITOR_TOKEN dans .env (même valeur que côté serveur)
npm run login
```
Une fenêtre Chrome s'ouvre sur Wave Business. Connectez-vous normalement
(numéro + code SMS). Une fois sur le tableau de bord, revenez au
terminal et appuyez sur Entrée : la session est envoyée et enregistrée
sur le serveur (pas sur votre disque).

### 3. Choisissez votre cron gratuit

#### Option A — GitHub Actions (recommandé, gratuit et fiable)
Un fichier est déjà prêt : `.github/workflows/wave-monitor.yml`, réglé
pour tourner toutes les 5 minutes.

1. Créez un dépôt GitHub (public ou privé — privé fonctionne aussi,
   avec un quota de minutes gratuites largement suffisant pour cet
   usage) et poussez-y le contenu de ce dossier `wave-monitor/`.
2. Dans le dépôt : **Settings → Secrets and variables → Actions →
   New repository secret**, ajoutez :
   - `SERVER_URL` = l'URL de votre serveur Railway
   - `MONITOR_TOKEN` = le même jeton que côté serveur
3. Onglet **Actions** du dépôt : le workflow "Vérification Wave"
   apparaît et se lance automatiquement toutes les 5 minutes. Vous
   pouvez aussi le lancer à la main via "Run workflow" pour tester.

#### Option B — Render Cron Job (tier gratuit)
1. Sur Render : **New → Cron Job**, connectez le même dépôt.
2. Répertoire racine : `wave-monitor`
3. Build Command : `npm install && npx playwright install --with-deps chromium`
4. Command : `node wave-monitor.js`
5. Schedule : `*/5 * * * *` (toutes les 5 minutes — ajustez si besoin)
6. Variables d'environnement : `SERVER_URL`, `MONITOR_TOKEN`

Les deux options reviennent au même résultat ; GitHub Actions est en
général plus simple à surveiller (historique des exécutions, logs,
relance manuelle en un clic).

## Si la session Wave expire

Wave peut déconnecter la session au bout d'un moment (sécurité). Dans
ce cas, le passage suivant du robot échoue avec un message clair dans
les logs ("Session Wave expirée"). Il suffit de refaire l'étape 2
(`npm run login`, en local) pour la renouveler — rien d'autre à
changer.

## ⚠️ À faire avant la mise en production

Les sélecteurs qui lisent la page Wave Business dans `wave-monitor.js`
(fonction `extraireTransactions`) sont des **exemples génériques à
adapter** : je n'ai pas pu inspecter la vraie page Wave Business en
conditions réelles pour écrire ce script. Lancez un premier passage en
local avec `HEADLESS=false node wave-monitor.js` (après avoir enlevé
temporairement le `--login`), ouvrez les outils de développement du
navigateur (clic droit → Inspecter) sur une vraie ligne de transaction,
et ajustez les sélecteurs marqués `// À ADAPTER`, en particulier :
- le sélecteur des lignes de transaction,
- comment distinguer un paiement **reçu** d'un envoi/retrait/recharge,
- où se trouve le montant, la note/motif, et la date dans chaque ligne.

## Sécurité

- `MONITOR_TOKEN` doit être long, aléatoire, et jamais commité dans un
  dépôt public en clair (utilisez toujours les secrets GitHub/Render).
- La session Wave est stockée chiffrée en transit (HTTPS) entre le
  robot et le serveur, et en base PostgreSQL côté serveur — protégez
  l'accès à cette base comme vous protégez déjà vos identifiants Wave.
- Le robot n'a besoin d'aucun autre accès que la lecture de la page des
  transactions Wave Business.
