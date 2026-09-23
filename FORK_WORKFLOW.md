# Personal fork update workflow

This repository uses two Git remotes:

- `origin`: `git@github.com:shuan722/readest.git` (personal development repository)
- `upstream`: `git@github.com:readest/readest.git` (original Readest project)

Personal changes stay on `origin/main`. Do not reset or force-push `origin/main` to
match the original project, because that would discard the personal changes.

To merge new original-project commits into the personal repository:

```sh
scripts/sync-upstream.sh
```

After reviewing and testing the merged result:

```sh
git push origin main
```

For a one-command fetch, merge, and push:

```sh
scripts/sync-upstream.sh --push
```

If both projects changed the same lines, Git will stop with merge conflicts. Resolve
the marked files, run the relevant tests, then finish with:

```sh
git add <resolved-files>
git commit
git push origin main
```

Avoid rebasing already-pushed personal commits during routine updates. A normal merge
keeps both histories and does not require a force push.
