// Programmes d'exemple proposés au premier lancement.
// Jours : 0 = lundi … 6 = dimanche. Repos en secondes.
// "mode" : "reps" (répétitions), "distance" (km) ou "time" (durée en secondes).
// "ref" pointe vers la clé d'un repère (charge max, VMA…) défini dans "refs".

export const TEMPLATES = [
  {
    key: "muscu",
    name: "Musculation",
    icon: "fa-dumbbell",
    color: "#3B4BDB",
    summary: "Pull, Push, Legs sur 3 jours",
    refs: [
      { key: "dc", label: "Max développé couché", value: 100, unit: "kg" },
      { key: "squat", label: "Max squat", value: 120, unit: "kg" },
      { key: "sdt", label: "Max soulevé de terre", value: 140, unit: "kg" }
    ],
    sessions: [
      {
        name: "Pull",
        days: [0],
        notes: "Dos et biceps.",
        exercises: [
          { name: "Soulevé de terre", sets: 4, reps: "5", pct: 80, ref: "sdt", rest: 180 },
          { name: "Tractions pronation", sets: 4, reps: "8", rest: 120, notes: "Lester si plus de 10 répétitions faciles." },
          { name: "Rowing barre", sets: 3, reps: "10", rest: 90 },
          { name: "Curl haltères", sets: 3, reps: "12", rest: 60 }
        ]
      },
      {
        name: "Push",
        days: [2],
        notes: "Pectoraux, épaules, triceps.",
        exercises: [
          { name: "Développé couché", sets: 3, reps: "10", pct: 80, ref: "dc", rest: 150 },
          { name: "Développé militaire", sets: 3, reps: "8", rest: 120 },
          { name: "Écarté poulie", sets: 3, reps: "12", rest: 75 },
          { name: "Extensions triceps", sets: 3, reps: "12", rest: 60 }
        ]
      },
      {
        name: "Legs",
        days: [4],
        notes: "Jambes et gainage.",
        exercises: [
          { name: "Squat", sets: 4, reps: "6", pct: 80, ref: "squat", rest: 180 },
          { name: "Presse à cuisses", sets: 3, reps: "12", rest: 120 },
          { name: "Fentes marchées", sets: 3, reps: "10 par jambe", rest: 90 },
          { name: "Mollets debout", sets: 4, reps: "15", rest: 60 }
        ]
      }
    ]
  },
  {
    key: "run",
    name: "Course à pied",
    icon: "fa-person-running",
    color: "#E0364F",
    summary: "Fractionné, seuil et sortie longue",
    refs: [
      { key: "vma", label: "VMA", value: 15, unit: "km/h" }
    ],
    sessions: [
      {
        name: "Fractionné court",
        days: [1],
        notes: "Récupération en trottinant pendant le temps de repos.",
        exercises: [
          { name: "Échauffement", sets: 1, mode: "time", duration: 1200, pct: 65, ref: "vma", rest: 120 },
          { name: "Fractions", sets: 10, mode: "distance", distance: 0.4, pct: 100, ref: "vma", rest: 90 },
          { name: "Retour au calme", sets: 1, mode: "time", duration: 600, pct: 60, ref: "vma" }
        ]
      },
      {
        name: "Seuil",
        days: [3],
        exercises: [
          { name: "Échauffement", sets: 1, mode: "time", duration: 900, pct: 65, ref: "vma", rest: 60 },
          { name: "Blocs au seuil", sets: 3, mode: "distance", distance: 2, pct: 85, ref: "vma", rest: 120 },
          { name: "Retour au calme", sets: 1, mode: "time", duration: 600, pct: 60, ref: "vma" }
        ]
      },
      {
        name: "Sortie longue",
        days: [6],
        notes: "Allure confortable, tu dois pouvoir parler.",
        exercises: [
          { name: "Footing", sets: 1, mode: "distance", distance: 12, pct: 70, ref: "vma" }
        ]
      }
    ]
  }
];
