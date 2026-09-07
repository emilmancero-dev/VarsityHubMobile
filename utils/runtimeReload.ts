import * as Updates from 'expo-updates';
import { createOtaReloadRequest } from './otaReload';
import { captureBreadcrumb, captureException } from './sentry';

// Every caller shares one latch for the lifetime of this JS runtime, including
// the error boundary, which may be mounted during an update-triggered reload.
export const requestOtaReload = createOtaReloadRequest(
  () => {
    captureBreadcrumb('OTA reload requested', 'app.lifecycle');
    return Updates.reloadAsync();
  },
  error => captureException(error, { tags: { context: 'ota_reload' } })
);
