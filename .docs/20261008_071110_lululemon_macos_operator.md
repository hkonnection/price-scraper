# Lululemon collection on macOS

## Scope and safety

Use a normal logged-in user on the Intel MacBook. Use ordinary visible Google Chrome. This job has no AI model, agent service or GitHub runner.

The command calls `scraper/src/lululemon-index.js`. The scraper owns URL selection, parsing, pagination and D1 publication. Merge the separate sale-navigation repair before the Intel test. That repair uses the Canadian homepage sale link selected for the unfiltered We Made Too Much collection. This command does not replace or copy that logic.

This change does not remove the GitHub calendar. Keep its manual dispatch available. Remove only the Lululemon GitHub calendar in a separate change after the Intel no-write test succeeds. Do not activate timed publication before that removal reaches main. Never run GitHub manual dispatch while a local publication is active.

The local lock covers only this command and its setup operation on this user's Mac. It does not serialize GitHub, another computer or direct entrypoint calls. Use this command for all manual local runs.

## Check the target before installation

1. Confirm the Intel CPU, macOS version and supported Node version. The development tests are not Intel hardware proof.
2. Use a durable checkout on a private local path. Do not use a disposable worktree for an installed job. Run `npm ci` in that checkout.
3. Install ordinary Google Chrome at `/Applications/Google Chrome.app`. Its executable path contains spaces. The scraper uses Playwright's normal `chrome` channel. No executable override or browser masking is added.
4. Confirm a logged-in Aqua desktop is available. A logged-out user cannot run this visible-browser job. No system daemon is installed.
5. Check the system timezone in System Settings. Setup requires `America/Los_Angeles`. A process `TZ` value does not set the launchd calendar zone. Setup reports other zones and does not change the system configuration. Do not treat `America/Vancouver` as an automatic substitute.
6. Check sleep and power settings. A sleeping machine does not run at exactly 08:00. launchd can coalesce missed calendar events and run after wake. This job does not wake the Mac or log a user in.
7. The operator must select a private credential file outside the checkout before publication. Supply a D1-only token with the account and database IDs. No credential is needed for no-write collection.
8. Before timed publication, confirm the GitHub calendar is removed in main and no manual GitHub or other writer is running. A deployment check is not proof of retailer access, Intel scheduling or publication.

## Safe no-write command

From the durable checkout, run either command:

```sh
node scraper/local/lululemon-macos.mjs
node scraper/local/lululemon-macos.mjs run --dry-run
```

Both commands force `LULULEMON_VISIBLE_CHROME=1` and pass `--dry-run` to the existing entrypoint. They do not read a credential file. They discard inherited Cloudflare values, Node preload settings, dotenv settings and browser overrides in the child environment. The current Lululemon import graph does not load dotenv.

A refused request, empty result or child failure exits nonzero. The child exit code is preserved. A signal or spawn failure returns 1. There is no refusal retry. A successful test must report a positive cleaned count from the real retailer, not a synthetic fixture count.

No live catalog probe was made for this change. Offline tests use a copied actual entrypoint and scraper with a synthetic browser and publisher. They deny network access. Their counts are not retailer evidence. Run the real Intel no-write test after merge, without credentials, before enabling publication.

## Private credential file

The operator supplies the file and its values later. Do not put values in a command, plist, checkout or report. Do not source the file as shell code.

The file must contain exactly these three unquoted assignments, with the operator's values after each equals sign:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_D1_DATABASE_ID`

Blank lines and full-line comments are allowed. Export syntax, quotes, duplicate keys, extra keys, multiline values, shell substitutions and incomplete values are rejected. The account ID must be 32 hexadecimal characters. The database ID must have UUID format. The token must contain 40 to 200 letters, digits, underscores or hyphens.

Use an absolute normalized path. The file must be owned by the current user, have mode 600 and have only one hard link. Its parents must not permit group or other writes. Symlink files and symlink parent paths are rejected. Files inside this checkout are rejected. Setup and collection also check macOS ACLs. Extended allow entries on the file or its parents are refused. Deny entries are allowed. Select a private path if extended access cannot be verified.

The file's three selected values are the only Cloudflare values supplied to the child. Output is buffered by stream, then those values are redacted before any output reaches the terminal or log. Logs appear after the child finishes, except for the initial run record. The source must not print parts or alternate encodings of credentials.

## Explicit manual publication

