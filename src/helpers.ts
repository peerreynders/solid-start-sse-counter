const time = Intl.DateTimeFormat('en', {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
});

function formatTime(date: Date) {
	return time.format(date);
}

export { formatTime };
