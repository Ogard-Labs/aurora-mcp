import { runLiveSmoke, smokeFailureSummary } from './auroracloudLiveSmokeCore.js'

runLiveSmoke().catch((error) => {
  // Never the raw error: the logs are public and the drift job publishes this line.
  console.error(smokeFailureSummary(error))
  process.exit(1)
})
