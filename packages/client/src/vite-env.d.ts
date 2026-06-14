/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to '1' at build time to enable the dev tuning overlay in the bundle. */
  readonly VITE_ENABLE_TUNING?: string;
}
