import { connect } from 'cloudflare:sockets';

const CONFIG = {
  UUID: 'd2cb8181-233c-4d18-9972-8a1b04db1155',
  PATH: '/persadem',
  RETRY_LIMIT: 3,
  RETRY_DELAY: 500,
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgrade = request.headers.get('Upgrade');

      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }

      if (url.pathname !== CONFIG.PATH || upgrade !== 'websocket') {
        return new Response('OK', { status: 200 });
      }

      return await handleVless(request, ctx);
    } catch (err) {
      return new Response('Internal Error', { status: 500 });
    }
  }
};

async function handleVless(request, ctx) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  ctx.waitUntil(handleStream(server, request));

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'X-Powered-By': 'CF-Worker',
    }
  });
}

async function handleStream(ws, request) {
  let remoteSocket = null;
  let initialized = false;
  let pendingBuffer = [];
  let isClosing = false;

  const safeClose = (code = 1000, reason = 'Done') => {
    if (!isClosing) {
      isClosing = true;
      try { ws.close(code, reason); } catch (_) {}
      try { remoteSocket?.close(); } catch (_) {}
    }
  };

  const writeToRemote = async (socket, data) => {
    try {
      const writer = socket.writable.getWriter();
      await writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
      writer.releaseLock();
      return true;
    } catch (_) {
      return false;
    }
  };

  const connectWithRetry = async (host, port, retries = CONFIG.RETRY_LIMIT) => {
    for (let i = 0; i < retries; i++) {
      try {
        const sock = connect({ hostname: host, port });
        // Test connection
        await Promise.race([
          sock.opened,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        return sock;
      } catch (err) {
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY * (i + 1)));
        }
      }
    }
    return null;
  };

  ws.addEventListener('message', async ({ data }) => {
    if (isClosing) return;

    try {
      const raw = data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer();

      if (!initialized) {
        initialized = true;

        const bytes = new Uint8Array(raw);
        const version = bytes[0];
        const uuid = parseUUID(bytes.slice(1, 17));

        if (uuid.toLowerCase() !== CONFIG.UUID.toLowerCase()) {
          safeClose(1003, 'Forbidden');
          return;
        }

        const optLen = bytes[17];
        const portIdx = 19 + optLen;
        const port = (bytes[portIdx] << 8) | bytes[portIdx + 1];
        const addrType = bytes[portIdx + 2];

        let host = '';
        let addrSize = 0;

        if (addrType === 1) {
          // IPv4
          host = Array.from(bytes.slice(portIdx + 3, portIdx + 7)).join('.');
          addrSize = 4;
        } else if (addrType === 2) {
          // Domain
          addrSize = bytes[portIdx + 3];
          host = new TextDecoder().decode(bytes.slice(portIdx + 4, portIdx + 4 + addrSize));
          addrSize += 1;
        } else if (addrType === 3) {
          // IPv6
          const ipv6Bytes = bytes.slice(portIdx + 3, portIdx + 19);
          host = Array.from({ length: 8 }, (_, i) =>
            ((ipv6Bytes[i * 2] << 8) | ipv6Bytes[i * 2 + 1]).toString(16)
          ).join(':');
          addrSize = 16;
        } else {
          safeClose(1002, 'Invalid address type');
          return;
        }

        const bodyOffset = portIdx + 3 + addrSize;
        const body = raw.slice(bodyOffset);

        // Connect with retry
        remoteSocket = await connectWithRetry(host, port);
        if (!remoteSocket) {
          safeClose(1011, 'Connection failed');
          return;
        }

        // VLESS response
        ws.send(new Uint8Array([version, 0]));

        // Send body
        if (body.byteLength > 0) {
          await writeToRemote(remoteSocket, new Uint8Array(body));
        }

        // Send buffered
        for (const chunk of pendingBuffer) {
          await writeToRemote(remoteSocket, chunk);
        }
        pendingBuffer = [];

        // Remote → Client pipe
        remoteSocket.readable
          .pipeTo(new WritableStream({
            write(chunk) {
              if (!isClosing && ws.readyState === WebSocket.READY_STATE_OPEN) {
                try { ws.send(chunk); } catch (_) { safeClose(1011, 'Send error'); }
              }
            },
            close() { safeClose(1000, 'Remote closed'); },
            abort(err) { safeClose(1011, 'Remote aborted'); }
          }))
          .catch(() => safeClose(1011, 'Pipe error'));

      } else {
        // Forward to remote
        if (remoteSocket) {
          const ok = await writeToRemote(remoteSocket, new Uint8Array(raw));
          if (!ok) safeClose(1011, 'Write failed');
        } else {
          pendingBuffer.push(new Uint8Array(raw));
        }
      }
    } catch (err) {
      safeClose(1011, 'Message error');
    }
  });

  ws.addEventListener('close', () => safeClose(1000, 'Client closed'));
  ws.addEventListener('error', () => safeClose(1011, 'WS error'));
}

function parseUUID(bytes) {
  const h = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}
