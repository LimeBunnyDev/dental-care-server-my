# Dental Care — server dev notes

## Run locally

```bash
npm install
npm run dev          # tsx watch, auto-reloads on file save
# server on http://localhost:4000
curl http://localhost:4000/api/health
```

## Build + run production-style

```bash
npm run build        # tsc → dist/
npm start            # node dist/server.js
```

## Smoke tests (curl)

All examples assume `BASE=http://localhost:4000`.

### Register the Super Admin (first time only)

```bash
curl -sX POST $BASE/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"limebunny","email":"you@example.com","password":"supersecret123"}'
```

Response includes `token` and `user`. **Save the token**:

```bash
TOKEN=<paste token here>
```

### Register a regular visitor

```bash
curl -sX POST $BASE/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"password123"}'
```

### Login

```bash
curl -sX POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"supersecret123"}'
```

### Me (who am I + permissions)

```bash
curl -s $BASE/api/auth/me -H "Authorization: Bearer $TOKEN" | jq
```

### List roles and permissions

```bash
curl -s $BASE/api/roles -H "Authorization: Bearer $TOKEN" | jq
```

### Promote a user to Dentist

Get the user's id first:

```bash
curl -s $BASE/api/users -H "Authorization: Bearer $TOKEN" | jq
```

Then assign the role. The Dentist role id is `role_dentist`.

```bash
curl -sX POST $BASE/api/users/<USER_ID>/roles \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"roleId":"role_dentist"}'
```

### List dentists

```bash
curl -s $BASE/api/dentists -H "Authorization: Bearer $TOKEN" | jq
```

### Book an appointment (as the visitor)

Login as alice, grab her token as `ALICE_TOKEN`, then:

```bash
curl -sX POST $BASE/api/appointments \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "dentistId":"<DENTIST_USER_ID>",
    "date":"2026-09-20",
    "time":"10:00",
    "reason":"checkup",
    "notes":"first visit"
  }'
```

### Check availability for a dentist

```bash
curl -s "$BASE/api/availability/<DENTIST_USER_ID>?date=2026-09-20" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Cancel the appointment

```bash
curl -sX DELETE $BASE/api/appointments/<APPOINTMENT_ID> \
  -H "Authorization: Bearer $ALICE_TOKEN"
```

## Common pitfalls

- **`req.params` type errors** — `@types/express@5` types them as `string | string[]`. Use `param(req, 'name')` from `src/lib/http.ts`.
- **CORS errors from Expo web** — make sure `WEB_ORIGIN` in `.env` includes `http://localhost:19006`.
- **Super Admin flag not set** — verify `SUPER_ADMIN_USERNAME` in `.env` matches your **lowercase** username exactly, then log out and log back in (self-healing runs on login).
- **`23505` on register** — username or email already taken (case-insensitive).
- **`23505` on booking** — that dentist slot is already booked. Choose another.