(function () {
  const DEFAULT_PROFILE = {
    id: "generic-visible-form",
    name: "Generic visible form",
    description: "Perfil seguro para rellenar formularios visibles sin enviar nada automaticamente.",
    urlIncludes: [],
    stepDelayMs: 250,
    postClickDelayMs: 350,
    steps: [
      {
        type: "fillByLabel",
        labels: ["full name", "nombre completo", "candidate name", "contact name"],
        field: "full_name",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["first name", "nombre"],
        field: "first_name",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["last name", "surname", "apellidos"],
        field: "last_name",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["email", "correo electronico", "correo"],
        field: "email",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["phone", "telefono", "mobile"],
        field: "phone",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["company", "empresa"],
        field: "company",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["role", "puesto", "position", "job title"],
        field: "role",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["website", "web", "site"],
        field: "website",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["portfolio", "portafolio"],
        field: "portfolio",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["linkedin", "linkedin profile"],
        field: "linkedin",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["cv url", "resume url", "curriculum", "resume"],
        field: "cv_url",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["message", "mensaje", "about you", "comments"],
        field: "message",
        optional: true
      }
    ]
  };

  const JOB_APPLICATION_PROFILE = {
    id: "job-application-generic",
    name: "Job application form",
    description: "Ejemplo para candidaturas, formularios de talento o solicitudes con CV.",
    urlIncludes: [],
    stepDelayMs: 220,
    postClickDelayMs: 350,
    steps: [
      {
        type: "clickText",
        texts: ["apply now", "easy apply", "solicitar", "aplicar", "inscribirme"],
        optional: true
      },
      {
        type: "waitForSelector",
        selector: "form",
        optional: true,
        timeoutMs: 3000
      },
      {
        type: "fillByLabel",
        labels: ["full name", "nombre completo", "candidate name"],
        field: "full_name",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["first name", "nombre"],
        field: "first_name",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["last name", "surname", "apellidos"],
        field: "last_name",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["email", "correo electronico", "correo"],
        field: "email",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["phone", "telefono", "mobile"],
        field: "phone",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["location", "ubicacion", "city"],
        field: "location",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["linkedin", "linkedin profile"],
        field: "linkedin",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["portfolio", "website", "personal website", "web personal"],
        field: "portfolio",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["github", "github profile"],
        field: "github",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["current role", "puesto actual", "job title", "desired role"],
        field: "role",
        optional: true
      },
      {
        type: "fillByLabel",
        labels: ["cover letter", "message", "mensaje", "why are you interested", "about you"],
        field: "message",
        optional: true
      },
      {
        type: "showNotice",
        title: "Formulario completado",
        message: "Revisa los datos de {full_name} antes de enviar.",
        tone: "info"
      }
    ]
  };

  const CLICKER_GAME_PROFILE = {
    id: "clicker-game-demo",
    name: "Clicker game demo",
    description: "Ejemplo ludico para demostrar secuencias, esperas y repeticiones.",
    urlIncludes: [
      "clicker-game-demo.html"
    ],
    stepDelayMs: 120,
    postClickDelayMs: 120,
    steps: [
      {
        type: "waitForText",
        texts: ["Mini Clicker Arena", "Start game"],
        timeoutMs: 3000
      },
      {
        type: "clickText",
        texts: ["Start game", "Empezar partida"],
        optional: true
      },
      {
        type: "repeat",
        count: 10,
        steps: [
          {
            type: "clickText",
            texts: ["Collect coin", "Recolectar moneda"]
          }
        ]
      },
      {
        type: "showNotice",
        title: "Juego automatizado",
        message: "La partida de demostracion ha terminado.",
        tone: "info"
      }
    ]
  };

  const FALLBACK_PROFILE = {
    id: "manual-empty-profile",
    name: "Manual empty profile",
    description: "Perfil vacio para construir un flujo paso a paso desde cero.",
    urlIncludes: [],
    stepDelayMs: 300,
    postClickDelayMs: 400,
    steps: []
  };

  const DEFAULT_PROFILES = {
    [DEFAULT_PROFILE.id]: DEFAULT_PROFILE,
    [JOB_APPLICATION_PROFILE.id]: JOB_APPLICATION_PROFILE,
    [CLICKER_GAME_PROFILE.id]: CLICKER_GAME_PROFILE,
    [FALLBACK_PROFILE.id]: FALLBACK_PROFILE
  };

  const PROFILE_ORDER = [
    DEFAULT_PROFILE.id,
    JOB_APPLICATION_PROFILE.id,
    CLICKER_GAME_PROFILE.id,
    FALLBACK_PROFILE.id
  ];

  const defaultsApi = {
    CLICKER_GAME_PROFILE,
    DEFAULT_PROFILE,
    DEFAULT_PROFILES,
    FALLBACK_PROFILE,
    JOB_APPLICATION_PROFILE,
    PROFILE_ORDER
  };

  globalThis.BrowserAgentDefaults = defaultsApi;
})();
