# Mes cadences — Carnet de séances

Un carnet d’entraînement personnel, pensé pour le téléphone, qui rappelle les séances de la semaine et accompagne chaque série avec ses charges et ses temps de repos.

## Choisir un sport

- À la première connexion, deux programmes d’exemple sont proposés : **Musculation** (Pull, Push, Legs) et **Course à pied** (fractionné, seuil, sortie longue). On peut aussi créer un sport vide.
- Chaque sport a un nom, une icône et une couleur.
- L’accueil affiche les séances prévues **aujourd’hui**, tous sports confondus, ou la prochaine séance s’il n’y en a pas.

## La semaine d’un sport

- Une barre de cadence montre les jours d’entraînement de la semaine ; un appui sur un jour fait défiler jusqu’à ses séances.
- Les séances sont rangées par jour, du lundi au dimanche. Les jours sans séance affichent « Repos ».
- Une séance peut être prévue plusieurs jours, ou n’avoir aucun jour fixe.

## Mes repères (charges max, VMA…)

Chaque sport a ses repères : charge maximale sur un mouvement, VMA, FTP, etc. Dans un exercice, une intensité en pourcentage est calculée à partir du repère choisi :

- en **kg** : la charge est arrondie au demi-kilo (80 % de 100 kg → 80 kg) ;
- en **km/h** : la vitesse, l’allure au kilomètre et, si la répétition est une distance, le temps à viser (100 % de 15 km/h sur 400 m → 1′36″).

## Le détail d’une séance

Chaque exercice affiche :

- le volume (ex. `3 × 10`, `10 × 400 m`) ;
- l’intensité et la valeur calculée ;
- le champ **Ma charge**, modifiable directement (ex. `82,5 kg` ou `3′55″/km`), enregistré dans le compte ;
- une pastille par série : un appui valide la série et **lance automatiquement le temps de repos** ;
- les consignes et l’image de l’exercice (un appui l’agrandit).

La progression du jour (séries validées) est gardée sur l’appareil et remise à zéro le lendemain.

## Minuteur et chrono

- Accessible depuis l’en-tête à tout moment, ou depuis le bouton de repos d’un exercice.
- **Repos** : compte à rebours avec anneau, pause, ±15 s, et des durées rapides (0:30 à 3:00). Bip et vibration à la fin.
- **Chrono** : démarrage, pause, tours, remise à zéro.
- En fermant le panneau, une pastille flottante garde le temps visible. L’écran reste allumé pendant un décompte (si le navigateur le permet).

## Séance effectuée

- En bas de chaque séance, le bouton **Séance effectuée** enregistre la séance dans l’historique : date, durée, ressenti, note, et pour chaque exercice les séries faites et la charge utilisée.
- La séance du jour est alors marquée « Faite » sur l’accueil, qui indique aussi le nombre de séances effectuées dans la semaine.

## Historique

- Onglet **Historique** : séances de la semaine, du mois et nombre de semaines d’affilée avec au moins une séance.
- Histogramme des séances par semaine sur les 12 dernières semaines.
- Liste des séances par mois, filtrable par sport ; un appui ouvre le détail (et permet de la supprimer).

## Suivi corporel

- Onglet **Suivi** : poids, taille, masse grasse et masse musculaire, avec l’**IMC calculé** automatiquement et sa catégorie.
- Une mesure par jour, modifiable ou supprimable depuis le tableau récapitulatif.
- Graphique d’évolution pour chaque donnée (3 mois, 1 an, tout), avec la zone d’IMC normal.
- Ces données de santé restent dans l’espace privé du compte ; un bouton permet de supprimer toutes ses mesures.

## Évolution des max

- Chaque nouvelle valeur d’un repère (max développé couché, VMA…) est datée et ajoutée à son historique.
- Page **Évolution des max** d’un sport : un graphique et la liste des valeurs par repère, avec l’écart d’une valeur à l’autre. On peut ajouter un max à une date passée.
- Le résumé de tous les max est aussi visible dans l’onglet Suivi.

## Modifier ses séances

- Nom, jours, notes, puis la liste des exercices : séries, répétitions, intensité, repère, repos (`90` ou `1:30`), charge, consignes et image.
- Les exercices se réordonnent avec les flèches.
- Les images sont redimensionnées et compressées sur le téléphone avant l’envoi.

## Compte

- Connexion avec Google. Chaque compte ne voit que ses propres programmes.
- Les données restent consultables hors connexion grâce au cache local de Firestore.

---

## Mise en route Firebase

1. **Authentication** › Méthodes de connexion : activer **Google**.
2. **Firestore Database** : créer la base (mode production).
3. Publier les règles de `firestore.rules` (console Firestore › Règles, ou `firebase deploy --only firestore:rules`).
4. **Authentication** › Paramètres › Domaines autorisés : ajouter le domaine d’hébergement s’il ne s’agit pas de `mes-cadences.web.app` (ex. `monpseudo.github.io`).

### Héberger

Avec Firebase Hosting :

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

Le site est aussi compatible GitHub Pages (fichiers statiques, aucune compilation).

Les images sont stockées dans Firestore (≤ 700 Ko chacune) : Firebase Storage n’est pas nécessaire, ce qui permet de rester sur l’offre gratuite.

## Structure

```
index.html
css/style.css
js/firebase-config.js   configuration et initialisation Firebase
js/app.js               authentification, navigation, vues, éditeurs
js/timer.js             minuteur de repos et chronomètre
js/charts.js            graphiques SVG (courbes et histogrammes)
js/templates.js         programmes d’exemple
firestore.rules         règles d’accès par compte
firebase.json           configuration Firebase Hosting
```

Données Firestore :

```
users/{uid}/sports/{id}     nom, icône, couleur, repères
users/{uid}/sessions/{id}   sportId, nom, jours, notes, exercices
users/{uid}/images/{id}     image compressée d’un exercice
users/{uid}/logs/{id}       séances effectuées (historique)
users/{uid}/measures/{date} mesures corporelles (une par jour)
users/{uid}/maxes/{id}      historique des repères (max, VMA…)
users/{uid}/profile/main    taille
```
