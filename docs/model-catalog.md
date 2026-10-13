# Keeping the model lists current

ODM reads most model lists live. The setup wizard asks the provider's `/models`
endpoint each time and drops OpenRouter models that do not take tools. What goes
stale is the handful of model IDs written into the code: defaults such as
`OPENROUTER_MODEL`'s fallback, the OpenAI image and speech models, the setup
wizard's `preferred` picks and the Claude agent's model list.

`scripts/check-model-catalogs.mjs` checks those IDs against
[models.dev](https://models.dev), an open database of AI models that records
each model's tool support, release date and whether it is deprecated.

## Run it by hand

```bash
npm run models:check
```

It prints how many hardcoded IDs it found, which are deprecated, and how many
tool-calling models came out in the last 30 days. It changes nothing unless you
pass `--write`.

| Flag | What it does |
| --- | --- |
| `--write` | Drops the IDs that are safe to drop (below) from `src/`. |
| `--issue <file>` | Writes the weekly issue's text. |
| `--pr <file>` | With `--write`, writes the PR description. |
| `--removed <file>` | Writes the dropped IDs, one per line. |
| `--data <file>` | Reads a saved `https://models.dev/api.json` instead of fetching it. |
| `--since-days <n>` | How far back "new models" reaches. Default 30. |

## What it does on its own, and what it leaves to a person

The weekly `model-catalog` workflow (`.github/workflows/model-catalog.yml`,
Mondays and on demand) splits by risk:

- **A PR, for what is safe to drop.** An ID models.dev marks deprecated that
  sits in a one-line `preferred: [...]` list beside a model that is still live.
  Dropping it changes which model is preselected, not whether one is. No other
  kind of list is edited: a `Set` or `z.enum` of model IDs can be an allowlist
  that tables still configured with that model rely on. The PR comes from the
  `model-catalog/drop-deprecated` branch. Checks do not run on a PR a workflow
  opens, so the workflow runs the tests that name a dropped ID itself and puts
  the result in the description.
- **One rolling issue, for the rest.** Labelled `model-catalog` and rewritten
  each run. It lists deprecated IDs the PR leaves alone (a lone default, whose
  replacement is a benchmark question, or an entry in any other list), the new
  tool-calling models per provider, and every hardcoded ID with where it is.

An ID models.dev does not list is never dropped. Absence there can mean a gap in
its data (it lists few speech models) as easily as a retired model, so those are
listed in the issue and left alone. A models.dev answer missing a whole provider
stops the run.

The check only ever deletes an existing ID from a list. Nothing from models.dev
is written into the code. Model IDs and names reach the issue only as code
spans, where GitHub renders no link or mention, and a release date is printed
only if it is a date.

## For the repository's admin

- The PR step needs **Settings > Actions > General > Allow GitHub Actions to
  create and approve pull requests**. Without it the issue still updates and the
  PR step fails with a clear message.
- The schedule runs on `Lebbitheplow/open-dungeon-master` only. A fork can still
  run it from the Actions tab; where Issues are off, the report goes to the
  run's log instead.
- Only the issue the workflow opened is rewritten, never another issue that
  carries the label.

How the PR treats what people do with it:

| You... | Next run |
| --- | --- |
| push or amend a commit on the branch (to fix a test, say) | leaves the branch and PR to you |
| merge the PR | starts fresh if something new is deprecated |
| close it unmerged and keep the branch | opens no PR while the branch is there; the issue still lists what to drop |
| close it unmerged and delete the branch | proposes the drops again |

## What it does not do

It does not decide whether a model is good at running a table. "Supports tools"
in models.dev's data does not mean a model rolls the dice when it should. New
models in the issue are candidates to benchmark, not recommendations.
