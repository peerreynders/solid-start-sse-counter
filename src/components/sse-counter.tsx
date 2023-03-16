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
	const href: string = handle.url;
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
