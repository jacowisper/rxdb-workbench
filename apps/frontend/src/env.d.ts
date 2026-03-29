/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN: string;
  readonly VITE_FRONTEND_TO_USE_BACKEND_URL?: string;
  readonly VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT?: string;
  readonly VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING?: string;
  readonly VITE_INTERNAL_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
