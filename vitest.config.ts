import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // Tests exercise process-tracker/audit-log directly; avoid writing to the
      // developer's real home directory while running the suite.
      AUDIT_LOG_DISABLED: 'true',
    },
  },
});
