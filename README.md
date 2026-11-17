# ghost-flux

[Ghost](https://ghost.org) for the Flux network: `runonflux/ghost-flux`, the first component of a
three-component app, laid out exactly like WordPress on Flux.

| component | image | containerData | ports (container) |
|---|---|---|---|
| `ghost` | `runonflux/ghost-flux:latest` | `r:/var/lib/ghost/content` | 2368 |
| `mysql` | `mysql:8.3.0` (`--disable-log-bin`) | `/var/lib/mysql` | none |
| `operator` | `runonflux/shared-db:latest` | `s:/app/dumps` | 3307, 7071, 8008 |

Ghost talks only to the operator (`fluxoperator_<app>:3307`); the operator runs the local MySQL,
forwards writes to the cluster master and replicates them. Flux's domain manager sends traffic only
to the master's node for a shared-db app (every other server is HAProxy `backup`), so exactly one
Ghost serves at a time. The content folder (images, media, files, themes) is replicated with `r:`.

The official `ghost:<version>-alpine` image is used unchanged underneath.

## What the image adds, and why

| | Why |
|---|---|
| nginx in front of Ghost (Ghost on 127.0.0.1:2369, nginx on 2368) | Flux's HAProxy terminates TLS and sends no `X-Forwarded-Proto` on HTTPS (only apps named `wordpress*` get one). Ghost redirects every request whose protocol differs from its `url`: measured, it answers `301 -> https://` forever. nginx sets the header to the protocol of Ghost's own URL |
| Default `url` | `https://<appName>.app.runonflux.io`, the app name from FluxOS (`fluxnode.service:16101/hostinfo`). Set `url` for a custom domain |
| Waits for the database | the operator refuses connections until its cluster forms; Ghost exits on its first refused query |
| Releases a stale migration lock | measured: a Ghost stopped during its first migration leaves knex-migrator's lock taken, and no later start boots ("Migration lock was never released"). A lock older than `FLUX_MIGRATION_LOCK_MAX_SECONDS` (600) is released, a younger one is waited out (another node may be migrating). Ghost then finishes a half-done initialisation by itself (measured) |
| Logs to stdout only | the stock config also writes `content/logs`, which is replicated: three nodes appending to it is a sync conflict |
| Mail defaults | Ghost's stock `Direct` transport mails from the node itself: rejected or spam. Without SMTP, `security__staffDeviceVerification` is off, or the owner could not sign in from a new device |
| `flux-ghost` CLI | what the hub's panel runs through FluxOS `appexec`, like wp-cli for WordPress |
| Public port opens only when Ghost answers 200 | FDM checks a non-WordPress app with a bare TCP connect and sends a shared-db app's traffic to the master only. An nginx listening while Ghost boots reads as healthy and serves an error; a closed port fails the check and HAProxy uses a standby. Measured: refused until ready, then 200, never a 5xx |
| Mail is encrypted or not sent | SMTP without `secure` gets `requireTLS`: nodemailer otherwise falls back to clear text, SMTP password included, when a server offers no STARTTLS. Measured against Mailpit: no STARTTLS -> refused, nothing sent; STARTTLS -> delivered. `mail__options__requireTLS=false` is the explicit way out. Port 25 is warned about in the log |

## The node's role

Ghost was not written for several processes on one database: each one caches its settings and
active theme at boot, and runs its own background jobs. On Flux there are three, and only the
shared-db master's node serves (FDM marks the others `backup`). So the supervisor reads this node's
role (FluxOS `hostinfo` address against the local operator's `/status` `masterIP`) and:

| role | background jobs | restarts Ghost when |
|---|---|---|
| `standby` | off (`backgroundJobs__emailAnalytics`, `backgroundJobs__clickTrackingLastSeenAtUpdater`, `emailAnalytics__enabled`): Mailgun is polled once, not three times | what Ghost caches changed (settings, theme settings, theme and routes files): it serves nobody, so it costs nothing, and it is current when promoted |
| `master` | Ghost's defaults / the spec | it was started as a standby (promotion): once, jobs on, fresh cache |
| `unknown` (no answer, no master yet, address shared by several nodes) | Ghost's defaults | never |

The decision is `lib.decide`, unit-tested. Its guards are the lesson of the first version, which
restarted Ghost during its first migration and left the database locked: never before Ghost has
answered 200 since its start, never while the migration lock is held or unreadable, never on a
role seen only once, never within `FLUX_MIN_RESTART_GAP_SECONDS` (120) of the last restart. The
public port is closed during every restart. Measured with a stand-in operator: a standby refreshed
in ~5 s after a settings change, a promotion restarted once with its jobs on, a change made on the
master itself restarted nothing, and settings changed every 2 s during a first migration caused no
restart at all.

Ghost or nginx exiting on their own ends the container: its lifecycle is FluxOS's.

## Configuration (env)

Ghost's own settings, with `__` for nesting (`database__connection__host`). Empty values are unset.

| Variable | Default |
|---|---|
| `url` | `https://<appName>.app.runonflux.io` |
| `database__client` | `mysql` when any `database__connection__*` is set, else SQLite (local only) |
| `database__connection__host` / `__port` | `fluxoperator_<appName>` / `3307` |
| `database__connection__user` / `__database` | `root` / `ghost` |
| `database__connection__password` | **required** (the operator's `DB_INIT_PASS`) |
| `mail__transport`, `mail__from`, `mail__options__host`, `__port`, `__secure`, `__auth__user`, `__auth__pass` | none: mail off. Member sign-in (magic links), staff invites and password resets need it |
| `security__staffDeviceVerification` | `true` with SMTP, `false` without |
| `mail__options__requireTLS` | `true` for SMTP unless `mail__options__secure=true` (465) |
| `FLUX_MIGRATION_LOCK_MAX_SECONDS` | 600 |
| `FLUX_ROLE_WATCH` | `true`; `false` turns the role watch off |
| `FLUX_WATCH_SECONDS` / `FLUX_MIN_RESTART_GAP_SECONDS` | 60 / 120 |
| `FLUX_HOLD_MAX_SECONDS` | 1800: a `hold` ends by itself after this |
| `FLUX_BACKUPS_KEEP` | 5 of each kind (database, content) |

Newsletters go through Mailgun, which the site owner sets in Ghost Admin; the image needs nothing.

## flux-ghost

```
flux-ghost info                               versions, URL, role, mail, database, sizes, counts, setupDone, warnings
flux-ghost status                             the supervisor's state: role, Ghost running/starting/held, port open
flux-ghost restart [reason]                   safe restart (refused while Ghost boots or a migration holds the lock)
flux-ghost hold [reason] / release            stop Ghost and close the port / start it again (a hold expires)
flux-ghost users list
flux-ghost users reset-password <email> [pw]  generated when omitted; also unlocks a locked user
flux-ghost members signup <all|invite|paid|none>   restarts Ghost (settings are cached)
flux-ghost themes list
flux-ghost update check                       running image/Ghost vs the published :latest vs upstream Ghost
flux-ghost db size
flux-ghost db export                          -> content/.flux-backups/ghost-db-<time>.sql
flux-ghost db import <path in content>        moved out of where it landed, Ghost held while importing
flux-ghost content backup                     -> content/.flux-backups/ghost-content-<time>.tar.gz
flux-ghost content restore <backup.tar.gz>    Ghost held; files added since the backup are kept
flux-ghost backups list
flux-ghost backups delete <file>
```

`info.warnings`: `mail-not-configured`, `members-signup-without-mail` (sign-up is open but the
magic link cannot be mailed), `mail-unencrypted-allowed`, `mail-port-25`, `disk-low` (< 1 GB or
< 10 % free). A backup is refused when the volume could not hold it; after one, only the newest
`FLUX_BACKUPS_KEEP` of its kind are kept.

One JSON document on stdout: `{"ok":true,"data":...}` or `{"ok":false,"error":"..."}` (exit 1).
Backups are on the replicated volume, downloadable through FluxOS's file routes as
`appdata/.flux-backups/<file>`, and never served by Ghost. Dumps use the MariaDB client, the same
one wp-cli uses in `runonflux/wp-nginx`.

## Updates

Ghost cannot update itself in Docker (no in-app updater, and `ghost update` does not apply to an
image). An update is a new image: FluxOS checks every app's tag every six hours and soft-redeploys
onto a new `:latest`, keeping the volume; Ghost runs its migrations at the next start.

`.github/workflows/ghost-update.yml` checks the official image every Tuesday and opens a pull
request moving `BASE_IMAGE` to the newest Ghost of the same major version. It never publishes:
merging is the decision, because a new `:latest` restarts every site.

`flux-ghost update check` is what the panel shows: `updateAvailable` when the published `:latest`
is a newer image than the one running (what a redeploy would install), `upstreamAhead` when Ghost
has released something no published image carries yet, with release-note links. It reads Docker
Hub's tag lists: every published image is also tagged `ghost-<version>` (build.yml), which is how
the Ghost inside `:latest` is known. Why no self-update inside the container: FluxOS starts the
image's Ghost at every redeploy, so a container that had upgraded itself would be taken back to an
older Ghost over a database the newer one had migrated, and Ghost refuses that; and three nodes on
one database must change version together.

## Not included

- Ghost 6 web analytics (needs Tinybird and Ghost's traffic-analytics service).
- ActivityPub uses Ghost's hosted service, which needs the site reachable on public HTTPS.

## Measured (local, Ghost 6.77.0, MySQL 8.3.0 directly, no operator)

- first boot on an empty database ~50-70 s; restart with data ~15 s; ~150 MB RAM idle
- https URL through nginx 200; Ghost directly without the header 301 to https
- stop during the first migration, restart: lock released, initialisation finished, site 200
- SMTP (Mailpit): setup and password-reset mails delivered over STARTTLS; a server without STARTTLS gets nothing
- public port closed during boot, 200 from the first accepted connection
- `users reset-password` then sign-in: 201; old password 422
- `db export` -> change -> `db import`: port closed while held, then the exported state is served
- `members signup none` clears the `members-signup-without-mail` warning; 3 exports with keep 2 leave the newest 2
- `content restore`, `hold` / `release`, a restart refused while held or while Ghost boots
- path traversal in `backups delete` and `content restore` refused

**Still to measure on Flux:** Ghost's transactions and migrations through the shared-db operator
(it cannot run off Flux), the operator's real `/status` addresses against `hostinfo`'s, and a
failover between nodes.

## Commands

```bash
node --test tests/lib.test.js
docker build --build-arg FLUX_IMAGE_VERSION=$(cat VERSION) -t ghost-flux:local .
```

## Versions

- 1.0.0: Ghost 6.77.0; nginx, default URL, database wait, stale migration lock release, mail
  defaults (encrypted or not sent), public port opens when Ghost answers, role-aware background
  jobs and standby refresh, `flux-ghost` with held imports and restores, backup retention.
