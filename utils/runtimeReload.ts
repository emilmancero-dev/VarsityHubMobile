import * as Updates from 'expo-updates';
import { createOtaReloadRequest } from './otaReload';
import { captureException } from './sentry';

// Every caller shares one latch for the lifetime of this JS runtime, including
// the error boundary, which may be mounted during an update-triggered reload.
export const requestOtaReload = createOtaReloadRequest(
  () => Updates.reloadAsync(),
  error => captureException(error, { tags: { context: 'ota_reload' } })
);
