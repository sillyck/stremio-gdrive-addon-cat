// Configuració mínima amb un sol objectiu: detectar referències a funcions o
// variables que no existeixen. Aquest error no el detecta `node --check`
// perquè només es manifesta en executar, i ja ha provocat dues avaries en
// producció en refactoritzar blocs de codi.
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        // Entorn de Cloudflare Workers
        fetch: "readonly", Request: "readonly", Response: "readonly",
        Headers: "readonly", URL: "readonly", URLSearchParams: "readonly",
        caches: "readonly", crypto: "readonly", console: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        TextEncoder: "readonly", TextDecoder: "readonly",
        btoa: "readonly", atob: "readonly", globalThis: "readonly",
        ReadableStream: "readonly", AbortController: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
];
