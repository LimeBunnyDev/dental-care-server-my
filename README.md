# DentalCare Server

REST API for the DentalCare mobile app. Stores user accounts, the dentist roster, and appointments in PostgreSQL.

## TL;DR

```bash
docker compose up --build -d
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed
curl http://localhost:4000/api/health
```

## Where is data stored?

PostgreSQL data lives in a named Docker volume called `dental_pg_data`. To find it on your host:

```bash
docker volume inspect dental_pg_data
# look for "Mountpoint"
```

On a Linux host, the actual files are typically under `/var/lib/docker/volumes/dental_pg_data/_data/`.

## Day-to-day ops

| Action                   | Command                                                      |
| ------------------------ | ------------------------------------------------------------ |
| Start everything         | `docker compose up --build -d`                                |
| View live logs           | `docker compose logs -f api`                                 |
| Stop (keep data)         | `docker compose down`                                        |
| Stop and delete DB       | `docker compose down -v`                                     |
| Run migrations           | `docker compose exec api npm run db:migrate`                 |
| Re-seed dentists         | `docker compose exec api npm run db:seed`                    |
| Wipe all data            | `docker compose exec api npm run db:reset` (then re-migrate) |
| Open Postgres shell      | `docker compose exec db psql -U dental -d dental_care`       |
| List tables              | `\\dt` inside the psql shell                                |
| List users               | `SELECT id, name, email, role, created_at FROM users;`       |

## Backup & restore

```bash
# Logical backup (recommended) — exports the DB as plain SQL.
docker compose exec db pg_dump -U dental -d dental_care > backup-$(date +%F).sql

# Restore
cat backup-2026-06-19.sql | docker compose exec -T db psql -U dental -d dental_care
```

## API endpoints

| Method | Path                       | Purpose                                |
| ------ | -------------------------- | -------------------------------------- |
| GET    | `/api/health`              | Liveness probe                         |
| POST   | `/api/users`               | Create or upsert a user                |
| GET    | `/api/users`               | List all users (debug — gate for prod) |
| GET    | `/api/users/:id`           | Read one user                          |
| PATCH  | `/api/users/:id`           | Update profile fields                  |
| DELETE | `/api/users/:id`           | Delete user (cascades appointments)    |
| GET    | `/api/dentists`            | List the dentist roster                |
| GET    | `/api/dentists/:id`        | Read one dentist                       |
| POST   | `/api/appointments`        | Book an appointment                    |
| GET    | `/api/appointments`        | List (`?userId=`, `?date=` filters)    |
| GET    | `/api/appointments/:id`    | Read one                               |
| PATCH  | `/api/appointments/:id`    | Update date/time/status                |
| DELETE | `/api/appointments/:id`    | Soft-cancel (sets status=cancelled)    |

Try it from the host:

```bash
curl -X POST http://localhost:4000/api/users \
  -H 'content-type: application/json' \
  -d '{
    "id":"u_demo",
    "name":"Jane Doe",
    "email":"jane@example.com",
    "phone":"(+60) 12 382 8265",
    "nric":"950210-10-6399",
    "address":{"line1":"42 Jalan Bukit Bintang","city":"Kuala Lumpur","postcode":"50450","state":"Wilayah Persekutuan (KL)"},
    "emergencyContact":{"name":"John Doe","phone":"(+60) 12 111 2222"},
    "passwordHash":"placeholder",
    "role":"patient",
    "createdAt":"2026-06-19T09:00:00Z"
  }'

curl http://localhost:4000/api/users | jq
```

## Running without Docker

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

## Pointing the mobile app at this server

In the mobile project root:

```bash
EXPO_PUBLIC_API_URL=http://localhost:4000 npm run web
```

Or create a `.env` (Expo reads it):

```
EXPO_PUBLIC_API_URL=http://localhost:4000
```

When that env var is set, the app's auth context will mirror sign-ups and profile updates to the server. The "Database sync" row in the app's Profile → Preferences shows **Live** when the env var is set, **Local** otherwise.

## Schema

```
users(id, name, email, phone, nric,
      address_line1, address_line2, city, postcode, state,
      ec_name, ec_phone, ec_relationship,
      password_hash, role, created_at)

dentists(id, name, title, specialty, bio, initials, accent_color)

appointments(id, user_id→users, dentist_id→dentists,
             date, time, reason, notes, status, created_at)

availability_overrides(dentist_id→dentists, date, slots JSONB,
                       PRIMARY KEY (dentist_id, date))
```

All migrations are idempotent (`CREATE TABLE IF NOT EXISTS`). Running `db:migrate` twice is safe.

## Troubleshooting

- **ECONNREFUSED 127.0.0.1:5432** — Postgres isn't up yet. Wait ~5 s and retry, or check `docker compose logs db`.
- **password authentication failed for user "dental"** — DB was initialised with different creds. Wipe with `docker compose down -v`.
- **API container exits immediately** — Run `docker compose logs api`. Common cause: missing/wrong `DATABASE_URL`.
- **Mobile app shows "Local" badge even after setting EXPO_PUBLIC_API_URL** — Restart the dev server. Vite-style hot reload doesn't pick up env changes for the web bundle.
