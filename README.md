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
| 503 "starting" page | instead of a bare 502 while Ghost boots |

**What it does not do: restart Ghost by itself.** The container's lifecycle is FluxOS's. When Ghost
or nginx exits, the container exits and FluxOS restarts it. A version that restarted Ghost on
standby nodes (to refresh their settings cache) killed Ghost mid-migration in testing and left the
database locked; it was removed.

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
| `FLUX_MIGRATION_LOCK_MAX_SECONDS` | 600 |

Newsletters go through Mailgun, which the site owner sets in Ghost Admin; the image needs nothing.

## flux-ghost

```
flux-ghost info                               versions, URL, mail, database, sizes, counts, setupDone
flux-ghost users list
flux-ghost users reset-password <email> [pw]  generated when omitted; also unlocks a locked user
flux-ghost themes list
flux-ghost db size
flux-ghost db export                          -> content/.flux-backups/ghost-db-<time>.sql
flux-ghost db import <path in content>        the uploaded file is moved out of where it landed first
flux-ghost content backup                     -> content/.flux-backups/ghost-content-<time>.tar.gz
flux-ghost backups list
flux-ghost backups delete <file>
```

One JSON document on stdout: `{"ok":true,"data":...}` or `{"ok":false,"error":"..."}` (exit 1).
Backups are on the replicated volume, downloadable through FluxOS's file routes as
`appdata/.flux-backups/<file>`, and never served by Ghost. Dumps use the MariaDB client, the same
one wp-cli uses in `runonflux/wp-nginx`.

## Updates

Ghost cannot update itself in Docker (no in-app updater, and `ghost update` does not apply to an
image). An update is a new image: FluxOS checks every app's tag every six hours and soft-redeploys
onto a new `:latest`, keeping the volume; Ghost runs its migrations at the next start.

## Not included

- Ghost 6 web analytics (needs Tinybird and Ghost's traffic-analytics service).
- ActivityPub uses Ghost's hosted service, which needs the site reachable on public HTTPS.

## Measured (local, Ghost 6.77.0, MySQL 8.3.0 directly, no operator)

- first boot on an empty database ~50-70 s; restart with data ~15 s; ~150 MB RAM idle
- https URL through nginx 200; Ghost directly without the header 301 to https
- stop during the first migration, restart: lock released, initialisation finished, site 200
- SMTP (Mailpit): setup and password-reset mails delivered
- `users reset-password` then sign-in: 201; old password 422
- `db export` -> change -> `db import` -> restart: the exported state is back

**Still to measure on Flux:** Ghost's transactions and migrations through the shared-db operator
(it cannot run off Flux), and failover between nodes.

## Commands

```bash
node --test tests/lib.test.js
docker build --build-arg FLUX_IMAGE_VERSION=$(cat VERSION) -t ghost-flux:local .
```

## Versions

- 1.0.0: Ghost 6.77.0; nginx, default URL, database wait, stale migration lock release, mail
  defaults, `flux-ghost`.
