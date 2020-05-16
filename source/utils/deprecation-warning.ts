const alreadyWarned: string[] = [];

export default (message: string) => {
	if (alreadyWarned.includes(message)) {
		return;
	}

	alreadyWarned.push(message);

	// @ts-ignore Missing types.
	process.emitWarning(`Got: ${message}`, {
		type: 'DeprecationWarning'
	});
};
