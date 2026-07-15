# PulseChat — Phase 1 (Modular Monolith)

Phase 1 of the PulseChat distributed chat platform: a single NestJS app that
already separates concerns into modules the way you'd later split into
microservices (Auth, Users, Chat, Presence), backed by PostgreSQL (via Prisma)
and Redis.

## What's included

- **Auth**: register / login / refresh / logout with JWT access + refresh
  tokens. Refresh tokens are hashed and stored in Postgres so they can be
  revoked and rotated on every refresh (rotation = if a stolen refresh token
  is replayed after the legitimate client already rotated it, it's rejected).
- **Users**: lookup + search (for starting new DMs/groups).
- **Chat**: Socket.IO gateway (`/chat` namespace) for real-time messaging,
  typing indicators, read receipts, and offline sync. REST endpoints for
  initial page load (channel list, paginated message history).
- **Presence**: Redis-backed, TTL-based status (`online`, `idle`, `busy`,
  `invisible`, `offline`) with heartbeat to keep a connection "alive".

## Project layout

```
src/
  auth/         # JWT auth: controller, service, strategy, guards
  users/        # user lookup/search
  chat/         # gateway (websocket) + service (persistence) + REST controller
  presence/     # redis-backed presence tracking
  prisma/       # PrismaService (DB client) as a global module
  redis/        # RedisService (ioredis client) as a global module
  config/       # typed config loader from env vars
prisma/
  schema.prisma # User, RefreshToken, Channel, ChannelMember, Message
```

## Getting started

1. **Start infra** (Postgres + Redis):
   ```bash
   docker compose up -d
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure env**:
   ```bash
   cp .env.example .env
   # edit JWT secrets etc. if you want
   ```

4. **Run migrations**:
   ```bash
   npx prisma migrate dev --name init
   ```

5. **Start the server**:
   ```bash
   npm run start:dev
   ```

   Server boots on `http://localhost:4000`.

## REST endpoints

| Method | Path                        | Auth | Description                  |
|--------|-----------------------------|------|-------------------------------|
| POST   | /auth/register              | no   | Create account, get tokens    |
| POST   | /auth/login                 | no   | Get tokens                    |
| POST   | /auth/refresh                | no   | Rotate refresh token          |
| POST   | /auth/logout                 | yes  | Revoke refresh token          |
| GET    | /auth/me                     | yes  | Current user                  |
| GET    | /users/search?q=             | yes  | Search users by name/email    |
| GET    | /users/:id                   | yes  | Get a user                    |
| GET    | /channels                    | yes  | List my channels              |
| GET    | /channels/:id/messages       | yes  | Paginated message history     |

## WebSocket (`/chat` namespace)

Connect with the access token in the handshake:

```js
const socket = io('http://localhost:4000/chat', {
  auth: { token: accessToken },
});
```

Client → server events: `channel:create`, `channel:join`, `message:send`,
`message:typing`, `message:read`, `presence:set`, `heartbeat`, `sync`.

Server → client events: `channel:created`, `message:new`, `message:typing`,
`message:read`, `presence:update`, `error`.

## Where the "distributed systems" story picks up in Phase 2/3

Every module here is already isolated behind its own service + module
boundary on purpose. When you're ready:

- `ChatGateway`'s `message:send` handler becomes a Kafka **producer** instead
  of writing directly to Postgres.
- A new **Notification** and **Analytics** service become Kafka **consumers**
  of that same topic.
- `PresenceService` already talks to Redis exclusively — swapping local
  Socket.IO broadcast for Redis Pub/Sub (so presence works across multiple
  gateway instances behind a load balancer) is a contained change inside that
  one file.
- Postgres tables (`Message`, `Channel`, `ChannelMember`) stay as the system
  of record; a separate read-optimized store can be added later for CQRS.

## Next up

Once this is running end-to-end (register → login → connect socket → send/
receive messages → presence updates), Phase 2 is: extract Notifications as a
separate service, introduce Kafka as the event bus, and move presence
broadcast from in-process `this.server.emit` to Redis Pub/Sub so it works
across multiple backend instances.
