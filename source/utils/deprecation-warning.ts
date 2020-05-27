const alreadyWarned: Set<string> = new Set();

export default (message: string) => {
	if (alreadyWarned.has(message)) {
		return;
	}

	alreadyWarned.add(message);

	// @ts-ignore Missing types.
	process.emitWarning(`Got: ${message}`, {
		type: 'DeprecationWarning'
	});
};
