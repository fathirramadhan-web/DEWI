import { defineDemo } from '../../src/types.ts';
import { allChecks, attribute, visible } from '../../src/ready.ts';

export default defineDemo({
  name: 'sample-app',
  build: {
    command: 'node -e "console.log(\'static sample ready\')"',
    output: 'app',
    forbid: ['https://prod.example.invalid'],
  },
  stage: { width: 1920, height: 1080 },
  clock: {
    anchor: '2026-11-25T09:00:00.000Z',
    timezone: 'UTC',
    locale: 'en-US',
  },
  themes: ['dark'],
  entries: {
    app: {
      path: '/',
      ready: allChecks(
        visible('app-root'),
        attribute('app-root', 'data-loaded', 'true')
      ),
    },
  },
  mock: async () => ({}),
  tour: ['overview'],
});
