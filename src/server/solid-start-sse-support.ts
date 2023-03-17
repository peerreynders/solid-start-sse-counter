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
