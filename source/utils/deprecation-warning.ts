const alreadyWarned: Set<string> = new Set();

export default (message: string) => {
	if (alreadyWarned.has(message)) {
		return;
	}

	alreadyWarned.add(message);

	// @ts-expect-error Missing types.
	process.emitWarning(`Got: ${message}`, {
		type: 'DeprecationWarning'
	});
};
