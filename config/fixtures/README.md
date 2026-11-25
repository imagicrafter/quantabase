# Config fixtures

Configs that both validators must judge the same way.

- `valid/*.yaml` must be accepted by both.
- `invalid/*.yaml` must be refused by both. The first line of each file says why.

Both test suites run every file here:

- Python: `scripts/knowledge/engine_config_fixtures_test.py`
- TypeScript: `engine/tests/config/fixtures.test.ts`

To add a case, add a file. No test needs to change. If the two suites disagree
about a file, one of the validators is wrong: fix the validator, not the file.

These files are for tests. `config/engine.example.yaml` is the example to copy.
