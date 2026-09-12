# 📘 MOBI POS — Guide d'Onboarding & Déploiement Client (Runbook Développeur)

Ce document détaille la procédure pas-à-pas pour intégrer un nouveau client (ou migrer un client existant) sur le système de synchronisation Cloud Turso (libSQL).

---

## 🏢 Architecture & Modèle Économique (Rappels Clés)

- **Modèle Strict Direct Client** : 1 client = 1 compte/organisation Turso dédié = 1 base de données isolée.
- **Aucun serveur mandataire (zéro proxy)** : Le logiciel desktop de caisse communique directement et de manière chiffrée (TLS) avec l'instance Turso du client.
- **Sécurité OS Keychain** : Les identifiants (`URL` + `Token`) sont stockés dans le trousseau sécurisé du système d'exploitation de la caisse (Gestionnaire d'identifiants Windows, Trousseau macOS, Secret Service Linux), jamais en clair.
- **Offline-First Absolu** : En cas de coupure Internet, la caisse continue à 100% de ses capacités (ventes, encaissements, clôtures, SAV, crédits). Les écritures s'accumulent dans la boîte d'envoi (`sync_outbox`) et sont purgées dès reconnexion.
- **Garde-fou Fichiers Lourds (Blob Guardrail)** : Les images base64 ne sont jamais envoyées sur Turso pour préserver le quota gratuit de 9 Go.

---

## 🛠️ Phase 1 : Création du Compte & de la Base Turso (Côté Développeur)

### Étape 1.1 — Création du compte / organisation Turso du client
Chaque client dispose de son propre compte Turso (offre Starter gratuite : **9 Go de stockage**, **1 milliard de lectures/mois**, **25 millions d'écritures/mois**).

Via la CLI Turso ou la console web :
```bash
# Se connecter au compte Turso dédié au client
turso auth login
```

### Étape 1.2 — Création de la base de données dédiée
Créez la base de données dans la région la plus proche du magasin (ex: `fra` pour Francfort ou `mrs` pour Marseille) :
```bash
turso db create mobi-pos-<nom-client> --location mrs
```
*Exemple : `turso db create mobi-pos-elbahdja --location mrs`*

### Étape 1.3 — Récupération de l'URL de connexion
Affichez les informations de la base :
```bash
turso db show mobi-pos-<nom-client>
```
Notez l'URL `URL: libsql://mobi-pos-elbahdja-username.turso.io`.

### Étape 1.4 — Génération du jeton d'authentification persistant
Générez un jeton d'authentification sans expiration (ou à longue durée) pour la caisse du client :
```bash
turso db tokens create mobi-pos-<nom-client>
```
La commande retourne une clé JWT commençant par `eyJhbGciOi...`.

---

## ✉️ Phase 2 : Ce qu'il faut transmettre au Client

Transmettez au gérant de la boutique les deux informations suivantes (par canal sécurisé) :
1. **URL de la base** : `libsql://mobi-pos-<nom-client>-<id>.turso.io`
2. **Jeton d'authentification** : `eyJhbGciOi...`

*(Aucune configuration réseau, aucun port entrant, aucun serveur intermédiaire à déployer dans la boutique).*

---

## 💻 Phase 3 : Activation sur la Caisse (Procédure Magasin)

### Étape 3.1 — Saisie des identifiants
1. Sur le PC de caisse, ouvrez **MOBI POS**.
2. Cliquez sur l'icône **⚙️ Paramètres** en haut à droite.
3. Sélectionnez l'onglet **☁️ Synchronisation Cloud**.
4. Collez l'**URL de la base de données** et le **Jeton d'authentification**.

### Étape 3.2 — Test de validation
5. Cliquez sur **Tester la connexion**.
   - Le système envoie un ping sécurisé et vérifie la latence (ex: *« Connexion validée en 42 ms »*).

### Étape 3.3 — Déclenchement de la Migration Sécurisée
6. Cliquez sur **Enregistrer & Activer Cloud Sync**.
   - **Sauvegarde de précaution automatique** : Le système génère instantanément une copie complète locale de `mobi_pos.db` (`mobi_pos_backup_YYYYMMDD_HHMMSS.db`) ainsi qu'un export JSON.
   - **Initialisation du schéma distant** : Le DDL versionné crée automatiquement les 17 tables distantes si elles n'existent pas encore.
   - **Téléversement par lots (50 items/lot)** : Les produits, ventes, tickets, écritures comptables, réparations et dettes existants sont transférés.
   - **Garde-fou Blob** : Les photos base64 sont automatiquement filtrées pour économiser le stockage.
   - **Contrôle d'intégrité SHA-256** : Le système calcule les empreintes cryptographiques locales et distantes et certifie que **zéro donnée n'est perdue** et **zéro doublon n'a été créé**.
   - **Démarrage des boucles automatiques** : Le moteur de synchronisation en arrière-plan prend le relais.

---

## 🔄 Phase 4 : Remplacement de PC ou Ordinateur Additionnel (Disaster Recovery)

En cas de changement de PC portable ou d'ajout d'une seconde caisse :
1. Installez l'application **MOBI POS** sur le nouveau PC.
2. Allez dans **Paramètres > Synchronisation Cloud**.
3. Renseignez l'URL et le Jeton du client.
4. Cliquez sur **Restaurer depuis le cloud**.
5. Le système télécharge l'intégralité du catalogue, des clients, des dettes et des ventes, recalcule les stocks à partir du grand livre d'inventaire (`inventory_ledger`) et prépare la caisse locale.

---

## 📊 Phase 5 : Surveillance des Quotas & Dépassements

Le panneau de configuration affiche en temps réel la jauge d'utilisation :
- **0 à 70%** : Fonctionnement nominal (jauge verte).
- **70% à 85%** : Jauge ambre. Message conseil d'archivage des vieux historiques.
- **85% à 95%** : Jauge orange vif. Alerte recommandant un archivage ou le passage à l'offre Pro Turso.
- **>= 95%** : Jauge rouge. Blocage préventif des téléversements pour éviter tout surcoût ou blocage Turso ; la caisse continue à vendre et encaisser en mode 100% local.

Pour archiver les journaux ou vérifier les tables les plus consommatrices, cliquez sur **Afficher la répartition détaillée par table**.