Use this only after the real no-write test passes and all other publication writers are idle:

```sh
node scraper/local/lululemon-macos.mjs run --publish \
  --credentials "$HOME/.config/price-scraper/cloudflare.env"
```

The path is an example location, not a file created by setup. The command does not create, copy or provision credentials. No credential value is passed in argv. Manual publication is separate from no-write execution. It can change Lululemon deals in D1.

## Preview and install the calendar job

Preview is the default. It writes no files, calls no launchctl command and collects no catalog:

```sh
node scraper/local/lululemon-macos.mjs setup
```

After the target checks pass, install a no-write calendar job:

```sh
node scraper/local/lululemon-macos.mjs setup --install
```

The calendar uses weekday 1 and 4, hour 8 and minute 0 in the system's Pacific civil timezone. This gives Monday and Thursday 08:00 across Pacific DST changes. It does not use fixed UTC offsets or `StartInterval`.

Setup records the resolved absolute Node executable and script paths in separate plist arguments. Paths with spaces do not pass through a shell. The plist is installed at:

```text
~/Library/LaunchAgents/com.price-scraper.lululemon.plist
```

Setup targets only `gui/<current uid>/com.price-scraper.lululemon`. It never uses a privileged domain. It does not use `RunAtLoad`, `KeepAlive`, `kickstart`, `kill` or `stop`. Setup does not invoke collection. If a calendar event arrives during setup, the shared lock refuses the consumer instead of allowing publication.

Repeat installation is safe. Matching loaded configuration is not reloaded. An unloaded matching configuration is loaded. A candidate is syntax-checked before the prior job is removed. The prior plist remains in place until the new bootstrap succeeds. On replacement failure, setup restores the previous loaded state when safe and reports failure. It does not kill an active job. A partial replacement can be retried with the same command after its prerequisites are fixed.

## Activate timed publication later

Do not execute this step during development or before the separate Intel no-write proof and GitHub calendar removal.

From an updated durable checkout whose Lululemon workflow has no calendar, the authorized operator can replace the no-write job:

```sh
node scraper/local/lululemon-macos.mjs setup --install --publish \
  --credentials "$HOME/.config/price-scraper/cloudflare.env" \
  --github-schedule-off
```

The flag confirms the deployed GitHub calendar is off. Setup also checks the local workflow for a `schedule` key. It does not contact GitHub or disable a workflow. The operator must confirm the deployed state. Setup only changes the timed mode. It does not publish during installation.

To return to a no-write calendar, run `setup --install` without publication flags. Wait for any active collection first. A Git revert does not remove an already installed local LaunchAgent and cannot reverse published data. Unload only this inactive label with `launchctl bootout "gui/$(id -u)/com.price-scraper.lululemon"`, then remove only its plist if the local job must be retired.

## Logs and safe recovery

Local state lives outside the checkout:

```text
~/Library/Application Support/price-scraper/lululemon/run.log
~/Library/Application Support/price-scraper/lululemon/launcher.log
~/Library/Application Support/price-scraper/lululemon/run.lock/
```

The state directory and lock use mode 700. Log files use mode 600. Unsafe existing destinations are refused, not overwritten. Monitor log size and disk space. Retention is an operator task.

If the publisher or setup is busy, wait for completion and retry. No process is killed. A crash can leave the empty lock directory in place. Confirm that the local Node and Chrome run has ended before removing only that empty `run.lock` with `rmdir`. Do not automatically steal or delete a busy lock. A calendar event refused by the lock is not retried by this command.

If replacement validation or a dependency check fails, fix the reported prerequisite and rerun setup. The previous plist is kept. If rollback cannot safely restore a loaded service, setup returns nonzero and reports the recovery limit. Do not remove unrelated agents or manually publish to test setup.

## Offline validation

Run all existing scraper tests and the local operator tests:

```sh
node --experimental-vm-modules --test scraper/src/scrapers/*.test.js \
  scraper/src/update-visibility.test.js scraper/local/*.test.mjs
```

The local tests use a synthetic home, fake launchctl and copied scraper modules. No actual LaunchAgent is installed. An optional `LULU_TEST_ARTIFACTS` path preserves synthetic test homes outside the checkout. It is only a test option and does not change production runtime paths.

No Shortcut story is linked to this change. Story branch names and permalink commit rules do not apply. No story ID is invented.
