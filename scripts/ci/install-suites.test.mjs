// The install scripts carry their own suites next to the code they cover. `verify.yml` already runs
// this glob, so registering them here keeps them in CI without a workflow edit. When `verify.yml` can
// be changed, add `scripts/install/*.test.mjs` to that step and delete this file.
import '../install/release-set.test.mjs';
