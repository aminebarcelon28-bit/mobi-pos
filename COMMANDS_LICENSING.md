# 🔑 MobiPOS — Guide Ultime des Commandes de Licence

Ce document regroupe **toutes les commandes indispensables** pour générer, gérer, mettre à niveau et dépanner les licences de vos clients MobiPOS.

---

## 📋 Table des Commandes Rapides

| Action | Commande | Description |
| :--- | :--- | :--- |
| **Tableau de Bord Visuel (UI)** | `npm run license:ui` | **Ouvre l'interface graphique moderne dans votre navigateur** |
| **Créer une nouvelle licence** | `npm run license:mint` | Assistant interactif en terminal (nom, formule, nb postes) |
| **Voir les postes occupés (Cloud)** | `npm run license:cloud-list` | Affiche en direct combien de PC et téléphones chaque client utilise |
| **Libérer un PC (formatage / changement)** | `npm run license:reset-seats -- --key <CLÉ>` | Détache les anciens PC pour autoriser une nouvelle machine |
| **Ajouter des caisses (Up-sell)** | `npm run license:update-seats -- --key <CLÉ> --desktops 2` | Augmente le quota de caisses ou de mobiles d'un client |
| **Activer ce PC localement** | `npm run license:activate-local -- --key <CLÉ>` | Active immédiatement votre poste de travail sans passer par l'écran |
| **Créer un jeton 100% hors-ligne** | `npm run license:token -- --key <CLÉ>` | Pour un commerce qui n'aura jamais Internet (clé USB) |
| **Synchroniser le registre local vers le Cloud** | `npm run license:sync` | Pousse toutes les licences locales vers le serveur mondial Cloudflare |
| **Vérifier la sécurité cryptographique** | `npm run test:license` | Exécute les 26 tests de validation Ed25519 et anti-piratage |
| **Redéployer le serveur Cloudflare** | `npm run license:deploy` | Met à jour le Cloudflare Worker en production |

---

## 🖥️ 1. Le Tableau de Bord Visuel (Recommandé — Le Plus Simple)

Lancez simplement dans votre terminal :
```powershell
npm run license:ui
```
* Votre navigateur s'ouvre automatiquement sur : `http://localhost:4200`
* Vous y retrouvez :
  * 📊 **Vos indicateurs clés** : Nombre total de clients, caisses PC actives, smartphones connectés, statut du serveur mondial.
  * 🔍 **Recherche instantanée** par nom de client ou clé de licence.
  * ➕ **Bouton « Nouvelle Licence »** : formulaire avec nom, formule (À Vie, 3 mois, 24h) et quotas. Enregistrement direct dans le Cloud.
  * 💬 **Bouton WhatsApp** : Affiche le message de bienvenue avec instructions d'activation et bouton de copie en 1 clic.
  * 🔄 **Bouton « Libérer Postes »** : Déconnecte l'ancien PC en cas de formatage d'un client.
  * ⚙️ **Bouton « Modifier Quotas »** : Pour augmenter le nombre de caisses d'un client.

---

## 🛠️ Détail des Commandes Terminal (CLI)

### 1. Créer une licence pour un nouveau client (Recommandé)
```powershell
npm run license:mint
```
* **Ce qu'il fait :**
  1. Vous demande le **Nom du client** (ex: *Superette El-Amine*).
  2. Vous demande la **Formule** :
     * `[1] LIFETIME` : Illimitée à Vie (sans abonnement).
     * `[2] 90D` : 3 Mois (Trimestriel).
     * `[3] 24H` : Démo d'évaluation (24h).
  3. Vous demande le **Nombre de caisses PC** (Desktop) et de **Smartphones** (Android).
  4. Demande la base Turso (appuyez simplement sur **Entrée** si le client a son propre compte).
  5. **Propulse instantanément la clé sur le Cloud mondial Cloudflare.**
  6. Génère un **message WhatsApp / SMS prêt à être envoyé** au client avec les instructions !

#### Version rapide en une seule ligne :
```powershell
node scripts/license-admin.mjs mint --customer "Superette Central" --type LIFETIME --desktops 2 --mobiles 3
```

---

### 2. Voir qui est connecté et combien de postes sont occupés
```powershell
npm run license:cloud-list
```
* Affiche un tableau en direct depuis vos serveurs Cloudflare :
```text
┌─────────┬───────────────────┬────────────┬────────────────┬──────────────┬──────────┐
│ (index) │ Client            │ Formule    │ Postes Caisses │ Mobiles Sync │ Statut   │
├─────────┼───────────────────┼────────────┼────────────────┼──────────────┼──────────┤
│ 0       │ 'amine'           │ 'LIFETIME' │ '0 / 1'        │ '0 / 1'      │ 'active' │
│ 1       │ 'Superette Central│ 'LIFETIME' │ '1 / 2'        │ '2 / 3'      │ 'active' │
└─────────┴───────────────────┴────────────┴────────────────┴──────────────┴──────────┘
```

---

### 3. Libérer les postes d'un client (En cas de changement ou formatage de PC)
Si un commerçant vous appelle en disant :
> *"J'ai changé mon unité centrale ou j'ai formaté Windows, l'application me dit limite atteinte !"*

Tapez simplement :
```powershell
npm run license:reset-seats -- --key MOBI-LIFE-ZDKS-E0BW
```
* **Résultat :** L'ancien PC est immédiatement détaché dans le Cloud.
* Le client clique sur "Activer" sur son nouveau PC : cela s'active en 1 seconde !

---

### 4. Mettre à niveau un client (Vente de caisses supplémentaires)
Si un client avec 1 seule caisse vous achète une 2ᵉ caisse pour son magasin :
```powershell
npm run license:update-seats -- --key MOBI-LIFE-ZDKS-E0BW --desktops 2
```
* La clé passe à 2 caisses autorisées immédiatement, sans avoir à réinstaller l'application.

---

### 5. Activer votre propre PC de développement instantanément
Pour démarrer directement l'application sur votre propre machine sans devoir taper la clé :
```powershell
npm run license:activate-local -- --key MOBI-LIFE-ZDKS-E0BW
```

---

### 6. Mode Hors-Ligne Total (Sans aucune connexion Internet)
Si une boutique rurale n'a pas de connexion Internet :
1. Sur le PC du client, notez son empreinte matérielle affichée à l'écran (ex: `MOBI-WIN-A1B2-C3D4`).
2. Sur votre ordinateur, tapez :
   ```powershell
   npm run license:token -- --key MOBI-LIFE-ZDKS-E0BW --hwid MOBI-WIN-A1B2-C3D4
   ```
3. Cela vous génère un jeton cryptographique `eyJhbGciOi...` signé en Ed25519.
4. Donnez ce jeton au client (par fichier texte ou WhatsApp) : il le colle dans l'onglet **"Jeton Hors-Ligne"** et l'application se déverrouille à vie sans jamais se connecter à Internet.

---

### 7. Vérifier la santé du système de sécurité
```powershell
npm run test:license
```
Exécute tous les tests unitaires et d'inviolabilité :
* Signature Ed25519 et intégrité des données
* Détection des attaques par falsification de jeton
* Détection du recul d'horloge Windows (Clock Rollback)
* Chiffrement militaire AES-256-GCM des jetons
