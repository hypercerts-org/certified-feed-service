import { config as loadDotenv } from 'dotenv'

/** Loads an optional local `.env` file without replacing deployment-provided variables. */
export const loadLocalEnvironment = (path = '.env'): void => {
  loadDotenv({ path, quiet: true })
}
