# SolidStart SSE Demo 
Demonstration of a workaround for [SSE cleanup function never runs #654](https://github.com/solidjs/solid-start/issues/654)

Why [Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) (SSE)?
Because sometimes they are a much better fit than anything else (e.g. [Using Server Sent Events to Simplify Real-time Streaming at Scale](https://shopify.engineering/server-sent-events-data-streaming)).

---
```shell
$ cd solid-start-sse-counter
$ npm i

added 449 packages, and audited 450 packages in 3s

56 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
$ npm run dev

> solid-start-sse-counter@0.0.0 dev
> solid-start dev

 solid-start dev 
 version  0.2.23
 adapter  node

  VITE v4.2.0  ready in 537 ms

  ➜  Local:   http://localhost:3000/
  ➜  Network: use --host to expose
  ➜  Inspect: http:/localhost:3000/__inspect/
  ➜  press h to show help

  ➜  Page Routes:
     ┌─ http://localhost:3000/*404
     └─ http://localhost:3000/

  ➜  API Routes:
     None! 👻

  > Server modules: 
   http://localhost:3000/_m/*

GET http://localhost:3000/
GET http://localhost:3000/_m/src/components/sse-counter.tsx/0/handle
disconnect
```
---

Obstacles (on Node.js):
- Internally the SolidStart Server [copies](https://github.com/solidjs/solid-start/blob/25c7a1cbc7353f65591f6395a65c74fbcc71c1e4/packages/start/node/fetch.js#L140-L152) the [native](https://nodejs.org/api/http.html#class-httpincomingmessage) Node.js request to an undici [Request](https://github.com/nodejs/undici/blob/4e1e0d07d0261e2a7c951ca4544f0c41b75076c9/lib/fetch/request.js).
Consequently events like the request `close` event don't propagate to the copied request and while the (SolidStart) server can open an event stream, it has no idea when the client closes it.
- undici [never supported SSE in the first place](https://github.com/nodejs/undici/discussions/1352#discussioncomment-2611739).

TL;DR:
- In development configure Vite with middleware that tags all `text/event-stream` requests with an ID header and attaches a `close` handler that dispatches an event through a [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) to the SolidStart server (which runs on a separate thread).
Any subscribers to that ID are then notified that client closed the request.
- In production patch `dist/server.js` to include the same middleware in polka's middleware chain (no need for a `BroadcastChannel`).

## Vite configuration:

```TS
// file: vite.config.ts
import solid from "solid-start/vite";
import solidStartSsePlugin from './src/server/solid-start-sse-plugin';
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [
    solidStartSsePlugin(), 
    solid()
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
  }
}));
```

### The Plugin

* [Plugin API](https://vitejs.dev/guide/api-plugin.html)
* [Vite Specific Hooks: `configureServer`](https://vitejs.dev/guide/api-plugin.html#configureserver)
* [`ViteDevServer`](https://vitejs.dev/guide/api-javascript.html#vitedevserver)

```TS
// file: src/server/solid-start-sse-plugin
import { solidStartSseSupport } from './solid-start-sse-support';

import type { ViteDevServer } from 'vite';

export default function solidStartSsePlugin() {
  return {
    name: 'solid-start-sse-support',
    configureServer(server: ViteDevServer) {
      // Pre-internal middleware here:
      server.middlewares.use(solidStartSseSupport);

      // Post internal middleware should be registered
      // in a returned thunk, e.g.:
      // return () => {
      //   server.middlewares.use(middleware);
      // };
      return;
    },
  };
}
```

## Middleware and Event Handling

```TS
// file: src/server/solid-start-sse-support

function solidStartSseSupport(
  request: http.IncomingMessage,
  _response: http.ServerResponse,
  next: NextFunction
) {
  const accept = request.headers.accept;
  if (
    request.method !== 'GET' ||
    !accept ||
    0 > accept.indexOf('text/event-stream')
  )
    return next();

  // tag request with a unique header
  // which will get copied
  const id = nanoid();
  request.headers[SSE_CORRELATE] = id;

  // send event when request closes
  const close = () => {
    request.removeListener('close', close);
    sendEvent(id, REQUEST_CLOSE);
  };
  request.addListener('close', close);

  return next();
}
```

<details><summary>Full Listing</summary>

```TypeScript
// file: src/server/solid-start-sse-support
import { nanoid } from 'nanoid';

import type http from 'node:http';

// track closed requests

let lastPurge = performance.now();
const closedIds = new Map<string, number>();

function purgeClosedIds(now: number) {
  const cutOff = now - 120_000; // 2 minutes
  if (lastPurge > cutOff) return;

  for (const [id, time] of closedIds) if (time < cutOff) closedIds.delete(id);

  lastPurge = now;
}

function addClosedId(id: string) {
  const now = performance.now();
  purgeClosedIds(now);
  closedIds.set(id, now);
}

const REQUEST_CLOSE = {
  source: 'request',
  name: 'close',
} as const;

type Info = typeof REQUEST_CLOSE;
type Notify = (n: Info) => void;

const subscribers = new Map<string, Set<Notify>>();

function removeSubscriber(id: string, notify: Notify) {
  const all = subscribers.get(id);
  if (!all) return false;

  const result = all.delete(notify);
  if (all.size < 1) subscribers.delete(id);

  return result;
}

function addSubscriber(id: string, notify: Notify) {
  const remove = () => removeSubscriber(id, notify);
  const found = subscribers.get(id);
  if (found) {
    found.add(notify);
    return remove;
  }

  subscribers.set(id, new Set<Notify>().add(notify));
  return remove;
}

function notifySubscribers(id: string, info: Info) {
  const all = subscribers.get(id);
  if (!all) return;

  for (const notify of all) notify(info);

  if (info.name === 'close') {
    subscribers.delete(id);
    addClosedId(id);
  }
}

const SSE_CORRELATE = 'x-solid-start-sse-support';
const channel = process.env.NODE_ENV?.startsWith('dev')
  ? new BroadcastChannel('solid-start-sse-support')
  : undefined;

type EventInfo = {
  id: string;
  info: Info;
};
let receive: (event: MessageEvent<EventInfo>) => void | undefined;
let listening = false;

// Start listening as soon as possible
function listen() {
  if (channel && !receive) {
    receive = (event: MessageEvent<EventInfo>) =>
      notifySubscribers(event.data.id, event.data.info);

    channel.addEventListener('message', receive);
  }
  listening = true;
}

function subscribe(request: Request, notify: Notify) {
  if (!listening)
    throw Error(
      'Call `listen()` at application start up to avoid missing events'
    );

  const id = request.headers.get(SSE_CORRELATE);
  if (!id) return;
  if (closedIds.has(id)) return;

  return addSubscriber(id, notify);
}

export type EventStreamInit<T> = (
  send: (event: string, data: T) => void
) => () => void;

function eventStream<T>(request: Request, init: EventStreamInit<T>) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: T) => {
        controller.enqueue(encoder.encode('event: ' + event + '\n'));
        controller.enqueue(encoder.encode('data: ' + data + '\n\n'));
      };
      let unsubscribe: (() => boolean) | undefined = undefined;

      let cleanup: (() => void) | undefined = init(send);
      const close = () => {
        if (!cleanup) return;
        cleanup();
        cleanup = undefined;
        unsubscribe?.();
        controller.close();
      };

      unsubscribe = subscribe(request, (info) => {
        if (info.source === 'request' && info.name === 'close') {
          close();
          return;
        }
      });

      if (!unsubscribe) {
        close();
        return;
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

// --- Middleware ---

function sendEvent(id: string, info: Info) {
  if (!channel) {
    notifySubscribers(id, info);
    return;
  }

  channel.postMessage({
    id,
    info,
  });
}

type NextFunction = (err?: unknown) => void;

function solidStartSseSupport(
  request: http.IncomingMessage,
  _response: http.ServerResponse,
  next: NextFunction
) {
  const accept = request.headers.accept;
  if (
    request.method !== 'GET' ||
    !accept ||
    0 > accept.indexOf('text/event-stream')
  )
    return next();

  // tag request with a unique header
  // which will get copied
  const id = nanoid();
  request.headers[SSE_CORRELATE] = id;

  // send event when request closes
  const close = () => {
    request.removeListener('close', close);
    sendEvent(id, REQUEST_CLOSE);
  };
  request.addListener('close', close);

  return next();
}

// Want to protect middleware from tree shaking
declare global {
  var __no_tree_shaking: Record<string, unknown> | undefined;
}

if (globalThis.__no_tree_shaking) {
  globalThis.__no_tree_shaking.solidStartSseSupport = solidStartSseSupport;
} else {
  globalThis.__no_tree_shaking = { solidStartSseSupport };
}

export { eventStream, listen, solidStartSseSupport };
```

</details>

### Example use

In [`src/components/sse-counter.tsx`](src/components/sse-counter.tsx):

```TypeScript
// file: src/components/sse-counter.tsx
import {
  createContext,
  createEffect,
  useContext,
  createSignal,
  onCleanup,
  type ParentProps,
} from 'solid-js';
import server$, { ServerFunctionEvent } from 'solid-start/server';
import { formatTime } from '~/helpers';

// --- START server side ---

import { eventStream } from '~/server/solid-start-sse-support';
// NOTE: call `listen()` in `entry-server.tsx`

async function connectServerSource(this: ServerFunctionEvent) {
  const init = (send: (event: string, data: string) => void) => {
    const interval = setInterval(() => {
      send('message', formatTime(new Date()));
    }, 1000);

    return () => {
      console.log('disconnect');
      clearInterval(interval);
    };
  };

  return eventStream(this.request, init);
}

// --- END server side ---

const [serverTime, setServerTime] = createSignal(formatTime(new Date()));

const ServerTimeContext = createContext(serverTime);

let started = false;

function startServerTime() {
  if (started) return;

  const handle = server$(connectServerSource);
  const href = handle.url;

  // Runs only once but also registers for clean up
  createEffect(() => {
    const onMessage = (message: MessageEvent<string>) => {
      setServerTime(message.data);
    };
    const eventSource = new EventSource(href);
    eventSource.addEventListener('message', onMessage);

    onCleanup(() => {
      eventSource.removeEventListener('message', onMessage);
      eventSource.close();
    });
  });

  started = true;
}

function ServerTimeProvider(props: ParentProps) {
  startServerTime();

  return (
    <ServerTimeContext.Provider value={serverTime}>
      {props.children}
    </ServerTimeContext.Provider>
  );
}

const useServerTime = () => useContext(ServerTimeContext);

export { ServerTimeProvider, useServerTime };
```

## Production patch

Just a `postbuild` script in the `package.json`:

```JSON
  "scripts": {
    …
    "postbuild": "sed -i 's/assets_handler).use(comp/assets_handler).use(solidStartSseSupport).use(comp/g' dist/server.js",
    …
  },
 ```
