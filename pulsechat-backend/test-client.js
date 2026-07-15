/**
 * Quick smoke test for the PulseChat WebSocket gateway.
 *
 * Usage:
 *   node test-client.js
 *
 * What it does:
 *   1. Registers/logs in two users (Alice and Bob) via the REST API.
 *   2. Connects both to the /chat WebSocket namespace.
 *   3. Alice creates a direct channel with Bob.
 *   4. Alice sends a message; we confirm Bob receives it in real time.
 *   5. Bob marks it read; we confirm Alice sees the read receipt.
 *   6. Prints presence updates as they happen.
 */

const { io } = require('socket.io-client');

const API_URL = 'http://localhost:4000';
const WS_URL = 'http://localhost:4000/chat';

async function registerOrLogin(email, username, password) {
  const registerRes = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password }),
  });

  if (registerRes.ok) {
    return registerRes.json();
  }

  // Already exists -> log in instead.
  const loginRes = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    throw new Error(`Failed to register or login ${email}: ${await loginRes.text()}`);
  }

  return loginRes.json();
}

function connectSocket(name, token) {
  const socket = io(WS_URL, { auth: { token } });

  socket.on('connect', () => console.log(`[${name}] connected (${socket.id})`));
  socket.on('error', (err) => console.log(`[${name}] error:`, err));
  socket.on('disconnect', (reason) => console.log(`[${name}] disconnected: ${reason}`));
  socket.on('presence:update', (p) => console.log(`[${name}] presence update:`, p));
  socket.on('message:new', (m) => console.log(`[${name}] new message:`, m.content, 'from', m.sender.username));
  socket.on('message:typing', (t) => console.log(`[${name}] typing event:`, t));
  socket.on('message:read', (r) => console.log(`[${name}] read receipt:`, r));
  socket.on('channel:created', (c) => console.log(`[${name}] channel created:`, c.id));

  return socket;
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('--- Registering/logging in test users ---');
  const alice = await registerOrLogin('alice@test.com', 'alice', 'password123');
  const bob = await registerOrLogin('bob@test.com', 'bob', 'password123');
  console.log('Alice:', alice.user.id);
  console.log('Bob:', bob.user.id);

  console.log('\n--- Connecting sockets ---');
  const aliceSocket = connectSocket('Alice', alice.accessToken);
  const bobSocket = connectSocket('Bob', bob.accessToken);

  await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect')]);
  await sleep(500); // let presence broadcasts settle

  console.log('\n--- Alice creates a DM channel with Bob ---');
  const channel = await aliceSocket.emitWithAck('channel:create', {
    memberIds: [bob.user.id],
  });
  console.log('Channel:', channel.id, `(type: ${channel.type})`);

  await sleep(300); // give Bob's socket time to auto-join the room server-side

  console.log('\n--- Alice sends a typing indicator, then a message ---');
  aliceSocket.emit('message:typing', { channelId: channel.id, isTyping: true });
  await sleep(300);

  const message = await aliceSocket.emitWithAck('message:send', {
    channelId: channel.id,
    content: 'Hey Bob, this is a real-time test message!',
  });
  console.log('Message saved with id:', message.id, 'status:', message.status);

  await sleep(500);

  console.log('\n--- Bob marks the channel as read ---');
  await bobSocket.emitWithAck('message:read', { channelId: channel.id });

  await sleep(500);

  console.log('\n--- Done. Closing sockets. ---');
  aliceSocket.close();
  bobSocket.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});