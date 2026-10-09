// The same behaviour suite with the official AirConsole library (fetched from www.airconsole.com at run time,
// never bundled) running against the simulated platform. Opt-in, because it needs the internet:
//   AC_PLAYTEST_OFFICIAL=1 npm run test:official
import { describe } from 'node:test';
import { apiSuite } from './support/api-suite.js';

describe('official AirConsole API against the simulated platform', { skip: !process.env.AC_PLAYTEST_OFFICIAL && 'set AC_PLAYTEST_OFFICIAL=1 (needs internet)' }, () => {
  apiSuite('official');
});
