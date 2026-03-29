const userID = 'b3f7a2c1-d4e8-4f90-bc12-8a3d5e6f7b9c';
const proxyIP = 'cdn.xn--b6gac.eu.org';

import { connect } from 'cloudflare:sockets';

export default { fetch: (r, e, c) => r.headers.get('Upgrade') == 'websocket' ? handleWs(r, c) : new Response('OK') };

async function handleWs(request, ctx) {
  const [c, s] = new WebSocketPair();
  s.accept();
  ctx.waitUntil(vlessFlow(s));
  return new Response(null, { status: 101, webSocket: c });
}

async function vlessFlow(ws) {
  let socket = null, buf = [], ready = false;

  ws.addEventListener('message', async ({ data }) => {
    const raw = data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer();
    if (!ready) {
      ready = true;
      const b = new Uint8Array(raw);
      const uuid = [...b.slice(1,17)].map(x=>x.toString(16).padStart(2,'0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
      if (uuid !== userID) { ws.close(1003,'x'); return; }
      const opt = b[17], pi = 19+opt;
      const port = b[pi]*256+b[pi+1], atype = b[pi+2];
      let host='', al=0;
      if (atype===1){ host=b.slice(pi+3,pi+7).join('.'); al=4; }
      else if(atype===2){ al=b[pi+3]; host=new TextDecoder().decode(b.slice(pi+4,pi+4+al)); al++; }
      else if(atype===3){ al=16; const v=b.slice(pi+3,pi+19); host=Array.from({length:8},(_,i)=>((v[i*2]<<8|v[i*2+1]).toString(16))).join(':'); }
      const body = raw.slice(pi+3+al);
      socket = connect({ hostname: proxyIP, port });
      await socket.opened.catch(()=>{});
      ws.send(new Uint8Array([b[0],0]));
      const w = socket.writable.getWriter();
      if (body.byteLength) await w.write(new Uint8Array(body));
      for(const c of buf) await w.write(c);
      buf=[];
      w.releaseLock();
      socket.readable.pipeTo(new WritableStream({
        write: v => ws.readyState===1 && ws.send(v),
        close: () => ws.close(1000,'done'),
        abort: () => ws.close(1011,'err')
      })).catch(()=>ws.close(1011,'pipe'));
    } else {
      if(socket){ const w=socket.writable.getWriter(); await w.write(new Uint8Array(raw)); w.releaseLock(); }
      else buf.push(new Uint8Array(raw));
    }
  });
  ws.addEventListener('close',()=>socket?.close?.());
  ws.addEventListener('error',()=>socket?.close?.());
}
