import { useServerTime } from '~/components/sse-counter';

export default function Home() {
	const time = useServerTime();

	return (
		<main>
			<h1>{time()}</h1>
			<p>
				Visit{' '}
				<a href="https://start.solidjs.com" target="_blank">
					start.solidjs.com
				</a>{' '}
				to learn how to build SolidStart apps.
			</p>
		</main>
	);
}
