# SolidStart SSE Demo 
Demonstration of a workaround for [SSE cleanup function never runs #654](https://github.com/solidjs/solid-start/issues/654)

Why [Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) (SSE)?
Because sometimes they are a much better fit than anything else (e.g. [Using Server Sent Events to Simplify Real-time Streaming at Scale](https://shopify.engineering/server-sent-events-data-streaming)).

Obstacles (on Node.js):
- Internally the SolidStart Server [copies](https://github.com/solidjs/solid-start/blob/25c7a1cbc7353f65591f6395a65c74fbcc71c1e4/packages/start/node/fetch.js#L140-L152) the [native](https://nodejs.org/api/http.html#class-httpincomingmessage) Node.js request to an undici [Request](https://github.com/nodejs/undici/blob/4e1e0d07d0261e2a7c951ca4544f0c41b75076c9/lib/fetch/request.js).
Consequently events like the request `close` event don't propagate to the copied request and while the (SolidStart) server can open an event stream, it has no idea when the client closes it.
- undici [never supported SSE in the first place](https://github.com/nodejs/undici/discussions/1352#discussioncomment-2611739).
