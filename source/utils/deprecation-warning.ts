const alreadyWarned: string[] = [];

export default (message: string) => {
	if (alreadyWarned.includes(message)) {
		return;
	}

	alreadyWarned.push(message);

	// @ts-ignore
	process.emitWarning(message, {
		type: 'DeprecationWarning'
	});
};
